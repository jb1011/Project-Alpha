# Governed Nanopayment Agent — Phase 2 Implementation Plan (Spend + Earn + Governed Funding)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase‑1 Payment Authority into a working two‑sided nanopayment agent: a non‑custodial `signX402` adapter signed by a **bounded pocket hot‑key**, a **governed treasury→pocket funding bridge** (enclave‑signed top‑ups), an **x402 Buyer** that spends through the Authority, and a **self‑hosted x402 Seller** that earns into the treasury — proven end‑to‑end on Arc testnet.

**Architecture:** Additive on the deployed protocol (contracts / onboarding / `TurnkeySigner` UNCHANGED). Phase 1 left an injected `signX402()` seam and a `readTreasury()` seam, both faked in tests. Phase 2 makes them concrete: per §4.1 the **per‑payment signer is the pocket** (a local hot key, free to sign), while the **enclave operator** signs only the rare governed top‑ups (`fundOperator`) and the enclave→pocket forward — so Turnkey signature cost is O(top‑ups), not O(payments). The Buyer routes every `402` through `POST /authorize` (the agent holds no key); the Seller verifies inbound `X‑PAYMENT` with Circle's own batching verifier and settles revenue into the treasury via Gateway.

**Tech Stack:** TypeScript (ESM, Node ≥20.18), viem + abitype, better‑sqlite3, vitest, biome, Hono, Turnkey (`@turnkey/viem` / `@turnkey/sdk-server`), `@circle-fin/x402-batching` (`/client` for the buyer/Gateway, `/server` for the seller — needs the `@x402/evm` peer), Coinbase `x402` (subpath exports), `x402-fetch`.

## Global Constraints

Every task's requirements implicitly include these (verbatim from the design + Phase‑0 findings):

- **Additive only.** Do not modify `src/*.sol`, the onboarding saga, or the existing `OperatorSigner`/`TurnkeySigner` signing surface. New code lives in `backend/src/adapters/x402/` and `backend/src/payments/`.
- **Non‑custodial vault, bounded pocket.** The enclave (Turnkey) key never leaves the enclave. The **pocket** is a bounded hot key; its worst‑case loss is the float it holds, never the treasury. Per §4.1 the pocket signs every nanopayment; the enclave signs only governed top‑ups + on‑chain `spend()`.
- **Turnkey is metered (free tier 25 sigs/month).** Per‑payment signing MUST use the pocket (free). Any test that drives a **live enclave signature** or **real Gateway settlement** MUST be gated behind an opt‑in env flag (`LIVE_SETTLE=1`) and skipped by default.
- **Batching domain, not USDC.** The Circle batching authorization signs EIP‑3009 `TransferWithAuthorization` against the **GatewayWallet** contract with EIP‑712 domain name **`"GatewayWalletBatched"`** version **`"1"`** (`CIRCLE_BATCHING_NAME`/`CIRCLE_BATCHING_VERSION`), `verifyingContract = CHAIN_CONFIGS.arcTestnet.gatewayWallet` — NOT the USDC token domain.
- **EIP712Domain must be injected.** Any typed data signed through the Turnkey path must declare `EIP712Domain` explicitly in `types` (the Turnkey path does not auto‑derive it; omission yields a wrong digest). The `signX402` adapter injects it unconditionally (harmless for local accounts).
- **Arc constants.** chainId `5042002`; x402 network string `"eip155:5042002"`; USDC `0x3600…0000`, 6 decimals (atomic units are `bigint`). Circle config via `CHAIN_CONFIGS.arcTestnet` and `GATEWAY_DOMAINS.arcTestnet === 26`.
- **Quality gate per task.** `npm run typecheck` (tsc) and `npm run lint` (biome) clean; `npm test` green. Commit at the end of each task.
- **Secret hygiene.** `POCKET_PRIVATE_KEY` and `TURNKEY_*` stay in gitignored `.env`. Rotate the Turnkey key / use a throwaway sub‑org before the public‑repo carve‑out.

## File structure (Phase 2)

| File | Responsibility |
|---|---|
| `backend/src/config/env.ts` (modify) | Add `POCKET_PRIVATE_KEY` → `cfg.pocketPrivateKey`; redact it |
| `backend/src/adapters/x402/types.ts` | Shared x402 types: `X402Requirements`, `SignedX402`, the `SignX402` seam type |
| `backend/src/adapters/x402/signX402.ts` | Concrete non‑custodial signer: wrap any `BatchEvmSigner` in Circle's `BatchEvmScheme` (+EIP712Domain), return `{ header, authorization, signature, ledgerRef }` |
| `backend/src/adapters/x402/pocket.ts` | The pocket hot‑key as a `BatchEvmSigner` (local key) + the per‑chain batching config (asset/network/verifyingContract) |
| `backend/src/adapters/x402/gateway.ts` | Thin wrapper over `GatewayClient` for the pocket: `deposit` / `getAvailable` |
| `backend/src/adapters/turnkey/operatorWallet.ts` | Build a Turnkey‑backed viem `WalletClient` that can **send** txs as the operator (enclave) |
| `backend/src/adapters/arc/arcAdapter.ts` (modify) | Add operator‑sent writes: `fundOperator(treasury, amount)`, `operatorTransferUsdc(usdc, to, amount)`; add optional `operatorWallet` dep |
| `backend/src/payments/funding.ts` | The governed bridge: `topUpPocket()` = `fundOperator` → forward → Gateway `deposit`, bounded by `available()` |
| `backend/src/payments/authority.ts` (modify) | Extend `AuthorizeRequest` to carry x402 requirements; thread them to `signX402` |
| `backend/src/payments/server.ts` (modify) | Parse x402 requirements from the POST body into the extended `AuthorizeRequest` |
| `backend/src/payments/buyer.ts` | x402 Buyer: intercept `402` → `POST /authorize` → retry with `X‑PAYMENT` |
| `backend/src/payments/seller.ts` | x402 Seller paywall: `402` → self‑host batching verify (`@circle-fin/x402-batching/server`) → serve; recipient = treasury payout |
| `backend/src/payments/service.ts` | Runnable Authority entrypoint: wire real `readTreasury` + `signX402` + ledger + Hono server |
| `backend/scripts/spike-x402-e2e.mts` | Phase 2F prove‑it‑works: offline buy+sell handshake by default; `--settle` runs a real Gateway settlement on Arc |
| `backend/test/**` | Unit + anvil integration tests per task |

---

## How this plan is phased (read first)

Phase 2 is large because the chosen scope is the *full* two‑sided rail **plus** the governed funding bridge. It splits into six independently‑testable sub‑phases; a reviewer can accept/reject each on its own:

- **2A — `signX402` adapter (pocket).** The concrete non‑custodial signer. Fully offline‑testable (sign + recover with a local key; header round‑trips). No money, no enclave.
- **2B — Governed funding bridge.** `fundOperator` + enclave→pocket forward (operator‑sent txs, anvil‑testable) + pocket Gateway `deposit` (live, opt‑in). Adds the operator `WalletClient` capability.
- **2C — Buyer.** Intercept `402` → Authority → retry. Offline‑testable with a fake resource server + fake Authority.
- **2D — Seller.** Self‑host Circle's batching verifier (installs the `@x402/evm` peer). Probe‑then‑TDD because the `/server` API is not yet installed.
- **2E — Runnable Authority service.** Wire the real seams together behind `POST /authorize`. Offline‑testable via `app.request`.
- **2F — End‑to‑end.** Offline buy+sell handshake by default; `--settle` proves a real settled buy on Arc.

**2D depends only on 2A** (it verifies what 2A produces). **2C depends on 2A + 2E's route shape.** If time runs short, 2A→2C→2E (the spend path + a stubbed earn side) is a coherent demo; 2B and 2D can land after. Each sub‑phase ends green.

**Branch:** `feat/nanopayments-x402-agent` (continue on it; Phase 0+1 already committed).

---

# Phase 2A — The concrete `signX402` adapter (pocket‑signed)

> Lifts spike Task 0.2b (`BatchEvmScheme` + injected `BatchEvmSigner` + EIP712Domain) out of `scripts/spike-x402-gateway.mts` into `backend/src/adapters/x402/`. The injected signer is the **pocket** (a local hot key) per §4.1 — but the adapter is signer‑agnostic, so the same code accepts the enclave signer for the large/critical tier later. Fully offline: signs with a local key and asserts recovery; no Gateway, no money, no Turnkey.

