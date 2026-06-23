# Phase 0 spike findings — x402 + Circle Gateway on Arc testnet

> **Status:** ✅ Phase-0 GATE CLEARED. Tasks 0.1, 0.2, 0.2b, 0.3 all verified on Arc testnet. Real settlement
> proven (mint tx `0xbce3463db186fd555686dda645af433d25b10842e6cbd545aa5fa75bf9b8c992`), and non-custodial
> Circle-batching signing proven via `BatchEvmScheme` + the Turnkey signer (Task 0.2b). Phase 1 (Payment
> Authority) is unblocked; Phase 2 lifts the `BatchEvmSigner` adapter into `backend/src/adapters/x402/`.
> **Spike script:** [`backend/scripts/spike-x402-gateway.mts`](../../backend/scripts/spike-x402-gateway.mts) (exploratory; deletable once Phase 2 lands the real adapter).
> **Packages:** `x402@1.2.0`, `x402-fetch`, `@circle-fin/x402-batching`. **Operator:** Turnkey enclave key `0x46DE6c6cb2A9cc9d5517245c92e8Db6053F44BF0` (the live agentId-656785 key). **Chain:** Arc testnet, chainId 5042002, USDC `0x3600…0000`.

## Task 0.1 — package surface (verified)
- **`x402-fetch`** (buyer side): exports `wrapFetchWithPayment`, `createSigner`, `decodeXPaymentResponse`.
- **`x402` core** uses **subpath exports only** (no bare import): `x402/types`, `x402/schemes`,
  `x402/client`, `x402/verify`, `x402/facilitator`, `x402/shared`, `x402/shared/evm`, `x402/paywall`.
- **`@circle-fin/x402-batching@3.1.2`** — ⚠️ the bare `.` export is only scheme constants + helpers
  (`CIRCLE_BATCHING_SCHEME/NAME/VERSION`, `getVerifyingContract`, `GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS`,
  `supportsBatching`, `isBatchPayment`). **The real machinery is in the subpaths** (Task 0.1's "no
  GatewayClient" finding was wrong — I'd only checked the bare export):
  - **`@circle-fin/x402-batching/client`** exports **`GatewayClient`** (the full buyer flow:
    `deposit`/`pay`/`withdraw`/`getBalances`), plus `BatchEvmScheme`, `CompositeEvmScheme`,
    `registerBatchScheme`, **`GATEWAY_DOMAINS`** (`arcTestnet: 26`, `arc: 26`), and **`CHAIN_CONFIGS`**
    (per-chain `usdc`/`gatewayWallet`/`gatewayMinter`/`domain`/`chain`/`rpcUrl`).
  - **`@circle-fin/x402-batching/server`** needs a `@x402/evm` peer that is **not installed** — server side
    is out of scope for the buyer/settlement path.

## Task 0.2 — non-custodial x402 signing (verified ✅)
**Goal:** prove our Turnkey-backed `OperatorSigner` can produce a valid x402 "exact"/EIP-3009 authorization
that recovers to the operator. **Result: PASS** — signature recovers to `0x46DE…BF0` via viem
`verifyTypedData`. Key never left the enclave.

### Finding 1 — x402's EVM signer type is structurally satisfied by our Turnkey account
```ts
// x402 internal (dist): the whole EVM signing path reduces to account.signTypedData(typedData)
type EvmSigner = SignerWallet<Chain, Transport, Account> | LocalAccount;
```
`@turnkey/viem`'s `createAccount(...)` returns a viem **`LocalAccount`**, so it satisfies `EvmSigner`
directly. No private key on the app server; no adapter shim needed at the type level.

### Finding 2 — x402 fully supports Arc via Circle's batching scheme (corrected 2026-06-17)
⚠️ Earlier this was written as "Arc is NOT in x402's network registry." That was the wrong layer. The
**generic Coinbase `x402@1.2.0` package** has a hardcoded `EvmNetworkToChainId` map that omits Arc (5042002),
so *its* high-level helpers throw at `getNetworkId("arc-testnet")` — but **we don't use that path.**
**Circle's `@circle-fin/x402-batching` is x402 on Arc:** `chain: "arcTestnet"` is a first-class documented
option, and the batching scheme registers on the `"eip155:*"` wildcard (every EVM chain incl. Arc) rather
than a fixed list. Circle's nanopayments docs (concepts/x402, howtos/x402-{integration,buyer,seller},
eip-3009-signing, facilitator-integration) demonstrate the whole flow on Arc testnet. **So Arc support is NOT
a gap.** The `signX402()` seam still exists — but for *governance* (routing signing through Turnkey), not to
work around a missing chain.

