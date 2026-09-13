/**
 * `revoke` — the kill switch. The guardian alone rotates the agent key out of the float
 * account's key list, leaving the guardian as the sole key.
 *
 * One guardian signature meets the 1-of-2 threshold AND is the new key, so no agent
 * signature is needed and the agent cannot refuse. The next payment the evicted key signs
 * is submitted by the facilitator and fails on chain with `INVALID_SIGNATURE`; that is leg
 * 5 of the demo, and it is a real on-ledger refusal rather than a server saying no.
 */
import { AccountUpdateTransaction } from "@hiero-ledger/sdk";
import { AccountId } from "@x402/hedera";
import { type MirrorAccount, describeKey, hashscan, mirror, requireEnv } from "../mirror.js";
import { guardian } from "./provision.js";

/**
 * Runs the revoke command.
 *
 * @returns Nothing; prints the receipt status, the HashScan link and the resulting key
 */
export async function revoke() {
  const agentId = AccountId.fromString(requireEnv("AGENT_ACCOUNT_ID"));
  const g = guardian();
  try {
    const before = await mirror<MirrorAccount>(`/accounts/${agentId}`);
    console.log(`before: key ${describeKey(before)}`);

    const tx = new AccountUpdateTransaction()
      .setAccountId(agentId)
      .setKey(g.key.publicKey)
      .freezeWith(g.client);
    const rx = await tx.execute(g.client);
    const status = (await rx.getReceipt(g.client)).status.toString();
    console.log(
      `rotate agent key out (guardian only): ${status} ${hashscan(rx.transactionId.toString())}`,
    );

    await new Promise((r) => setTimeout(r, 4000));
    const after = await mirror<MirrorAccount>(`/accounts/${agentId}`);
    console.log(`after: key ${describeKey(after)}`);
  } finally {
    g.client.close();
  }
}