### Task 2A.1: Pocket key config

**Files:**
- Modify: `backend/src/config/env.ts`
- Test: `backend/test/config/pocketKey.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/config/pocketKey.test.ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("POCKET_PRIVATE_KEY is parsed into cfg.pocketPrivateKey", () => {
  const cfg = loadConfig({ ...base, POCKET_PRIVATE_KEY: `0x${"2".repeat(64)}` });
  expect(cfg.pocketPrivateKey).toBe(`0x${"2".repeat(64)}`);
});

test("pocketPrivateKey is redacted in the safe-to-log view", () => {
  const cfg = loadConfig({ ...base, POCKET_PRIVATE_KEY: `0x${"2".repeat(64)}` });
  expect(redact(cfg).pocketPrivateKey).toBe("REDACTED");
});

test("pocketPrivateKey is optional", () => {
  expect(loadConfig(base).pocketPrivateKey).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/config/pocketKey.test.ts`
Expected: FAIL — `cfg.pocketPrivateKey` is `undefined` even when set (field not wired).

- [ ] **Step 3: Add the field** — in `backend/src/config/env.ts`: add `POCKET_PRIVATE_KEY: privKeySchema.optional()` to `EnvSchema`; add `pocketPrivateKey?: Hex` to the `Config` interface; map `pocketPrivateKey: e.POCKET_PRIVATE_KEY` in the return of `loadConfig`; in `redact()` add `pocketPrivateKey: cfg.pocketPrivateKey ? "REDACTED" : undefined`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/config/pocketKey.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/test/config/pocketKey.test.ts
git commit -m "feat(payments): POCKET_PRIVATE_KEY config (the bounded hot-key)"
```

### Task 2A.2: Shared x402 adapter types

**Files:**
- Create: `backend/src/adapters/x402/types.ts`

- [ ] **Step 1: Write the types** (no test — pure type declarations consumed by 2A.3+)

```ts
// backend/src/adapters/x402/types.ts
import type { Address, Hex } from "../../types";

/** A `BatchEvmSigner` as Circle's BatchEvmScheme expects it: an address + an EIP-712 typed-data signer.
 *  Both a local pocket key and the Turnkey enclave signer satisfy this shape. */