⚠️ **Domain correction:** the Circle batching scheme signs EIP-3009 against the **GatewayWallet contract**
(`extra.verifyingContract` / `getVerifyingContract`) with EIP-712 domain name **`"GatewayWalletBatched"`** —
NOT the USDC token domain (`"USDC"`/`"2"`) that Task 0.2's spike used. Same signing mechanism, different
domain + verifyingContract. The Task 0.2 spike proved the *generic* x402/EIP-3009 path; the batching path
uses this domain. Both sign through the same `OperatorSigner`.

### Finding 3 — the exact typed-data shape (reuse verbatim in Phase 1)
Imported live from `x402/types` → `evm.authorizationTypes`:
```ts
import { evm } from "x402/types";

const typedData = {
  types: {
    // ⚠️ EIP712Domain MUST be declared explicitly (see Finding 4)
    EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ],
    ...evm.authorizationTypes, // { TransferWithAuthorization: [from,to,value,validAfter,validBefore,nonce] }
  },
  domain: { name, version, chainId: 5042002, verifyingContract: usdcAddress },
  primaryType: "TransferWithAuthorization",
  message: { from, to, value, validAfter, validBefore, nonce /* bytes32, 32 random bytes */ },
};
// USDC domain on Arc read on-chain via name()+version(): name="USDC", version="2".
// x402 nonce = toHex(crypto.getRandomValues(32)); validBefore = now + maxTimeoutSeconds; validAfter = now-600.
```

### Finding 4 — ⚠️ EIP712Domain must be declared explicitly for the Turnkey path
viem's local accounts auto-derive the `EIP712Domain` type from the `domain` object; **`@turnkey/viem`
does not** — omit it and Turnkey hashes a *different* digest, so the signature recovers to a wrong
(deterministic) address and verification fails. Declaring `EIP712Domain` in `types` fixes it. Same root
cause as commit `a45d96e` ("declare EIP712Domain in AgentWalletSet typed data"). **Any `signX402()` impl
that signs through the Turnkey `OperatorSigner` must declare EIP712Domain.**

### Task 0.2b — Circle batching authorization via `BatchEvmScheme` + Turnkey (verified ✅, added 2026-06-17)
The authoritative, production-path proof. Instead of hand-building typed data, we pass our Turnkey
`OperatorSigner` (wrapped as a `BatchEvmSigner` = `{ address, signTypedData }`) into **Circle's own
`BatchEvmScheme`** and call `createPaymentPayload(1, requirements)` with a Circle-batching `PaymentRequirements`
(`network: "eip155:5042002"`, `extra: { name: "GatewayWalletBatched", version: "1", verifyingContract:
<GatewayWallet> }`). Circle's scheme builds the real `"GatewayWalletBatched"` typed data (domain
verifyingContract = GatewayWallet `0x0077…19B9`, **not** USDC) and calls our enclave signer; the returned
`{ authorization, signature }` recovers to operator `0x46DE…BF0`. **Result: PASS.**

