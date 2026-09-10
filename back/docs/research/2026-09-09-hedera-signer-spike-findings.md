# Hedera signer spike findings — raw-digest signing, hollow accounts, the 1-of-2 leash

> **Status:** ✅ Every step passed on Hedera testnet on 2026-09-09. A secp256k1 signer that only ever sees
> a 32-byte digest produces Hedera signatures byte-identical to the SDK's. A hollow account created by a
> USDC transfer paid an x402 request through Blocky402 with zero HBAR, and the network completed the
> account inside that same settlement. A 1-of-2 key list of guardian and agent accepts agent payments,
> and the guardian alone can rotate the agent key out; the next attempt fails with `INVALID_SIGNATURE`.
> **What this settles:** the signing mechanics for every custody shape (A1 Turnkey delegate, A2 Novi-held
> KMS, B customer self-custody). **What it does not settle:** who holds the key. That is the team decision
> in the idea brief.
> **Spike code:** standalone, outside the monorepo, at `~/Desktop/Solidity_Project_Files/arc-Circle/hedera-signer-spike/`
> (Alex's machine). Secrets come from 1Password via `op run`; no key was ever written to disk or printed.
> **Packages:** `@x402/hedera@2.25.0`, `@x402/core@2.25.0`, `@x402/fetch@2.25.0`, `@x402/express@2.25.0`,
> `@hiero-ledger/sdk@2.85.0` (pinned by `@x402/hedera`), `@noble/curves@1.8.1`, `@noble/hashes@1.7.1`.

## Accounts and ids used

| Role | Id | Note |
|---|---|---|
| Treasury and guardian | `0.0.10412145` | Portal-created ECDSA account. Associated with USDC by `TokenAssociateTransaction`, funded 20 USDC from faucet.circle.com |
| Agent | `0.0.10450558` | Created as a hollow account by sending 1 USDC to the EVM alias of a locally generated ECDSA key |
| Facilitator | Blocky402 testnet, `https://api.testnet.blocky402.com`, fee payer `0.0.7162784` | `GET /supported` lists `hedera:testnet`, x402 v2, scheme `exact` |
| USDC | `0.0.429274` | Testnet HTS token, 6 decimals |

## Step results

| Step | Claim under test | Result | Evidence |
|---|---|---|---|
| 0 | A raw-digest signer via `transaction.signWith` matches `transaction.sign(PrivateKey)` | ✅ | Offline: 64-byte signatures byte-identical, `PublicKey.verifyTransaction` true, survives base64 round trip |
| 1 | Treasury can associate USDC and receive faucet funds | ✅ | `TOKENASSOCIATE` SUCCESS at consensus `1788899300.205829104`; 20 USDC credited at `1788905281.587403104` |
| 2 | USDC to an EVM alias creates a hollow account with USDC auto-associated (HIP-542, HIP-583) | ✅ | Mirror node: `key: null`, `max_automatic_token_associations: -1`, USDC balance 1000000 with `automatic_association: true` |
| 3a | A hollow account can pay through x402 before any completion transaction | ✅ | HTTP 200, settlement `0.0.7162784@1788998489.006924053`. The record carries two transactions: `CRYPTOUPDATEACCOUNT` SUCCESS (network-issued completion, fee 0) and `CRYPTOTRANSFER` SUCCESS (0.001 USDC agent to treasury, facilitator paid 0.0145 HBAR) |
| 3b | Agent account never needs HBAR | ✅ | Agent HBAR balance 0 throughout; both settlements paid by the facilitator |
| 4a | Agent account key can become a 1-of-2 `KeyList(guardian, agent)` | ✅ | `AccountUpdateTransaction` SUCCESS at `1788998558.117363831`; mirror node key type `ProtobufEncoded` |
| 3c | Agent still pays under the key list | ✅ | HTTP 200, settlement `0.0.7162784@1788998595.219812918` |
| 4b | Guardian alone can rotate the agent key out | ✅ | `AccountUpdateTransaction` signed by guardian only, SUCCESS at `1788998613.022134847`; key type back to `ECDSA_SECP256K1` (guardian's) |
| 3d | Evicted agent key can no longer pay | ✅ (refused) | HTTP 402, `PAYMENT-RESPONSE` `transaction_failed`; on chain `CRYPTOTRANSFER INVALID_SIGNATURE` at `1788998650.137740104`. Agent USDC 998000 = two payments, not three |

Every transaction is on HashScan testnet under the timestamps above.

## Findings

### 1. The custody boundary is one function: 32 bytes in, 64 bytes out

The Hiero SDK's ECDSA path is `keccak256(bodyBytes)` then a compact `r‖s` secp256k1 signature
(`@hiero-ledger/cryptography/src/primitive/ecdsa.js`, read in source). `transaction.signWith(publicKey, fn)`
hands `fn` the body bytes; hashing can happen on our side and the key holder only ever signs the digest.
That is the interface a cloud KMS, Turnkey's raw-payload mode, or a customer's own runtime exposes.
The spike's `custodyAgnosticSigner` copies `@x402/hedera`'s transfer construction line for line and swaps
`tx.sign(privateKey)` for `tx.signWith(pub, bytes => rawSign(keccak_256(bytes)))`. Nothing else changes.

Consequence for the design: `ClientHederaSigner` is two members, `accountId` and
`createPartiallySignedTransferTransaction`. Novi implements it once, with `rawSign` injected. A1, A2 and B
differ only in what `rawSign` calls.

### 2. Provisioning is one guardian-signed USDC transfer and nothing else

Sending USDC to the agent key's EVM address created the account, associated USDC to it, and set
`max_automatic_token_associations` to `-1` (unlimited). No HBAR was ever sent to the agent. The network
completed the hollow account as a side effect of its first signed transaction, and because the x402 Hedera
scheme makes the facilitator the transaction fee payer, that first transaction was the payment itself.
The idea brief assumed a separate self-paid completion step; it is not needed.

### 3. The on-chain leash works exactly as sketched

A native 1-of-2 `KeyList` on the agent account lets the agent pay alone and lets the guardian, alone,
replace the key. After rotation the agent's partially signed transfer fails at the network with
`INVALID_SIGNATURE`; Blocky402 submitted it and reported `transaction_failed` rather than rejecting at
verify time. Float size is the cap, rotation is the kill switch, and neither requires a contract on Hedera.

### 4. Things worth knowing before T4 lands this in the monorepo

- `@x402/hedera@2.25` pins `@x402/core ~2.25`; the backend runs `@x402/evm ^2.15`. The bump against
  the Arc codec is the first risk to test, before any Hedera code.
- `@x402/hedera` re-exports `AccountId`, `Client`, `PrivateKey`, `TransferTransaction`,
  `TokenAssociateTransaction`, `TokenId`, `Transaction`, `TransactionId`, `Hbar`, `PublicKey`. It does not
  re-export `AccountUpdateTransaction` or `KeyList`; import those from `@hiero-ledger/sdk`. Do not install
  `@hashgraph/sdk` beside it.
- The Circle faucet only credits accounts already associated with USDC; the Hedera portal does not
  associate tokens. Association is a required first step for any treasury account.
- Blocky402's facilitator default `aliasPolicy` is `reject`; that concerns `payTo`, so sellers must be
  completed accounts. Payers may be hollow.
- The seller side used `@x402/express` `paymentMiddleware` with a route priced as
  `{ amount: "1000", asset: "0.0.429274" }` on `hedera:testnet`. First paid request round-tripped in about
  4.3 seconds including verify and settle.

## Open items

- Whether Hedera native allowances (`AccountAllowanceApproveTransaction`) can replace the float account
  under the x402 scheme. Untested; float account first.
- Turnkey raw-payload signing against a live Hedera transfer. The mechanics are proven with a local
  key; the Turnkey adapter is a `rawSign` implementation and a metering bill, not a research question.
- Latency and reliability of Blocky402 testnet over more than four requests.

## Reproduction

From the spike folder, with the 1Password items `Hedera Testnet Treasury` and `Hedera Spike Agent Key` in
vault `Novi Corpus`:

```bash
npx tsx src/00-signwith-proof.ts                                   # offline, no secrets
op run --env-file=.env.tpl -- npx tsx src/01-associate.ts
op run --env-file=.env.tpl -- npx tsx src/02-hollow-account.ts
op run --env-file=.env.tpl -- npx tsx src/03-pay.ts pre-completion
op run --env-file=.env.tpl -- npx tsx src/04-keylist.ts list
op run --env-file=.env.tpl -- npx tsx src/03-pay.ts under-1of2-list
op run --env-file=.env.tpl -- npx tsx src/04-keylist.ts rotate
op run --env-file=.env.tpl -- npx tsx src/03-pay.ts after-rotation  # expect 402
```

Written with Claude Code (ETHGlobal AI-attribution note); every result above was executed, not reasoned.
