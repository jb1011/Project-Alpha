/**
 * `provision` — create the customer's float account and put the guardian's leash on it.
 *
 * The order matters and is the one thing this command exists to prove. A single
 * guardian-signed USDC transfer to the agent key's EVM address creates the account with
 * USDC associated and unlimited auto-associations; the key list then goes on while the
 * account is still hollow, with no payment in between. The spike paid first, so this order
 * is the new claim: if the network refuses the update on a hollow account, the command
 * falls back to one agent-signed dust transfer to complete the account and retries, and
 * says which order worked.
 *
 * Nothing here sends a key anywhere. The agent key stays in this process; only its public
 * key and account id ever reach Novi Corpus, through `link`.
 */
import { execFileSync } from "node:child_process";
import {
  AccountUpdateTransaction,
  KeyList,
  PrecheckStatusError,
  ReceiptStatusError,
} from "@hiero-ledger/sdk";
import { AccountId, Client, PrivateKey, TokenId, TransferTransaction } from "@x402/hedera";
import {
  type MirrorAccount,
  describeKey,
  hashscan,
  mirror,
  requireEnv,
  waitMirror,
} from "../mirror.js";

/** 1 USDC, atomic (6 decimals): the float the guardian funds the account with. */
const FLOAT_ATOMIC = 1_000_000;
/** 0.001 USDC, atomic: the dust the fallback moves to complete a hollow account. */
const DUST_ATOMIC = 1_000;
/** The 1Password item that holds the agent key. Vault "Novi Corpus". */
const AGENT_ITEM = "Hedera Spike Agent Key";

/** The USDC token this rail pays in. */
export const usdc = () => TokenId.fromString(process.env.USDC_TOKEN_ID ?? "0.0.429274");

/**
 * The guardian: the account that funds the float, co-signs the key list, and can rotate
 * the agent key out. It pays every fee here, so the agent account never needs HBAR.
 *
 * @returns The guardian's account id, key and an operator-bound testnet client
 */
export function guardian() {
  const id = AccountId.fromString(requireEnv("TREASURY_ACCOUNT_ID"));
  const key = PrivateKey.fromStringECDSA(requireEnv("TREASURY_PRIVATE_KEY"));
  return { id, key, client: Client.forTestnet().setOperator(id, key) };
}

/**
 * Writes fields into a 1Password item. Values pass through argv and are never printed;
 * stdout is discarded so a field value cannot land in a log. Testnet only.
 *
 * @param title - The item's title in the "Novi Corpus" vault
 * @param fields - Field assignments, `name[type]=value`
 */
function opEdit(title: string, fields: Record<string, string>) {
  const args = [
    "item",
    "edit",
    title,
    "--vault",
    "Novi Corpus",
    ...Object.entries(fields).map(([k, v]) => `${k}=${v}`),
  ];
  execFileSync("op", args, { stdio: ["ignore", "ignore", "inherit"] });
}

/** The part of a `TransactionResponse` this module reads. Structural, so a test can fake it. */
type Submittable = {
  transactionId: { toString(): string };
  getReceipt(client: Client): Promise<{ status: { toString(): string } }>;
};

/**
 * Runs a transaction and returns its status as a string instead of throwing on failure.
 *
 * The SDK reports a failed transaction by THROWING, not by handing back a status:
 * `getReceipt` raises `ReceiptStatusError` for any consensus status that is not SUCCESS
 * (`lib/transaction/TransactionResponse.cjs:104`), and a node-side refusal raises
 * `PrecheckStatusError` out of `execute` itself. A caller that reads `receipt.status` and
 * compares it to "SUCCESS" therefore has a branch it can never reach. `provision`'s dust
 * fallback was exactly that branch, which is why this helper exists.
 *
 * @param send - Submits the transaction and resolves to its response
 * @param client - The client whose receipt query is used
 * @returns The status as the network spelled it, and the transaction id when there is one
 */