Two things this nails down: (1) the **real batching domain** signs correctly via Turnkey (Task 0.2 used the
generic USDC domain; this uses Circle's actual one); (2) the **adapter must inject `EIP712Domain`** —
`BatchEvmScheme.signAuthorization` passes only `authorizationTypes` to the signer (it relies on viem
auto-derivation, which the Turnkey path lacks). The `BatchEvmSigner` adapter that wraps `OperatorSigner` is
therefore the concrete non-custodial seam; Phase 2 lifts it out of the spike into `backend/src/adapters/x402/`.

## The `signX402()` seam Phase 1 depends on (contract)
```ts
// concrete impl lives in backend/src/adapters/x402/ (Phase 2, from these findings)
export interface PaymentRequirements { payTo: Address; amount: bigint; asset: Address; network: string; maxTimeoutSeconds: number; extra?: { name: string; version: string } }
export interface SignedX402 { authorization: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }; signature: Hex; header?: string /* X-PAYMENT */; ledgerRef: string }
export type SignX402 = (signer: OperatorSigner, req: PaymentRequirements) => Promise<SignedX402>;
// Implementation = Finding 3's typed data + signer.signWalletSet(typedData) + (Task 0.3's encode/settle).
```
Phase 1 (the Payment Authority) is built against this seam and `OperatorSigner` — it does **not** import the
SDK directly, so it is fully testable without live settlement.

## Task 0.3 — real Arc-testnet settlement (verified ✅ — GATE CLEARED)
**Goal:** prove a USDC movement settled on Arc testnet that corresponds to an off-chain authorization.
**Result: PASS.** Using `GatewayClient({ chain: "arcTestnet", privateKey, rpcUrl })`:
1. `deposit("3")` → approve + deposit into Gateway Wallet `0x0077…19B9` (deposit became `available` instantly).
2. `withdraw("2.5")` same-chain → signs a **burn intent (EIP-712)** → Circle Gateway API attestation →
   **`gatewayMint`** on Arc via the Gateway Minter `0x0022…475B`.

**On-chain proof:** mint tx `0xbce3463db186fd555686dda645af433d25b10842e6cbd545aa5fa75bf9b8c992` — `status: success`,
`to` = Gateway Minter, 4 USDC Transfer/Mint logs, block 47428264
([arcscan](https://testnet.arcscan.app/tx/0xbce3463db186fd555686dda645af433d25b10842e6cbd545aa5fa75bf9b8c992)).
Net cost ≈ **0.009 USDC** (gas + Gateway fee); the un-withdrawn 0.4965 USDC stays parked in the Gateway balance.
The Phase-0 gate's fallback ("Approach-1 simpler settlement via `AgentTreasury`/direct USDC") is **NOT needed**.

### Finding 5 — non-custodial IS natively supported; `GatewayClient` is just the raw-key convenience wrapper (corrected 2026-06-17)
⚠️ Earlier this was written as a "non-custodial gap." It is not. `GatewayClient` (raw `privateKey` only) is
merely the **quickstart convenience wrapper**. Circle's **intended production entry point** is
`BatchEvmScheme` / `CompositeEvmScheme` / `registerBatchScheme`, which take an injected **`BatchEvmSigner`**:
```ts
interface BatchEvmSigner { address: Address; signTypedData: (params: { domain; types; primaryType; message }) => Promise<Hex>; }
```
That is exactly our `TurnkeySigner`'s shape (`address` + a `signTypedData`/`signWalletSet`). So we plug the
**Turnkey enclave signer straight into Circle's batching scheme** — fully non-custodial, on Circle's real
nanopayments rails. Circle's `eip-3009-signing` doc explicitly shows the `signTypedData` callback for
"enclaves, hardware wallets, or custom implementations." **We abandon no Circle stack** — we use Gateway
contracts + Gateway API + batching scheme + facilitator + USDC + Arc, skipping only the convenience wrapper.
Phase 2 action: expose `TurnkeySigner.signTypedData` (alias of `signWalletSet`, injecting `EIP712Domain`) and
pass it as the `BatchEvmSigner` into `BatchEvmScheme`. **This is now empirically proven — see Task 0.2b above.**
The spike used `GatewayClient` + the PLATFORM key only to prove the rail moves money fastest; it is not the
production wiring.

## Net Phase-0 outcome
Both halves of the spec's top risk are retired: **(signing)** a Turnkey-signed x402/EIP-3009 authorization is
valid on Arc, and **(settlement)** a burn-intent authorization settles on Arc testnet via Gateway batching.
Phase 1 (Payment Authority) is unblocked and builds against the `signX402()` seam above; Phase 2 implements the
concrete non-custodial adapter (x402 buyer + Gateway settlement through the Turnkey signer).

## Phase 2 — wiring findings (2026-06-18)

> **Status:** Phase-2 implementation complete (Payment Authority + buyer + seller + funding bridge + e2e harness).
> The `--settle` live path in `backend/scripts/spike-x402-e2e.mts` is a manual stub — live settlement awaits a
> chosen live seller URL + pre-seeded operator funds. The Phase-0 mint tx remains the on-chain settlement proof.

### Finding 6 — X-PAYMENT codec: `x402/schemes` rejects Arc; use `encodeX402Header`/`decodeX402Header`

`x402/schemes` `encodePayment`/`decodePayment` **reject Arc** — `eip155:5042002` is not in their
`SupportedEVMNetworks` whitelist and they throw at runtime. Do **NOT** attempt to use `x402/schemes` for
encoding the X-PAYMENT header on Arc.

Resolution: `signX402.ts` encodes and decodes the X-PAYMENT envelope itself as `base64(JSON)`, exported as
`encodeX402Header` / `decodeX402Header`. The seller decodes via the **same exported `decodeX402Header`** — one
codec pair for the whole Phase-2 stack. Any future code that needs to read an X-PAYMENT header on Arc must use
`decodeX402Header`, not `x402/schemes`.

### Finding 7 — Self-hosted seller verification (no live Circle API key required)

`@circle-fin/x402-batching/server` exports: `BatchFacilitatorClient`, `GatewayEvmScheme`,
`createGatewayMiddleware`, `isBatchPayment`, `GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS`.

`BatchFacilitatorClient.verify` is a **remote call** that requires a live Circle API key. For the local
self-hosted seller (no API key), verification is implemented in two layers:

1. **Structural checks:** recipient == `payTo`, value >= price, `validBefore` not expired (using
   `GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS` for tolerance).
2. **EIP-712 signature recovery:** viem `verifyTypedData` against the `GatewayWalletBatched` domain:
   `name = CIRCLE_BATCHING_NAME`, `version = CIRCLE_BATCHING_VERSION`,
   `verifyingContract = GatewayWallet` (the contract address from `CHAIN_CONFIGS`).

This closes the forged-authorization gap: a payment whose signature does not recover to the stated `from`
address is rejected before any resource is served. When a live Circle API key is available,
`BatchFacilitatorClient.verify` can replace or supplement the local check.

### Finding 8 — Governed funding bridge: enclave signs top-ups, pocket signs per-payment

Per design §4.1, the two-tier signing split is:

- **Pocket hot-key** — signs every nanopayment authorization (off-chain, free, no gas).
- **Enclave (Turnkey operator key)** — signs only the rare governed top-ups.

`topUpPocket` flow:
1. `fundOperator(amount)` — treasury → operator/enclave (on-chain `AgentTreasury` call).
2. Operator → pocket: USDC forward via `operatorTransferUsdc`.
3. Pocket `GatewayClient.deposit(amount)` → refused if `amount > available()` (Gateway guard).

The operator **must send these transactions** using a Turnkey-backed `WalletClient` (not just a signer),
because `fundOperator` and `spend` are `onlyOperator`. `ArcAdapter` wraps this `WalletClient` and is
the concrete dependency injected into `topUpPocket`.

### Finding 9 — Live settlement: Phase-2 does not add a new on-chain settlement

No new on-chain settlement was performed in Phase 2. The `--settle` path in
`backend/scripts/spike-x402-e2e.mts` is an intentional documented stub — the live path requires a chosen
live seller URL and a pre-seeded operator wallet, and is completed manually once those are in place.

**The Phase-0 mint tx** (`0xbce3463db186fd555686dda645af433d25b10842e6cbd545aa5fa75bf9b8c992`) remains the
proof that the full rail (encode → sign → Gateway batch → on-chain mint) works on Arc testnet.

The open item for Phase-2 live settlement verification: confirm that the `encodeX402Header`-produced base64
envelope is accepted by Circle's live facilitator when `--settle` is run, closing the interop loop between
the self-hosted `decodeX402Header` codec and Circle's server-side decoder.

### Finding 10 — Live settlement interop: CONFIRMED on Arc testnet (2026-06-18)

**Finding 9's open item is now CLOSED.** Probe `backend/scripts/probe-settle.mts` drove our production
payload (`makeSignX402` → `encodeX402Header` → `decodeX402Header`) through Circle's **real** facilitator and
settled on Arc testnet. Payer = the PLATFORM key (it held a 0.487 USDC Gateway residual from Phase 0; the
signer is cryptographically interchangeable with the pocket).

- **Settlement entrypoint = `BatchFacilitatorClient` (`@circle-fin/x402-batching/server`).** Construct with
  `{ url: "https://gateway-api-testnet.circle.com" }` (the **testnet** base — the client appends
  `/v1/x402/...` itself; the default is mainnet, and a trailing `/v1` causes a `/v1/v1` 404). **No API key
  needed for testnet** (`createAuthHeaders` is optional).
- **`getSupported()` lists Arc testnet** `eip155:5042002`: `verifyingContract`
  `0x0077777d7eba4688bdef3e311b846f25870a19b9` (= `CHAIN_CONFIGS.arcTestnet.gatewayWallet`), USDC
  `0x3600000000000000000000000000000000000000`, **`minValiditySeconds: 604800`** (the ~7-day authorization
  window — confirms `maxTimeoutSeconds` does NOT bound expiry; the seller's per-nonce replay guard is what
  bounds reuse).
- **Interop requires two extra payload fields the seller supplies: `resource` + `accepted`.** Our X-PAYMENT
  envelope (`{x402Version, scheme, network, payload}`) is accepted in shape, but `verify`/`settle` reject it
  with `paymentPayload.resource: Required, paymentPayload.accepted: Required` until enriched. The **seller**
  (which calls settle) adds `resource: {url, description, mimeType}` and `accepted: <the PaymentRequirements
  the buyer accepted>`. The buyer↔seller manual-base64 transport needs **no change**.
- **Results:** `verify` → `{ isValid: true, payer: 0xb43c…703b }`; `settle` → `{ success: true,
  transaction: "83f306bc-cfc8-4860-b4ae-82ddd5c5b7e3", network: "eip155:5042002" }`. The payer's Gateway
  available balance debited **exactly 0.01 USDC** (0.487457 → 0.477457). The Circle transfer went
  `received` → **`completed`** in ~1 min (`getTransferById`), i.e. the batched on-chain `gatewayMint` to
  recipient `0x5c69…d08a` landed. `transaction` is a Circle **transfer ID (UUID)**, not an on-chain hash;
  resolve status via `GatewayClient.getTransferById(id)`.

**Production wiring (the only remaining settle work):** in the seller's settle path —
`decodeX402Header(header)` → spread `{ ...payload, resource, accepted: requirements }` →
`new BatchFacilitatorClient({ url: "https://gateway-api-testnet.circle.com" }).settle(payload, requirements)`.
Settlement is async/batched. **The non-custodial signer, the manual codec, the Arc constants, and the
facilitator interop are all proven — `signX402`/codec/verify need no changes.**

## Phase 3 — governed insight-agent findings (2026-06-19)

> **Status:** Phase-3 implementation complete. All four sub-phases (3A seller/settle, 3B in-process vendor,
> 3C tools/pricing, 3D Claude agent loop, 3E demo/CLI) are built and pass 145 tests. The live agent path
> requires `ANTHROPIC_API_KEY`; the live settlement path additionally requires `--settle` and a funded pocket.
> Both are gated behind explicit opt-ins (see `backend/scripts/spike-agent-live.mts`).

### Finding 11 — Hand-rolled Anthropic SDK Messages tool-loop (no Vercel AI SDK)

The insight-agent (`backend/src/agent/insightAgent.ts`) calls `client.messages.create` directly from
`@anthropic-ai/sdk` — a plain `for` loop over up to 8 steps, no Vercel AI SDK, no streaming, no framework.
This is intentional: the governed payment path (`authorizePayment` + `PaymentLedger`) is synchronous and
transactional; an SDK abstraction would add latency and opacity with no benefit in a single-user demo.

The loop is deterministic by construction: it calls a fixed set of tools (`get_budget` / `buy_data`),
accumulates `purchases` + `denied` lists, breaks on `stop_reason !== "tool_use"`, and caps at 8 steps.
Tests inject a `FakeAnthropicClient` (see Finding 12) so every non-live test runs without a network call.

### Finding 12 — Deterministic fake-Anthropic-client test approach

All unit/integration tests for the agent loop (`test/agent/insightAgent.test.ts`, `test/agent/demo.int.test.ts`,
`test/agent/cli.test.ts`) inject a `FakeAnthropicClient` that returns a fixed, pre-scripted sequence of
`Anthropic.Messages.Message` objects — zero network calls, deterministic P&L, repeatable in CI.

The fake is typed against `Anthropic.Messages.MessageCreateParamsNonStreaming` → `Anthropic.Messages.Message`
so TypeScript catches any drift between the fake and the real SDK surface. No mocking framework is used;
the fake is a plain class with a `messages.create` method that pops from a queue.

### Finding 13 — snake_case tool names (`get_budget` / `buy_data`)

The Anthropic Messages API requires tool `name` to match `^[a-zA-Z0-9_-]{1,64}$`. The agent uses
`get_budget` and `buy_data` (snake_case). The tool-dispatch switch in `insightAgent.ts` keys off these
exact strings. Any rename must update both `TOOL_DEFS` and the dispatch block simultaneously.

### Finding 14 — Structural "agent holds no key" invariant

The agent module (`backend/src/agent/`) **never imports** `signX402`, `pocketSignerFromKey`, or any private
key. The only spend path is: agent calls `buy_data` tool → `makeTools` calls `authorize` (injected
`AuthorizeFn`) → `authorizePayment` reads the treasury + signs via the injected `signX402` seam. The agent
cannot spend without going through the Payment Authority; a forged or over-budget buy is rejected before any
signing occurs. This is verifiable by `grep -r "signX402\|pocketSigner\|privateKey" backend/src/agent/` — it
returns nothing.

### Finding 15 — Model IDs and the `AGENT_MODEL` toggle

Default model: `claude-sonnet-4-6` (set in `backend/src/config/env.ts` via `AGENT_MODEL` default).
Toggle to `claude-opus-4-8` by setting `AGENT_MODEL=claude-opus-4-8` in `backend/.env`. The model string
is passed through `loadConfig()` → `cfg.agentModel` → `buildLiveAgentRunner()` → `runDemo` → `buildInsightAgent`
→ `client.messages.create({ model })`. No hardcoded model ID anywhere in the agent or tool layers.

### Finding 16 — Agent-runner `--settle` path is a deliberate stub

The seller settle hook (`settleWith` / `makeSettle`), the opt-in `LIVE_SETTLE` test, and the `settle.ts`
facilitator integration are fully wired and proven (see Findings 9–10). However, the **insight-agent runner's
`--settle` flag** in `backend/scripts/spike-agent-live.mts` is a deliberate stub that throws
`"fill in..."` — because `buildLiveAgentRunner` does not yet accept a `SettleFn` parameter. An end-to-end
live *agent* buy+sell flow with on-chain settlement is therefore not yet wired; the settle hook lives at the
seller HTTP layer and has not been plumbed through the agent runner CLI.

### Live run placeholder (to be filled when run with a key)

```
# fill in after running: ANTHROPIC_API_KEY=sk-... npx tsx scripts/spike-agent-live.mts
query:     "Give me a brief market-trend summary using the cheapest available dataset(s). Stay within budget."
model:     claude-sonnet-4-6
purchases: (dataset id + atomic USDC cost — fill in)
denied:    (if any — fill in)
answer:    (fill in)
P&L:       totalCost=  price=  pnl=  (atomic USDC)

# fill in after running with --settle:
settle transfer ids: (Circle UUID — fill in)
```