export interface BatchEvmSigner {
  address: Address;
  signTypedData: (params: {
    domain: unknown;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
}

/** The x402 PaymentRequirements we need to build a batching authorization (subset of the 402 body). */
export interface X402Requirements {
  payTo: Address; // recipient (== the policy payee)
  amount: bigint; // atomic USDC (6 decimals)
  asset: Address; // USDC token address
  network: string; // "eip155:5042002"
  maxTimeoutSeconds: number;
}

export interface SignedAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/** What a signer returns: the encoded X-PAYMENT header + the raw authorization for the ledger/audit. */
export interface SignedX402 {
  header: string; // base64 X-PAYMENT envelope
  authorization: SignedAuthorization;
  signature: Hex;
  ledgerRef: string; // the authorization nonce, used to reconcile settlement back to the ledger
}

/** The seam: given requirements, produce a signed X-PAYMENT. The concrete impl closes over a signer +
 *  the per-chain batching config (verifyingContract etc). */
export type SignX402 = (req: X402Requirements) => Promise<SignedX402>;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/adapters/x402/types.ts
git commit -m "feat(payments): x402 adapter seam types (BatchEvmSigner, SignX402)"
```

### Task 2A.3: The pocket as a `BatchEvmSigner` + per-chain batching config

**Files:**
- Create: `backend/src/adapters/x402/pocket.ts`
- Test: `backend/test/adapters/x402/pocket.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/adapters/x402/pocket.test.ts
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { pocketSignerFromKey } from "../../../src/adapters/x402/pocket";

const KEY = `0x${"2".repeat(64)}` as const;

test("pocketSignerFromKey exposes the pocket address and signs typed data", async () => {
  const signer = pocketSignerFromKey(KEY);
  expect(signer.address).toBe(privateKeyToAccount(KEY).address);

  const sig = await signer.signTypedData({
    domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002, verifyingContract: `0x${"00".repeat(20)}` },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: signer.address },
  });
  expect(sig).toMatch(/^0x[0-9a-f]+$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/adapters/x402/pocket.test.ts`
Expected: FAIL — cannot find `pocketSignerFromKey`.

- [ ] **Step 3: Implement** — wrap a local viem account as a `BatchEvmSigner`, injecting `EIP712Domain` so the same wrapper is safe for the Turnkey path too. Also export the Arc batching config read from `CHAIN_CONFIGS`.

```ts
// backend/src/adapters/x402/pocket.ts
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "../../types";
import type { BatchEvmSigner } from "./types";

/** EIP712Domain must be declared explicitly for the Turnkey path; harmless for local accounts. */
const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Wrap any object exposing `{ address, signTypedData }` so EIP712Domain is always injected. */
export function asBatchEvmSigner(inner: {
  address: Address;
  signTypedData: (td: TypedDataDefinition) => Promise<Hex>;
}): BatchEvmSigner {
  return {
    address: inner.address,
    signTypedData: (params) =>
      inner.signTypedData({ ...params, types: { EIP712Domain, ...params.types } } as TypedDataDefinition),
  };
}

/** The pocket hot-key as a BatchEvmSigner (free to sign — never touches the enclave). */
export function pocketSignerFromKey(privateKey: Hex): BatchEvmSigner {
  const account = privateKeyToAccount(privateKey);
  return asBatchEvmSigner({
    address: account.address,
    signTypedData: (td) => account.signTypedData(td),
  });
}

/** Per-chain Circle batching constants for Arc testnet (verifyingContract = GatewayWallet, NOT USDC). */
export const arcBatchingConfig = {
  network: "eip155:5042002" as const,
  asset: CHAIN_CONFIGS.arcTestnet.usdc as Address,
  verifyingContract: CHAIN_CONFIGS.arcTestnet.gatewayWallet as Address,
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/adapters/x402/pocket.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/x402/pocket.ts backend/test/adapters/x402/pocket.test.ts
git commit -m "feat(payments): pocket hot-key as a BatchEvmSigner + Arc batching config"
```

### Task 2A.4: Probe the X-PAYMENT encode + BatchEvmScheme payload shape

**Files:**
- Modify: `backend/scripts/spike-x402-gateway.mts` is NOT touched; do this as a throwaway probe (record the answer in this task's commit message / a comment in `signX402.ts`).

- [ ] **Step 1: Probe the real exports** (the `/client` payload shape + how x402 encodes the header)

Run:
```bash
cd backend
node -e "import('@circle-fin/x402-batching/client').then(m=>console.log('client:',Object.keys(m)))"
node -e "import('x402/schemes').then(m=>console.log('schemes:',Object.keys(m)))"
node -e "import('x402/types').then(m=>console.log('types:',Object.keys(m)))"
```
**RECORDED (probed 2026-06-18):** `BatchEvmScheme.createPaymentPayload(version, requirements)` returns `{ payload: { authorization, signature } }` (proven in spike Task 0.2b). The canonical X‑PAYMENT codec is **`encodePayment` / `decodePayment` exported from `x402/schemes`** — they operate on the full x402 `PaymentPayload` envelope `{ x402Version, scheme, network, payload }` (validated by `PaymentPayloadSchema` in `x402/types`). 2A.5 wraps these (the manual base64 envelope is the documented fallback if a validation mismatch appears).

- [ ] **Step 2: No commit** (probe only) — the finding is recorded above; 2A.5 uses `encodePayment`/`decodePayment`.

### Task 2A.5: `makeSignX402` — the concrete adapter

**Files:**
- Create: `backend/src/adapters/x402/signX402.ts`
- Test: `backend/test/adapters/x402/signX402.test.ts`

- [ ] **Step 1: Write the failing test** — sign with a local pocket key through the real `BatchEvmScheme`, assert the authorization recovers to the pocket and the header decodes back to the same payload.

```ts
// backend/test/adapters/x402/signX402.test.ts
import { evm } from "x402/types";
import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../../src/adapters/x402/pocket";
import { decodeX402Header, makeSignX402 } from "../../../src/adapters/x402/signX402";

const KEY = `0x${"2".repeat(64)}` as const;
const pocket = privateKeyToAccount(KEY);
const payee = getAddress(`0x${"ab".repeat(20)}`);

test("signs a batching authorization that recovers to the pocket, and the header round-trips", async () => {
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });

  const signed = await signX402({
    payTo: payee,
    amount: 1n,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    maxTimeoutSeconds: 60,
  });

  // recovery: the GatewayWalletBatched authorization recovers to the pocket address
  const recovered = await verifyTypedData({
    address: pocket.address,
    domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002, verifyingContract: arcBatchingConfig.verifyingContract },
    types: evm.authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(signed.authorization.from),
      to: getAddress(signed.authorization.to),
      value: BigInt(signed.authorization.value),
      validAfter: BigInt(signed.authorization.validAfter),
      validBefore: BigInt(signed.authorization.validBefore),
      nonce: signed.authorization.nonce,
    },
    signature: signed.signature,
  });
  expect(recovered).toBe(true);

  // header round-trips to the same payload
  const decoded = decodeX402Header(signed.header);
  expect(decoded.payload.signature).toBe(signed.signature);
  expect(decoded.network).toBe(arcBatchingConfig.network);
  expect(signed.ledgerRef).toBe(signed.authorization.nonce);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/adapters/x402/signX402.test.ts`
Expected: FAIL — cannot find `makeSignX402`/`decodeX402Header`.

- [ ] **Step 3: Implement** — build the payload via Circle's `BatchEvmScheme`, encode the X‑PAYMENT envelope. Use the encoder discovered in 2A.4; the manual base64 envelope below is the documented x402 wire format and is the fallback.

```ts
// backend/src/adapters/x402/signX402.ts
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from "@circle-fin/x402-batching";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { decodePayment, encodePayment } from "x402/schemes";
import type { Address } from "../../types";
import type { BatchEvmSigner, SignedAuthorization, SignedX402, SignX402, X402Requirements } from "./types";

export interface SignX402Config {
  signer: BatchEvmSigner; // the pocket (per §4.1); the enclave for the large/critical tier later
  chainId: number;
  network: string; // "eip155:5042002"
  verifyingContract: Address; // GatewayWallet
}

interface X402Envelope {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { authorization: SignedAuthorization; signature: `0x${string}` };
}

/** Decode an X-PAYMENT header back into its envelope (used by the seller + tests).
 *  Uses x402's canonical codec (recorded in 2A.4). Manual base64 JSON is the documented fallback. */
export function decodeX402Header(header: string): X402Envelope {
  return decodePayment(header) as unknown as X402Envelope;
}

function encodeX402Header(env: X402Envelope): string {
  return encodePayment(env as never);
}

/** Build the concrete signX402 seam from a signer + per-chain batching config. */
export function makeSignX402(cfg: SignX402Config): SignX402 {
  const scheme = new BatchEvmScheme(cfg.signer);
  return async (req: X402Requirements): Promise<SignedX402> => {
    const requirements = {
      scheme: CIRCLE_BATCHING_SCHEME,
      network: cfg.network,
      asset: req.asset,
      amount: req.amount.toString(),
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        verifyingContract: cfg.verifyingContract,
      },
    };
    const { payload } = await scheme.createPaymentPayload(1, requirements);
    const authorization = payload.authorization as SignedAuthorization;
    const signature = payload.signature as `0x${string}`;
    const env: X402Envelope = {
      x402Version: 1,
      scheme: CIRCLE_BATCHING_SCHEME,
      network: cfg.network,
      payload: { authorization, signature },
    };
    return { header: encodeX402Header(env), authorization, signature, ledgerRef: authorization.nonce };
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/adapters/x402/signX402.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

If recovery fails: the domain name/version or `verifyingContract` is wrong — confirm against `CHAIN_CONFIGS.arcTestnet.gatewayWallet` and `CIRCLE_BATCHING_NAME/VERSION` (spike Task 0.2b proves the correct values). If the header shape mismatches the seller's decoder (2D), reconcile both to the encoder found in 2A.4.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/x402/signX402.ts backend/test/adapters/x402/signX402.test.ts
git commit -m "feat(payments): concrete non-custodial signX402 via Circle BatchEvmScheme"
```

---

# Phase 2B — The governed treasury→pocket funding bridge

> The enclave (operator) signs only here, rarely (O(top-ups)). `fundOperator`/`spend` are `onlyOperator`, so the operator must **send** the tx — a new capability (today only the manager sends). We add a Turnkey‑backed operator `WalletClient`, two operator‑sent adapter writes, and the bridge that moves a capped float treasury→operator→pocket→Gateway. On‑chain steps are anvil‑testable with a local operator key; the live Gateway `deposit` is opt‑in (`LIVE_SETTLE=1`).
>
> **Live prerequisite (note in code, not a test):** on real Arc the operator EOA pays USDC gas, so seed it once with a small USDC reserve from the platform key before the first `fundOperator`. On anvil, accounts are ETH‑funded by default — no seed needed.

### Task 2B.1: Operator-sent writes on ArcAdapter

**Files:**
- Modify: `backend/src/adapters/arc/arcAdapter.ts`
- Test: `backend/test/payments/fundOperator.int.test.ts`

- [ ] **Step 1: Write the failing integration test** (anvil; operator is a local key so the test can drive operator‑sent txs)

```ts
// backend/test/payments/fundOperator.int.test.ts
import { http, type PublicClient, createPublicClient, createWalletClient, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { deployStack } from "../helpers/stack";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let anvil: AnvilHandle;
let pub: PublicClient;
let adapter: ArcAdapter;
let treasury: `0x${string}`;
let usdc: `0x${string}`;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]);
const operator = privateKeyToAccount(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;
const pocket = privateKeyToAccount(`0x${"e".repeat(63)}1`).address;

beforeAll(async () => {
  anvil = await startAnvil(8551);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  const managerWallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  const operatorWallet = createWalletClient({ account: operator, chain: anvilChain, transport });
  const stack = await deployStack(managerWallet, pub, manager.address);
  usdc = stack.usdc;
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet,
    operatorWallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  const res = await adapter.createEntity({
    manager: manager.address, guardian: guardian.address, operator: operator.address,
    amendmentDelay: 3_600n, metadataURI: "file:///tmp/m.json", ein: "STUB-NOT-FILED",
    formationDate: 0, operatingAgreementHash: `0x${"ab".repeat(32)}`,
    treasury: { usdc, payoutAddress: payout, cap: 1_000_000n, period: 2_592_000n, allowlistEnabled: false },
  });
  treasury = res.treasury;
  // fund the treasury so it has USDC to push to the operator
  await adapter.fundTreasury({ usdc, treasury, amount: 500_000n });
}, 60_000);
afterAll(() => anvil?.stop());

test("fundOperator moves USDC treasury->operator; operatorTransferUsdc forwards operator->pocket", async () => {
  await adapter.fundOperator(treasury, 10_000n);
  const opBal = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [operator.address] });
  expect(opBal).toBe(10_000n);

  await adapter.operatorTransferUsdc(usdc, pocket, 10_000n);
  const pocketBal = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [pocket] });
  expect(pocketBal).toBe(10_000n);
  const opAfter = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [operator.address] });
  expect(opAfter).toBe(0n);
}, 60_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/fundOperator.int.test.ts`
Expected: FAIL — `adapter.fundOperator is not a function` (and the `operatorWallet` dep is not accepted).

- [ ] **Step 3: Implement** — add `operatorWallet?: WalletClient` to `ArcAdapterDeps`; add the two operator‑sent writes (mirror the existing `fundTreasury` simulate→writeContract→wait pattern, but `account: operator`).

```ts
// in ArcAdapterDeps:
operatorWallet?: WalletClient; // signs/sends as the operator (the enclave); required for fundOperator/spend

// new methods on ArcAdapter (after fundTreasury):