export async function submit(
  send: () => Promise<Submittable>,
  client: Client,
): Promise<{ status: string; txId: string }> {
  let rx: Submittable;
  try {
    rx = await send();
  } catch (e) {
    // A precheck refusal never reached consensus, so there is no transaction to link to.
    if (e instanceof PrecheckStatusError) return { status: e.status.toString(), txId: "" };
    throw e;
  }
  try {
    const status = (await rx.getReceipt(client)).status.toString();
    return { status, txId: rx.transactionId.toString() };
  } catch (e) {
    if (e instanceof ReceiptStatusError)
      return { status: e.status.toString(), txId: rx.transactionId.toString() };
    throw e;
  }
}

/**
 * Sets the account memo to the HCS-11 profile reference, when one is configured.
 *
 * After the key list is on, the guardian alone meets the 1-of-2 threshold, so this is a
 * guardian-signed update and the agent never has to be online for it.
 *
 * @param accountId - The float account
 * @returns Nothing; prints what it did
 */
async function setMemo(accountId: AccountId) {
  const profileUrl = process.env.NOVI_PROFILE_URL;
  if (!profileUrl) {
    console.log("memo: NOVI_PROFILE_URL not set, skipped");
    return;
  }
  const g = guardian();
  try {
    const tx = await new AccountUpdateTransaction()
      .setAccountId(accountId)
      .setAccountMemo(`hcs-11:${profileUrl}`)
      .execute(g.client);
    // Not through `submit`: there is no fallback for a failed memo, so the SDK's throw is
    // the right outcome. Anything printed here is therefore always SUCCESS.
    const status = (await tx.getReceipt(g.client)).status.toString();
    console.log(`memo hcs-11:${profileUrl}: ${status} ${hashscan(tx.transactionId.toString())}`);
  } finally {
    g.client.close();
  }
}

/**
 * Puts the 1-of-2 `KeyList(guardian, agent)` on the float account.
 *
 * The account's current key must approve the change, and the guardian (the operator) signs
 * too, which satisfies the new list. On a hollow account there is no current key yet, which
 * is exactly the case this command is testing.
 *
 * @param g - The guardian's client bundle
 * @param agentKey - The agent's private key, held locally
 * @param accountId - The float account
 * @returns The receipt status and the transaction id
 */
async function setKeyList(
  g: ReturnType<typeof guardian>,
  agentKey: PrivateKey,
  accountId: AccountId,
): Promise<{ status: string; txId: string }> {
  const list = new KeyList([g.key.publicKey, agentKey.publicKey], 1);
  const tx = new AccountUpdateTransaction()
    .setAccountId(accountId)
    .setKey(list)
    .freezeWith(g.client);
  await tx.sign(agentKey);
  return submit(() => tx.execute(g.client), g.client);
}

/**
 * One agent-signed dust transfer, the fallback that completes a hollow account.
 *
 * Hedera refuses a transfer list that names the same account twice, so the dust goes back
 * to the guardian rather than to the agent itself; what completes the account is that the
 * agent's key signed, not where the 0.001 USDC landed. The guardian is the fee payer, so
 * the agent still never needs HBAR.
 *
 * @param g - The guardian's client bundle
 * @param agentKey - The agent's private key
 * @param accountId - The float account
 * @returns The receipt status and the transaction id
 */
async function completeWithDust(
  g: ReturnType<typeof guardian>,
  agentKey: PrivateKey,
  accountId: AccountId,
): Promise<{ status: string; txId: string }> {
  const tx = new TransferTransaction()
    .addTokenTransfer(usdc(), accountId, -DUST_ATOMIC)
    .addTokenTransfer(usdc(), g.id, DUST_ATOMIC)
    .setTransactionMemo("novi: complete float account")
    .freezeWith(g.client);
  await tx.sign(agentKey);
  return submit(() => tx.execute(g.client), g.client);
}

/**
 * Runs the provision command.
 *
 * @param argv - Command arguments; `--memo-only` re-sets the memo on `AGENT_ACCOUNT_ID`
 * @returns Nothing; prints the account, the public key and the `link_hedera_account` call
 */