/** Operator pushes USDC from the treasury to the operator's own EOA, within the cap (onlyOperator). */
async fundOperator(treasury: Address, amount: bigint): Promise<Hex> {
  const operatorWallet = this.requireOperatorWallet();
  const { request } = await this.d.publicClient.simulateContract({
    account: operatorWallet.account ?? undefined,
    address: treasury,
    abi: agentTreasuryAbi,
    functionName: "fundOperator",
    args: [amount],
  });
  const hash = await operatorWallet.writeContract(request);
  await this.d.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Operator forwards USDC from its own EOA to the bounded pocket EOA (a plain ERC-20 transfer). */
async operatorTransferUsdc(usdc: Address, to: Address, amount: bigint): Promise<Hex> {
  const operatorWallet = this.requireOperatorWallet();
  const { request } = await this.d.publicClient.simulateContract({
    account: operatorWallet.account ?? undefined,
    address: usdc,
    abi: erc20TransferAbi,
    functionName: "transfer",
    args: [to, amount],
  });
  const hash = await operatorWallet.writeContract(request);
  await this.d.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

private requireOperatorWallet(): WalletClient {
  if (!this.d.operatorWallet) {
    throw new Error("operatorWallet not configured: fundOperator/operatorTransferUsdc need the operator (enclave) signer");
  }
  return this.d.operatorWallet;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/fundOperator.int.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/arcAdapter.ts backend/test/payments/fundOperator.int.test.ts
git commit -m "feat(payments): operator-sent fundOperator + USDC forward on ArcAdapter"
```

### Task 2B.2: Turnkey-backed operator WalletClient (can send txs)

**Files:**
- Create: `backend/src/adapters/turnkey/operatorWallet.ts`
- Test: `backend/test/adapters/turnkey/operatorWallet.test.ts`

> The existing `buildOperatorSigner` only signs EIP‑712. The bridge needs the operator to **send** txs. This builds a viem `WalletClient` whose account is the Turnkey enclave account (production) or a local key (fallback). Unit‑test only the fallback + address wiring (no live Turnkey call).

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/adapters/turnkey/operatorWallet.test.ts
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { buildOperatorWalletClient } from "../../../src/adapters/turnkey/operatorWallet";
import type { Config } from "../../../src/config/env";

const cfg = {
  rpcUrl: "https://rpc.example/v1",
  chainId: 5042002,
  operatorPrivateKey: `0x${"3".repeat(64)}`,
} as Config;

test("falls back to a local operator wallet whose account address matches the key", async () => {
  const wallet = await buildOperatorWalletClient(cfg);
  expect(wallet.account?.address).toBe(privateKeyToAccount(cfg.operatorPrivateKey!).address);
  expect(wallet.chain?.id).toBe(5042002);
});

test("throws when neither Turnkey nor a local operator key is configured", async () => {
  await expect(buildOperatorWalletClient({ ...cfg, operatorPrivateKey: undefined } as Config)).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/adapters/turnkey/operatorWallet.test.ts`
Expected: FAIL — cannot find `buildOperatorWalletClient`.

- [ ] **Step 3: Implement** — Turnkey path uses `@turnkey/viem`'s account (a `LocalAccount` that signs transactions) in a viem `WalletClient`; fallback uses `privateKeyToAccount`. Build the Arc chain inline from `cfg` (mirror `src/chains.ts`).

```ts
// backend/src/adapters/turnkey/operatorWallet.ts
import { createWalletClient, defineChain, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../../config/env";

function arcChain(cfg: Config) {
  return defineChain({
    id: cfg.chainId,
    name: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

/**
 * Build a WalletClient that SENDS transactions as the operator (the enclave). Production: a Turnkey
 * account (key stays in the enclave; @turnkey/viem returns a LocalAccount that can sign transactions).
 * Fallback: a local key from OPERATOR_PRIVATE_KEY (testnet/dev only).
 */
export async function buildOperatorWalletClient(cfg: Config): Promise<WalletClient> {
  const transport = http(cfg.rpcUrl);
  const chain = arcChain(cfg);
  if (cfg.turnkey) {
    // Lazy-import so unit tests (fallback path) don't require the Turnkey SDK wiring.
    const { TurnkeyServerSDK } = await import("@turnkey/sdk-server");
    const { createAccount } = await import("@turnkey/viem");
    const turnkey = new TurnkeyServerSDK({
      apiBaseUrl: cfg.turnkey.baseUrl,
      apiPublicKey: cfg.turnkey.apiPublicKey,
      apiPrivateKey: cfg.turnkey.apiPrivateKey,
      defaultOrganizationId: cfg.turnkey.organizationId,
    });
    const account = await createAccount({
      client: turnkey.apiClient(),
      organizationId: cfg.turnkey.organizationId,
      signWith: cfg.turnkey.signWith,
    });
    return createWalletClient({ account, chain, transport });
  }
  if (cfg.operatorPrivateKey) {
    return createWalletClient({ account: privateKeyToAccount(cfg.operatorPrivateKey), chain, transport });
  }
  throw new Error("No operator wallet configured: set TURNKEY_* (preferred) or OPERATOR_PRIVATE_KEY.");
}
```

> Verify the `@turnkey/viem` `createAccount` call signature against the existing `TurnkeySigner` (`backend/src/adapters/turnkey/turnkeySigner.ts`) — reuse the exact construction it already uses so the enclave wiring is identical. Adjust the import/args here to match it.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/adapters/turnkey/operatorWallet.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/turnkey/operatorWallet.ts backend/test/adapters/turnkey/operatorWallet.test.ts
git commit -m "feat(payments): Turnkey-backed operator WalletClient (sends governed txs)"
```

### Task 2B.3: The Gateway wrapper for the pocket

**Files:**
- Create: `backend/src/adapters/x402/gateway.ts`
- Test: `backend/test/adapters/x402/gateway.test.ts`

> `GatewayClient` takes a raw `privateKey` — appropriate for the **pocket** (a bounded hot key by design). This thin wrapper exposes only `deposit` + `getAvailable`. The unit test asserts construction + that live calls are guarded; the real deposit runs in 2F under `--settle`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/adapters/x402/gateway.test.ts
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { PocketGateway } from "../../../src/adapters/x402/gateway";

const KEY = `0x${"2".repeat(64)}` as const;

test("PocketGateway exposes the pocket address from its key", () => {
  const gw = new PocketGateway({ pocketPrivateKey: KEY, rpcUrl: "https://rpc.example/v1" });
  expect(gw.address).toBe(privateKeyToAccount(KEY).address);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/adapters/x402/gateway.test.ts`
Expected: FAIL — cannot find `PocketGateway`.

- [ ] **Step 3: Implement**

```ts
// backend/src/adapters/x402/gateway.ts
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "../../types";

export interface PocketGatewayOpts {
  pocketPrivateKey: Hex;
  rpcUrl: string;
}

/** The pocket's Gateway balance: deposit USDC the pocket holds, read its available balance. */
export class PocketGateway {
  private readonly client: GatewayClient;
  readonly address: Address;
  constructor(opts: PocketGatewayOpts) {
    this.client = new GatewayClient({ chain: "arcTestnet", privateKey: opts.pocketPrivateKey, rpcUrl: opts.rpcUrl });
    this.address = privateKeyToAccount(opts.pocketPrivateKey).address;
  }
  /** Deposit `amountUsdc` (decimal string, e.g. "0.5") from the pocket EOA into its Gateway balance. */
  deposit(amountUsdc: string) {
    return this.client.deposit(amountUsdc);
  }
  async getAvailable(): Promise<number> {
    const b = await this.client.getBalances();
    return Number(b.gateway.formattedAvailable);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/adapters/x402/gateway.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/x402/gateway.ts backend/test/adapters/x402/gateway.test.ts
git commit -m "feat(payments): PocketGateway wrapper (deposit/getAvailable for the hot-key)"
```

### Task 2B.4: `topUpPocket()` — the bridge, bounded by available()

**Files:**
- Create: `backend/src/payments/funding.ts`
- Test: `backend/test/payments/funding.test.ts`

> Composes the bridge and enforces the cap **before** the enclave signs: it reads `available()` and refuses a top‑up that would exceed it. The on‑chain steps come from 2B.1 (anvil‑tested there); here we test the orchestration + the cap guard with fakes, so it stays fast and offline.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/payments/funding.test.ts
import { expect, test, vi } from "vitest";
import { topUpPocket, type FundingDeps } from "../../src/payments/funding";

const treasury = `0x${"aa".repeat(20)}` as const;
const usdc = `0x${"bb".repeat(20)}` as const;
const pocket = `0x${"cc".repeat(20)}` as const;

function deps(over: Partial<FundingDeps> = {}): FundingDeps {
  return {
    treasury, usdc, pocketAddress: pocket,
    available: async () => 1_000_000n,
    fundOperator: vi.fn(async () => "0xfund" as const),
    operatorTransferUsdc: vi.fn(async () => "0xxfer" as const),
    depositToGateway: vi.fn(async () => undefined),
    ...over,
  };
}

test("a within-cap top-up runs fundOperator -> forward -> gateway deposit in order", async () => {
  const d = deps();
  await topUpPocket(d, 250_000n);
  expect(d.fundOperator).toHaveBeenCalledWith(treasury, 250_000n);
  expect(d.operatorTransferUsdc).toHaveBeenCalledWith(usdc, pocket, 250_000n);
  expect(d.depositToGateway).toHaveBeenCalledWith("0.25"); // 250000 atomic / 1e6, USDC has 6 decimals
});

test("refuses a top-up that exceeds available() and signs nothing", async () => {
  const d = deps({ available: async () => 100_000n });
  await expect(topUpPocket(d, 250_000n)).rejects.toThrow(/exceeds available/);
  expect(d.fundOperator).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/funding.test.ts`
Expected: FAIL — cannot find `topUpPocket`.

- [ ] **Step 3: Implement** — note the atomic→decimal formatting for `GatewayClient.deposit` (it takes a decimal string; the rest of the system uses atomic `bigint`).

```ts
// backend/src/payments/funding.ts
import { formatUnits } from "viem";
import type { Address, Hex } from "../types";

export interface FundingDeps {
  treasury: Address;
  usdc: Address;
  pocketAddress: Address;
  available: () => Promise<bigint>; // treasury.available() — the cap layer
  fundOperator: (treasury: Address, amount: bigint) => Promise<Hex>; // enclave-sent
  operatorTransferUsdc: (usdc: Address, to: Address, amount: bigint) => Promise<Hex>; // enclave-sent
  depositToGateway: (amountUsdc: string) => Promise<unknown>; // pocket-signed (free)
}

/**
 * Move a bounded float treasury -> operator -> pocket -> Gateway, refusing anything over the cap.
 * The enclave signs only `fundOperator` + the forward (O(top-ups)); the pocket signs the deposit (free).
 */
export async function topUpPocket(d: FundingDeps, amount: bigint): Promise<void> {
  if (amount <= 0n) throw new Error("top-up amount must be positive");
  const available = await d.available();
  if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
  await d.fundOperator(d.treasury, amount);
  await d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount);
  await d.depositToGateway(formatUnits(amount, 6));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/funding.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/funding.ts backend/test/payments/funding.test.ts
git commit -m "feat(payments): governed topUpPocket bridge (cap-bounded vault->pocket float)"
```

---

# Phase 2C — The x402 Buyer (the spend path)

> The agent holds no key: the Buyer wraps outbound HTTP so a `402` is routed to the Authority's `/authorize`, then retries the original request with the returned `X‑PAYMENT`. Offline‑testable with an injected `fetch` + a fake Authority.

### Task 2C.1: Extend the Authority seam to carry x402 requirements

**Files:**
- Modify: `backend/src/payments/authority.ts`
- Modify: `backend/src/payments/server.ts`
- Modify: `backend/test/payments/authority.test.ts` (existing fakes), `backend/test/payments/server.test.ts`
- Test: add cases to `backend/test/payments/authority.test.ts`

> The Phase‑1 `signX402` fake returns `{ header, ledgerRef }` and `AuthorizeRequest` is `{ payee, amount, resource }`. The real signer needs the asset/network/timeout from the 402. Extend `AuthorizeRequest` with those fields (policy still keys off `payee`+`amount`), and have `signX402` receive them.

- [ ] **Step 1: Write the failing test** — add to `authority.test.ts`: assert the request's x402 fields reach `signX402`.

```ts
test("threads x402 requirements (asset/network/maxTimeoutSeconds) to signX402", async () => {
  let seen: unknown;
  const d = deps({ signX402: async (req) => { seen = req; return { header: "h", ledgerRef: "r" }; } });
  await authorizePayment(d, {
    payee, amount: 100n, resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002", maxTimeoutSeconds: 60,
  });
  expect(seen).toMatchObject({ network: "eip155:5042002", maxTimeoutSeconds: 60 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/authority.test.ts`
Expected: FAIL — `AuthorizeRequest` has no `asset`/`network`/`maxTimeoutSeconds` (tsc error) or `seen` lacks them.

- [ ] **Step 3: Implement** — extend the interface and pass the fields through. In `authority.ts`:

```ts
export interface AuthorizeRequest {
  payee: Address;
  amount: bigint;
  resource: string;
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}
// signX402 dep stays (req: AuthorizeRequest) => Promise<{ header: string; ledgerRef: string }>;
// authorizePayment already passes `req` straight to d.signX402(req) — no body change needed beyond the type.
```

Update `server.ts` to parse the new fields (default `maxTimeoutSeconds` to 60 if absent):

```ts
const body = (await c.req.json()) as {
  payee: string; amount: string; resource: string;
  asset: string; network: string; maxTimeoutSeconds?: number;
};
const res = await authorizePayment(deps, {
  payee: body.payee as Address, amount: BigInt(body.amount), resource: body.resource,
  asset: body.asset as Address, network: body.network, maxTimeoutSeconds: body.maxTimeoutSeconds ?? 60,
});
```

Update the existing `authority.test.ts`/`server.test.ts` fixtures to include the new fields (`asset`, `network`, `maxTimeoutSeconds`) in their `authorizePayment`/request bodies.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/authority.test.ts test/payments/server.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/authority.ts backend/src/payments/server.ts backend/test/payments/authority.test.ts backend/test/payments/server.test.ts
git commit -m "feat(payments): carry x402 requirements through the authorize seam"
```

### Task 2C.2: The Buyer client

**Files:**
- Create: `backend/src/payments/buyer.ts`
- Test: `backend/test/payments/buyer.test.ts`

- [ ] **Step 1: Write the failing test** — inject a `fetch` that 402s then 200s, and a fake Authority; assert the handshake + that a `policy-denied` Authority means no retry.

```ts
// backend/test/payments/buyer.test.ts
import { expect, test, vi } from "vitest";
import { buyWithX402 } from "../../src/payments/buyer";

const requirements = {
  payTo: "0x00000000000000000000000000000000000000ab",
  maxAmountRequired: "100",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  maxTimeoutSeconds: 60,
};

function fakeFetch(seenHeaders: string[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    seenHeaders.push(xp);
    return new Response(JSON.stringify({ data: "the insight" }), { status: 200 });
  });
}

test("on 402, authorizes then retries with X-PAYMENT and returns the body", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok" }));
  const res = await buyWithX402({ fetchImpl: fakeFetch(seen), authorize }, "https://seller/api/insight");
  expect(await res.json()).toEqual({ data: "the insight" });
  expect(seen).toEqual(["X-PAYMENT-ok"]);
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ payee: requirements.payTo, amount: 100n }));
});

test("a policy-denied authorization does not retry and surfaces the denial", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: false as const, reason: "over-cap" }));
  await expect(buyWithX402({ fetchImpl: fakeFetch(seen), authorize }, "https://seller/api/insight"))
    .rejects.toThrow(/policy-denied: over-cap/);
  expect(seen).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/buyer.test.ts`
Expected: FAIL — cannot find `buyWithX402`.

- [ ] **Step 3: Implement**

```ts
// backend/src/payments/buyer.ts
import type { Address } from "../types";

export interface X402Accept {
  payTo: Address;
  maxAmountRequired: string; // atomic USDC
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}

export interface AuthorizeFn {
  (req: {
    payee: Address; amount: bigint; resource: string;
    asset: Address; network: string; maxTimeoutSeconds: number;
  }): Promise<{ ok: true; header: string } | { ok: false; reason: string }>;
}

export interface BuyerDeps {
  fetchImpl: typeof fetch;
  authorize: AuthorizeFn; // calls the Authority (HTTP) or authorizePayment directly
}

/**
 * Fetch a paywalled resource. On 402, ask the Authority to authorize the required payment; on allow,
 * retry with the X-PAYMENT header. The agent never signs — it can only ask the Authority.
 */
export async function buyWithX402(d: BuyerDeps, url: string, init: RequestInit = {}): Promise<Response> {
  const first = await d.fetchImpl(url, init);
  if (first.status !== 402) return first;

  const body = (await first.json()) as { accepts: X402Accept[] };
  const req = body.accepts[0];
  if (!req) throw new Error("402 had no payment requirements");

  const decision = await d.authorize({
    payee: req.payTo, amount: BigInt(req.maxAmountRequired), resource: url,
    asset: req.asset, network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds,
  });
  if (!decision.ok) throw new Error(`policy-denied: ${decision.reason}`);

  const headers = { ...(init.headers as Record<string, string>), "X-PAYMENT": decision.header };
  return d.fetchImpl(url, { ...init, headers });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/buyer.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/buyer.ts backend/test/payments/buyer.test.ts
git commit -m "feat(payments): x402 Buyer routes 402 through the Authority (no key in the agent)"
```

---

# Phase 2D — The x402 Seller (the earn path, self-hosted verifier)

> Decision (2026‑06‑18): **self‑host Circle's batching verifier.** Install the `@x402/evm` peer the spike flagged, then verify inbound `X‑PAYMENT` with `@circle-fin/x402-batching/server`. The seller returns `402` with its requirements (recipient = the treasury payout, so revenue lands governed), verifies the retry, and serves. Because the `/server` API is not yet installed, this sub‑phase probes the real surface before writing the impl.

### Task 2D.1: Install + probe the server verifier

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install the peer**

```bash
cd backend && npm install @x402/evm
```

- [ ] **Step 2: Probe the `/server` export surface**

Run:
```bash
node -e "const s=require('@circle-fin/x402-batching/server'); console.log('server:', Object.keys(s))"
```
Expected/record: a verifier — likely `BatchEvmScheme` (server variant) or a `verify`/`createFacilitator` export with a `verify(payload, requirements)` method. **Record the exact verify entrypoint + its argument shape**; 2D.3 implements against it. If `/server` still fails to import after installing `@x402/evm`, fall back to the **minimal self‑verify** (recover the EIP‑712 signature with `verifyTypedData` against the `GatewayWalletBatched` domain + check `amount`/`payTo`/`validBefore`) — the same checks the verifier runs — and note the fallback in the commit message.

- [ ] **Step 3: Commit the dep**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(payments): add @x402/evm peer for the self-hosted batching verifier"
```

### Task 2D.2: Seller requirements builder (402 body)

**Files:**
- Create: `backend/src/payments/seller.ts`
- Test: `backend/test/payments/seller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/payments/seller.test.ts
import { expect, test } from "vitest";
import { buildRequirements } from "../../src/payments/seller";

test("builds a 402 requirements body paying the treasury payout in atomic USDC", () => {
  const reqs = buildRequirements({
    price: 50n, payTo: "0x00000000000000000000000000000000000000ab",
    asset: "0x3600000000000000000000000000000000000000", network: "eip155:5042002",
  });
  expect(reqs.accepts[0]).toMatchObject({
    payTo: "0x00000000000000000000000000000000000000ab",
    maxAmountRequired: "50",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
  });
  expect(reqs.accepts[0].maxTimeoutSeconds).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/seller.test.ts`
Expected: FAIL — cannot find `buildRequirements`.

- [ ] **Step 3: Implement**

```ts
// backend/src/payments/seller.ts
import { CIRCLE_BATCHING_SCHEME } from "@circle-fin/x402-batching";
import type { Address } from "../types";

export interface SellerConfig {
  price: bigint; // atomic USDC the agent charges per query
  payTo: Address; // the treasury payout address — revenue lands governed
  asset: Address;
  network: string;
}

/** The 402 body a buyer receives. payTo = treasury payout, so the agent's earnings stay on-chain governed. */
export function buildRequirements(cfg: SellerConfig) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: CIRCLE_BATCHING_SCHEME,
        network: cfg.network,
        asset: cfg.asset,
        payTo: cfg.payTo,
        maxAmountRequired: cfg.price.toString(),
        maxTimeoutSeconds: 60,
      },
    ],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/seller.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/seller.ts backend/test/payments/seller.test.ts
git commit -m "feat(payments): Seller 402 requirements (revenue -> treasury payout)"
```

### Task 2D.3: Verify an inbound X-PAYMENT + the paywall route

**Files:**
- Modify: `backend/src/payments/seller.ts`
- Test: `backend/test/payments/sellerVerify.test.ts`

> Generate a **real** payload with the 2A signer (local key), then assert the verifier accepts it and rejects tampering. The verify entrypoint comes from 2D.1; the test below uses the conceptual contract — adapt the call to the recorded API. (If on the self‑verify fallback, `verifyPayment` recovers the signature against the `GatewayWalletBatched` domain and checks `payTo`/`amount`/`validBefore`.)

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/payments/sellerVerify.test.ts
import { Hono } from "hono";
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { buildPaywall } from "../../src/payments/seller";

const KEY = `0x${"2".repeat(64)}` as const;
const payout = "0x00000000000000000000000000000000000000ab" as const;

async function makeHeader(amount: bigint) {
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(KEY), chainId: 5042002,
    network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract,
  });
  return (await signX402({ payTo: payout, amount, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, maxTimeoutSeconds: 60 })).header;
}

test("paywall: 402 without X-PAYMENT, 200 with a valid one, 402 on a forged/under-priced one", async () => {
  const app = new Hono();
  app.route("/", buildPaywall({
    price: 50n, payTo: payout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network,
    serve: () => ({ answer: "synthesized insight" }),
  }));

  const noPay = await app.request("/api/insight", { method: "GET" });
  expect(noPay.status).toBe(402);

  const ok = await app.request("/api/insight", { method: "GET", headers: { "X-PAYMENT": await makeHeader(50n) } });
  expect(ok.status).toBe(200);
  expect((await ok.json()).answer).toBe("synthesized insight");

  const underpriced = await app.request("/api/insight", { method: "GET", headers: { "X-PAYMENT": await makeHeader(1n) } });
  expect(underpriced.status).toBe(402);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/sellerVerify.test.ts`
Expected: FAIL — cannot find `buildPaywall`/`verifyPayment`.

- [ ] **Step 3: Implement** — `verifyPayment` (using the recorded `/server` verifier or the self‑verify fallback) + `buildPaywall` (a Hono sub‑app). Recipient + price come from `SellerConfig`; `serve` produces the answer.

```ts
// add to backend/src/payments/seller.ts
import { Hono } from "hono";
import { decodeX402Header } from "../adapters/x402/signX402";
// import { <verifier> } from "@circle-fin/x402-batching/server"; // from 2D.1's recorded API

export interface VerifyResult { ok: boolean; reason?: string }

/**
 * Verify an inbound X-PAYMENT against this seller's requirements. Uses Circle's self-hosted batching
 * verifier (recipient/amount/signature/expiry). Replace the body with the recorded /server call;
 * the structural checks below are the self-verify fallback.
 */
export async function verifyPayment(header: string, cfg: SellerConfig): Promise<VerifyResult> {
  let env: ReturnType<typeof decodeX402Header>;
  try {
    env = decodeX402Header(header);
  } catch {
    return { ok: false, reason: "malformed X-PAYMENT" };
  }
  const a = env.payload.authorization;
  if (a.to.toLowerCase() !== cfg.payTo.toLowerCase()) return { ok: false, reason: "wrong recipient" };
  if (BigInt(a.value) < cfg.price) return { ok: false, reason: "underpriced" };
  if (BigInt(a.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: "expired" };
  // signature check: delegate to Circle's /server verifier (recorded in 2D.1) for the GatewayWalletBatched
  // recovery; on the fallback path, verifyTypedData against the batching domain here.
  return { ok: true };
}

export interface PaywallConfig extends SellerConfig {
  serve: (req: Request) => unknown | Promise<unknown>;
  resource?: string; // default "/api/insight"
}

/** A paywalled Hono sub-app: 402 -> verify X-PAYMENT -> serve. */
export function buildPaywall(cfg: PaywallConfig) {
  const app = new Hono();
  const path = cfg.resource ?? "/api/insight";
  app.get(path, async (c) => {
    const header = c.req.header("X-PAYMENT");
    if (!header) return c.json(buildRequirements(cfg), 402);
    const v = await verifyPayment(header, cfg);
    if (!v.ok) return c.json({ ...buildRequirements(cfg), error: v.reason }, 402);
    return c.json((await cfg.serve(c.req.raw)) as Record<string, unknown>, 200);
  });
  return app;
}
```

> The `value < price` check assumes the batching authorization's `value` equals the charged amount. If Circle's verifier owns the amount/recipient checks, call it and drop the structural duplicates — keep one source of truth. Reconcile against 2D.1's recorded API.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/sellerVerify.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/seller.ts backend/test/payments/sellerVerify.test.ts
git commit -m "feat(payments): Seller paywall verifies inbound X-PAYMENT (self-hosted)"
```

---

# Phase 2E — The runnable Authority service (wire the real seams)

> Replace Phase‑1's faked `readTreasury`/`signX402` with the real ones and expose a runnable server. `readTreasury` reuses the `guardianFreeze.int.test.ts` composition (the four `ArcAdapter` reads); `signX402` is `makeSignX402` over the pocket. The agent (Buyer) talks to this over HTTP.

### Task 2E.1: `buildAuthorityService(cfg)` — compose real deps

**Files:**
- Create: `backend/src/payments/service.ts`
- Test: `backend/test/payments/service.test.ts`

- [ ] **Step 1: Write the failing test** — build the service from injected primitives (real adapter/signer are exercised in 2F; here assert wiring: allow→200, guardian/over‑cap→402, and that an allowed authorize records the ledger).

```ts
// backend/test/payments/service.test.ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { PaymentLedger } from "../../src/payments/ledger";
import { buildAuthorityService } from "../../src/payments/service";

const payee = "0x00000000000000000000000000000000000000ab" as const;
const usdc = "0x3600000000000000000000000000000000000000" as const;
function bodyFor(amount: string) {
  return JSON.stringify({ payee, amount, resource: "/x", asset: usdc, network: "eip155:5042002", maxTimeoutSeconds: 60 });
}

test("buildAuthorityService wires readTreasury + signX402 + ledger behind POST /authorize", async () => {
  const db = new Database(":memory:"); migrate(db);
  const ledger = new PaymentLedger(db);
  const { app } = buildAuthorityService({
    ledger,
    readTreasury: async () => ({ available: 1_000n, paused: false, allowlistEnabled: false, isAllowed: true }),
    signX402: async () => ({ header: "X-PAYMENT-real", ledgerRef: "nonce-1" }),
  });

  const ok = await app.request("/authorize", { method: "POST", body: bodyFor("100"), headers: { "content-type": "application/json" } });
  expect(ok.status).toBe(200);
  expect((await ok.json()).header).toBe("X-PAYMENT-real");
  expect(ledger.runningPending()).toBe(100n);

  const denied = await app.request("/authorize", { method: "POST", body: bodyFor("100000"), headers: { "content-type": "application/json" } });
  expect(denied.status).toBe(402);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/service.test.ts`
Expected: FAIL — cannot find `buildAuthorityService`.

- [ ] **Step 3: Implement** — a thin composition root that accepts the `AuthorityDeps` and returns the Hono app (so the test injects fakes and the real entrypoint injects live deps).

```ts
// backend/src/payments/service.ts
import type { AuthorityDeps } from "./authority";
import { buildAuthorityApp } from "./server";

export interface AuthorityService {
  app: ReturnType<typeof buildAuthorityApp>;
}

/** Compose the Payment Authority from its deps. The real entrypoint (2E.2) builds live deps; tests inject fakes. */
export function buildAuthorityService(deps: AuthorityDeps): AuthorityService {
  return { app: buildAuthorityApp(deps) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/service.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/service.ts backend/test/payments/service.test.ts
git commit -m "feat(payments): buildAuthorityService composition root"
```

### Task 2E.2: Live entrypoint — wire ArcAdapter + pocket signer from config

**Files:**
- Create: `backend/src/payments/main.ts`
- (No unit test — this is the I/O edge; it is exercised by 2F. Keep it a thin, obviously‑correct wiring of already‑tested pieces.)

- [ ] **Step 1: Write the entrypoint** — build live deps from `loadConfig()` and serve. `readTreasury` mirrors the `guardianFreeze.int.test.ts` composition; `signX402` is `makeSignX402` over the pocket; the treasury address comes from config/CLI (the live agentId‑656785 entity).

```ts
// backend/src/payments/main.ts
import "dotenv/config";
import { serve } from "@hono/node-server"; // add dep in this task if not present (see step 2)
import Database from "better-sqlite3";
import { http, createPublicClient } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { arcBatchingConfig, pocketSignerFromKey } from "../adapters/x402/pocket";
import { makeSignX402 } from "../adapters/x402/signX402";
import { anvilChain } from "../chains";
import { loadConfig } from "../config/env";
import { migrate } from "../persistence/db";
import { PaymentLedger } from "./ledger";
import { buildAuthorityService } from "./service";
import type { Address } from "../types";

async function main() {
  const cfg = loadConfig();
  if (!cfg.pocketPrivateKey) throw new Error("POCKET_PRIVATE_KEY required to run the Authority");
  const treasury = (process.env.TREASURY_ADDRESS ?? "") as Address;
  if (!treasury) throw new Error("TREASURY_ADDRESS required (the live entity's AgentTreasury)");

  const pub = createPublicClient({ chain: anvilChain, transport: http(cfg.rpcUrl) });
  const adapter = new ArcAdapter({
    publicClient: pub, managerWallet: undefined as never, chainId: cfg.chainId,
    factory: (cfg.factoryAddress ?? "0x0") as Address, identityRegistry: cfg.identityRegistry,
  });

  const db = new Database(cfg.dbPath);
  migrate(db);

  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(cfg.pocketPrivateKey), chainId: cfg.chainId,
    network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract,
  });

  const { app } = buildAuthorityService({
    ledger: new PaymentLedger(db),
    readTreasury: async (who) => ({
      available: await adapter.treasuryAvailable(treasury),
      paused: await adapter.treasuryPaused(treasury),
      allowlistEnabled: await adapter.treasuryAllowlistEnabled(treasury),
      isAllowed: await adapter.treasuryIsAllowed(treasury, who),
    }),
    signX402: async (req) => signX402({
      payTo: req.payee, amount: req.amount, asset: req.asset, network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds,
    }),
  });

  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port });
  console.log(`Payment Authority listening on :${port} (treasury ${treasury})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the Node server adapter + a run script**

```bash
cd backend && npm install @hono/node-server
```
Add to `package.json` scripts: `"authority": "tsx src/payments/main.ts"`.

> `anvilChain` is reused only for its viem `Chain` shape; on the live path its `id` must equal `cfg.chainId` (5042002). If it does not, build the chain inline (as in `operatorWallet.ts`) instead of importing `anvilChain`. Verify `src/chains.ts` and adjust.

- [ ] **Step 3: Smoke-run** (manual, not CI)

Run: `cd backend && TREASURY_ADDRESS=<live-treasury> npm run authority` → logs "listening on :8787". `Ctrl-C` to stop. Then `npm run typecheck && npm run lint`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/payments/main.ts backend/package.json backend/package-lock.json
git commit -m "feat(payments): runnable Payment Authority entrypoint (live deps)"
```

---

# Phase 2F — End-to-end (buy + sell), settlement opt-in

> Two coherent end‑to‑end proofs in one script. **Default (no money):** the Buyer drives the Seller's `402`→`X‑PAYMENT`→`200` handshake through the real Authority + real `signX402` (pocket key), all in‑process — proving spend and earn compose. **`--settle` (spends testnet USDC):** run `topUpPocket` (governed bridge, real `fundOperator` if Turnkey is configured) + a real Gateway‑settled buy, printing an Arc tx hash. Mirrors `spike-x402-gateway.mts`'s opt‑in pattern.

### Task 2F.1: Offline end-to-end (buyer ↔ authority ↔ seller)

**Files:**
- Create: `backend/test/payments/e2e.int.test.ts`

- [ ] **Step 1: Write the test** — wire the real Seller paywall, the real `makeSignX402`, the real `authorizePayment`, and the real Buyer; assert a within‑policy buy returns the served answer and an over‑cap buy is denied (no settlement — the signature/verify path is real, money is not moved).

```ts
// backend/test/payments/e2e.int.test.ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { authorizePayment } from "../../src/payments/authority";
import { buyWithX402 } from "../../src/payments/buyer";
import { PaymentLedger } from "../../src/payments/ledger";
import { buildPaywall } from "../../src/payments/seller";
import { migrate } from "../../src/persistence/db";
import { privateKeyToAccount } from "viem/accounts";

const KEY = `0x${"2".repeat(64)}` as const;
const payout = privateKeyToAccount(`0x${"f".repeat(63)}1`).address;

function makeStack(available: bigint) {
  const seller = buildPaywall({ price: 50n, payTo: payout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, serve: () => ({ answer: "synthesized insight" }) });
  const signX402 = makeSignX402({ signer: pocketSignerFromKey(KEY), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
  const db = new Database(":memory:"); migrate(db);
  const deps = {
    ledger: new PaymentLedger(db),
    readTreasury: async () => ({ available, paused: false, allowlistEnabled: false, isAllowed: true }),
    signX402: async (req: { payee: `0x${string}`; amount: bigint; asset: `0x${string}`; network: string; maxTimeoutSeconds: number }) =>
      signX402({ payTo: req.payee, amount: req.amount, asset: req.asset, network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds }),
  };
  const fetchImpl = ((url: string, init?: RequestInit) => seller.request(url, init)) as unknown as typeof fetch;
  const authorize = async (r: Parameters<typeof authorizePayment>[1]) => authorizePayment(deps as never, r);
  return { fetchImpl, authorize };
}

test("a within-policy query buys -> serves the insight", async () => {
  const { fetchImpl, authorize } = makeStack(1_000n);
  const res = await buyWithX402({ fetchImpl, authorize }, "/api/insight");
  expect(res.status).toBe(200);
  expect((await res.json()).answer).toBe("synthesized insight");
});

test("an over-cap query is denied at the Authority (killer moment, no settlement)", async () => {
  const { fetchImpl, authorize } = makeStack(10n); // available < price
  await expect(buyWithX402({ fetchImpl, authorize }, "/api/insight")).rejects.toThrow(/policy-denied: over-cap/);
});
```

- [ ] **Step 2: Run** — `cd backend && npx vitest run test/payments/e2e.int.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 3: Commit**

```bash
git add backend/test/payments/e2e.int.test.ts
git commit -m "test(payments): offline end-to-end buy+sell through the real Authority"
```

### Task 2F.2: Live settlement spike (opt-in)

**Files:**
- Create: `backend/scripts/spike-x402-e2e.mts`

- [ ] **Step 1: Write the spike** — default prints the offline handshake summary; `--settle` runs the governed top‑up + a real Gateway‑settled buy. Reuse `PocketGateway`, `topUpPocket`, `makeSignX402`, the Seller, and `ArcAdapter` from config.

```ts
// backend/scripts/spike-x402-e2e.mts — exploratory; SPENDS TESTNET USDC only with --settle.
import "dotenv/config";
import { loadConfig } from "../src/config/env";
import { PocketGateway } from "../src/adapters/x402/gateway";

async function main() {
  const cfg = loadConfig();
  if (!cfg.pocketPrivateKey) throw new Error("POCKET_PRIVATE_KEY required");
  const gw = new PocketGateway({ pocketPrivateKey: cfg.pocketPrivateKey, rpcUrl: cfg.rpcUrl });
  console.log("pocket:", gw.address, "| gateway available:", await gw.getAvailable(), "USDC");

  if (!process.argv.includes("--settle")) {
    console.log("(offline) run the vitest e2e for the buy+sell handshake; re-run with --settle to move USDC.");
    return;
  }

  // --settle: governed bridge (real fundOperator if Turnkey is set) + a real settled buy.
  // 1) topUpPocket(...) using ArcAdapter(operatorWallet) + gw.deposit  (see backend/src/payments/funding.ts)
  // 2) buyWithX402(...) against a live seller URL; the pocket-signed authorization settles via Gateway batch.
  // Print the resulting mint/settlement tx hash + arcscan link (cf. spike-x402-gateway.mts Task 0.3).
  throw new Error("fill in the --settle path from funding.ts + buyer.ts once a live seller URL is chosen");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run offline** — `cd backend && npx tsx scripts/spike-x402-e2e.mts` → prints the pocket address + Gateway available balance, no money moved.

- [ ] **Step 3: (Opt-in, manual) Run live** — `LIVE_SETTLE=1 npx tsx scripts/spike-x402-e2e.mts --settle` after pre‑seeding the operator with gas USDC. Verify the printed tx on `https://testnet.arcscan.app/tx/<hash>`. Record the hash in the findings doc.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/spike-x402-e2e.mts
git commit -m "spike(payments): end-to-end e2e harness (offline default, --settle opt-in)"
```

### Task 2F.3: Update the findings + memory

**Files:**
- Modify: `docs/research/2026-06-16-x402-gateway-spike-findings.md` (append a Phase‑2 section: the recorded `/server` verify API, the X‑PAYMENT encoder, and any live‑settlement tx hash)
- Modify: `docs/README.md` (index this plan)

- [ ] **Step 1: Append the Phase‑2 wiring findings** (the two probe results from 2A.4 + 2D.1, and the live tx hash if `--settle` was run).

- [ ] **Step 2: Commit**

```bash
git add docs/research/2026-06-16-x402-gateway-spike-findings.md docs/README.md
git commit -m "docs(payments): record Phase-2 wiring findings + index the plan"
```

**Phase 2 gate:** full suite green (`npm test`), tsc + biome clean. Offline e2e proves spend+earn compose through the real Authority; `--settle` proves a real governed, pocket‑signed settlement on Arc. The two demo killer moments are now real: **policy‑reject** (over‑cap buy denied — 2F.1) and **guardian‑freeze** (already proven in Phase 1's `guardianFreeze.int.test.ts`, now over the real signer).

---

## Self-Review

- **Spec coverage** (design §5 new components): #1 Payment Authority Service → Phase 1 + 2C.1/2E. #2 x402 Buyer → 2C.2. #3 x402 Seller → 2D. #5 Treasury↔Gateway funding bridge → 2B (pulled forward per the 2026‑06‑18 decision). The concrete non‑custodial `signX402` (findings doc seam) → 2A. §4.1 pocket/vault tiering → pocket signs per‑payment (2A.3/2A.5), enclave signs only top‑ups (2B). #4 Insight Agent (Claude loop) → **Phase 3** (not this plan). #6 Dashboard → **Phase 4**. The two killer moments (§7) → 2F.1 (policy‑reject) + Phase 1 (guardian‑freeze, now real).
- **Placeholder scan:** the only deliberately‑deferred specifics are SDK surfaces that are not installed/known yet — the X‑PAYMENT encoder (2A.4) and the `@circle-fin/x402-batching/server` verify entrypoint (2D.1), each gated behind an explicit probe step with a recorded fallback (manual base64 envelope; self‑verify via `verifyTypedData`). The `--settle` live path (2F.2) is intentionally a spike, not a unit. These mirror the repo's established Phase‑0 spike pattern, not hidden TODOs.
- **Type consistency:** `BatchEvmSigner`/`SignedX402`/`X402Requirements` (2A.2) are consumed unchanged by `makeSignX402` (2A.5), `pocket.ts` (2A.3), and the seller/buyer. `AuthorizeRequest` gains `asset`/`network`/`maxTimeoutSeconds` (2C.1) and `authorizePayment` already forwards `req` to `signX402` — no body change. `FundingDeps.{fundOperator,operatorTransferUsdc}` (2B.4) match the `ArcAdapter` method signatures (2B.1). `topUpPocket` formats atomic→decimal for `PocketGateway.deposit` (2B.3/2B.4). `decodeX402Header` (2A.5) is reused by the seller (2D.3) and tests — one encoder/decoder pair.
- **Scope flag:** this plan pulls the funding bridge (originally Phase 4) into Phase 2 per the user's decision; it adds the new "enclave sends txs" capability (2B.2) and a one‑time operator gas‑seed on the live path. If the timeline tightens, 2B and 2D are the cleanest to defer (2A→2C→2E gives a working spend path + stubbed earn side). Phase 3 (Claude agent) and Phase 4 (dashboard) remain separate plans.