export async function provision(argv: string[]) {
  const memoOnly = argv.includes("--memo-only");

  if (memoOnly) {
    const accountId = AccountId.fromString(requireEnv("AGENT_ACCOUNT_ID"));
    await setMemo(accountId);
    const acct = await mirror<MirrorAccount>(`/accounts/${accountId}`);
    console.log(`account ${accountId.toString()} key ${describeKey(acct)}`);
    return;
  }

  // 1. The agent key. Generated here or reused from 1Password; either way it stays local.
  let agentHex = process.env.AGENT_PRIVATE_KEY ?? "";
  if (agentHex) {
    console.log("agent key already in 1Password, reusing");
  } else {
    const k = PrivateKey.generateECDSA();
    agentHex = k.toStringRaw();
    opEdit(AGENT_ITEM, {
      "private_key_hex[password]": agentHex,
      "public_key_hex[text]": k.publicKey.toStringRaw(),
      "evm_address[text]": `0x${k.publicKey.toEvmAddress()}`,
    });
    console.log("agent key generated and stored in 1Password");
  }
  const agentKey = PrivateKey.fromStringECDSA(agentHex);
  const evm = agentKey.publicKey.toEvmAddress();

  const g = guardian();
  try {
    // 2. One guardian-signed USDC transfer to the EVM alias creates the account, with USDC
    //    associated and unlimited auto-associations (HIP-542, HIP-583). No HBAR is sent.
    const existing = await mirror<MirrorAccount>(`/accounts/0x${evm}`);
    if (existing) {
      console.log(`account already exists: ${existing.account} key ${describeKey(existing)}`);
    } else {
      const alias = AccountId.fromEvmAddress(0, 0, evm);
      const rx = await new TransferTransaction()
        .addTokenTransfer(usdc(), g.id, -FLOAT_ATOMIC)
        .addTokenTransfer(usdc(), alias, FLOAT_ATOMIC)
        .setTransactionMemo("novi: fund float account")
        .execute(g.client);
      // Not through `submit` either: provision must not continue past a funding that did
      // not land, so a non-SUCCESS status throws out of the command with the SDK's message.
      const status = (await rx.getReceipt(g.client)).status.toString();
      console.log(`fund alias with 1 USDC: ${status} ${hashscan(rx.transactionId.toString())}`);
    }

    // 3. Wait for the mirror node to show it.
    const acct = await waitMirror<MirrorAccount>(`/accounts/0x${evm}`);
    if (!acct) throw new Error("float account not visible on the mirror node after 30s");
    const accountId = AccountId.fromString(acct.account);
    opEdit(AGENT_ITEM, { "account_id[text]": acct.account });

    // 4. The key list, on the still-hollow account, with no payment in between.
    let result = await setKeyList(g, agentKey, accountId);
    let order = "key list on a hollow account";
    if (result.status !== "SUCCESS") {
      console.log(`key list on a hollow account: ${result.status}, falling back`);
      const dust = await completeWithDust(g, agentKey, accountId);
      console.log(`complete with 0.001 USDC: ${dust.status} ${hashscan(dust.txId)}`);
      if (dust.status !== "SUCCESS")
        throw new Error(`could not complete the account: ${dust.status}`);
      result = await setKeyList(g, agentKey, accountId);
      order = "dust first, then the key list";
    }
    if (result.status !== "SUCCESS")
      throw new Error(`key list refused after completion: ${result.status}`);
    console.log(`set 1-of-2 key list: ${result.status} ${hashscan(result.txId)}`);
    console.log(`order that worked: ${order}`);

    // 5. The HCS-11 memo, when a profile URL is configured (task 12).
    await setMemo(accountId);

    // 6. What the customer needs next: the public key, the account, and the link call.
    const publicKey = agentKey.publicKey.toStringRaw();
    const after = await mirror<MirrorAccount>(`/accounts/${accountId}`);
    console.log(`publicKey ${publicKey}`);
    console.log(`account ${accountId.toString()} key ${describeKey(after)}`);
    console.log(
      `link_hedera_account ${JSON.stringify({
        id: process.env.NOVI_ENTITY_ID ?? "<NOVI_ENTITY_ID>",
        accountId: accountId.toString(),
        publicKey,
      })}`,
    );
  } finally {
    g.client.close();
  }
}
