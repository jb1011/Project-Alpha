# BYOA P0 — Per-Agent Float + WebAuthn Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the two security prerequisites that gate spend-capable Bring-Your-Own-Agent (BYOA):
(1) replace the single **global shared pocket key** with a **per-agent, deterministically-derived** pocket +
a **sweep** that keeps its standing balance ~zero, so agents' un-governed float never commingles; and
(2) **bind the WebAuthn guardian-passkey challenge** server-side (defense-in-depth on top of Turnkey's own
attestation verification).

**Architecture:** The x402 nanopayment "pocket" (a local hot EOA that signs Gateway deposits + x402 without
touching the Turnkey enclave) is today one global key (`POCKET_PRIVATE_KEY`) shared across every tenant.
We derive it **per entity** from a `POCKET_MASTER_SEED` (`keccak256(seed ‖ entityKey)`), fund it
**just-in-time**, and **sweep the pocket EOA residual back to the treasury** after use (Gateway-held funds
can't be withdrawn via the current SDK wrapper, so deposits stay JIT-minimal). Separately, the guardian
passkey (root of the per-agent Turnkey vault) is verified by Turnkey at `createSubOrganization`; we add
server-side challenge issue/consume + `clientDataJSON` challenge/origin checks so a stale or unbound
challenge is rejected before storage.

**Tech Stack:** TypeScript, Hono, better-sqlite3, viem, `@circle-fin/x402-batching`, Turnkey, vitest, Biome
(no build step, tsx). Arc testnet (chainId 5042002; USDC native gas at `0x3600…`).

## Global Constraints

- **Branch:** `feat/byoa-model-a` (the design spec + this plan live here). Off `main`.
- **Additive / no regressions:** the existing nanopayment `liveRunner` flow and all current tests stay green.
  `POCKET_PRIVATE_KEY` support is *removed* in favour of `POCKET_MASTER_SEED` — update every call site.
- **Per-agent isolation is the invariant:** two different `entityKey`s MUST derive two different pocket
  addresses; the same `entityKey` MUST derive the same address (deterministic).
- **Never log or redact-leak** the master seed or any derived key (`env.ts` redaction already covers
  `pocketPrivateKey`; extend to `pocketMasterSeed`).
- **Turnkey verifies the attestation** (it is the WebAuthn RP for the sub-org; a forged/invalid attestation
  fails `createSubOrganization`). Our challenge-binding is *defense-in-depth + freshness*, documented as such.
- **Lint/typecheck/tests:** `npm run lint && npm run typecheck && npm test` all green before each commit.
- Run commands from `back/backend/`.

---

## File Structure

- `src/adapters/x402/pocketDerivation.ts` (**new**) — `derivePocketKey(masterSeed, entityKey)`; one job: key derivation.
- `src/config/env.ts` (**modify**) — replace `POCKET_PRIVATE_KEY`→`POCKET_MASTER_SEED`; `pocketMasterSeed?: Hex`.
- `src/payments/pocketFloat.ts` (**new**) — `sweepPocketToTreasury(...)`; the pocket-EOA residual sweep.
- `src/agent/liveRunner.ts` (**modify**) — `fundPocket` derives the per-agent pocket from `entityKey`; sweep after the run.
- `src/persistence/challengeStore.ts` (**new**) — `ChallengeStore` (mirror `NonceStore`): tenant-scoped issue/consume.
- `src/persistence/db.ts` (**modify**) — additive `webauthn_challenges` table migration.
- `src/api/routes/passkey.ts` (**modify**) — GET issues+persists a tenant challenge; POST consumes + verifies clientDataJSON.
- `src/api/app.ts` (**modify**) — wire `ChallengeStore` into `ApiDeps`/passkey routes.
- `src/adapters/turnkey/provisioner.ts` (**modify, doc only**) — document that Turnkey verifies the attestation.

---

### Task 1: `derivePocketKey` — per-agent pocket key derivation

**Files:**
- Create: `src/adapters/x402/pocketDerivation.ts`
- Test: `test/adapters/x402/pocketDerivation.test.ts`

**Interfaces:**
- Produces: `derivePocketKey(masterSeed: Hex, entityKey: string): Hex` — deterministic 32-byte private key,
  distinct per `entityKey`.

- [ ] **Step 1: Write the failing test** — `test/adapters/x402/pocketDerivation.test.ts`:

```ts
import { expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { derivePocketKey } from "../../../src/adapters/x402/pocketDerivation";

const seed = `0x${"11".repeat(32)}` as const;

test("is deterministic for the same entityKey", () => {
  expect(derivePocketKey(seed, "agent-A")).toBe(derivePocketKey(seed, "agent-A"));
});

test("differs per entityKey (no commingling)", () => {
  expect(derivePocketKey(seed, "agent-A")).not.toBe(derivePocketKey(seed, "agent-B"));
});

test("differs per seed", () => {
  const seed2 = `0x${"22".repeat(32)}` as const;
  expect(derivePocketKey(seed, "agent-A")).not.toBe(derivePocketKey(seed2, "agent-A"));
});

test("yields a valid 32-byte private key usable by viem", () => {
  const k = derivePocketKey(seed, "agent-A");
  expect(k).toMatch(/^0x[0-9a-f]{64}$/);
  expect(privateKeyToAccount(k).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/adapters/x402/pocketDerivation.test.ts` → FAIL ("Cannot find module").

- [ ] **Step 3: Implement** — `src/adapters/x402/pocketDerivation.ts`:

```ts
import { concat, keccak256, toBytes } from "viem";
import type { Hex } from "../../types";

/**
 * Deterministically derive a per-agent pocket private key from one master seed + the entity key.
 * Per-agent isolation (distinct addresses, no commingling), no per-agent key storage. keccak256 output is
 * always 32 bytes and is a valid secp256k1 scalar with overwhelming probability.
 */
export function derivePocketKey(masterSeed: Hex, entityKey: string): Hex {
  return keccak256(concat([toBytes(masterSeed), toBytes(entityKey)]));
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/adapters/x402/pocketDerivation.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(pocket): derive per-agent pocket key from a master seed"`

---

### Task 2: Config — replace `POCKET_PRIVATE_KEY` with `POCKET_MASTER_SEED`

**Files:**
- Modify: `src/config/env.ts` (the `POCKET_PRIVATE_KEY` schema line ~26, the `pocketPrivateKey` field ~65,
  the mapping ~131, the redaction ~179)
- Test: `test/config/pocketKey.test.ts` (exists — repurpose/extend for the seed)

**Interfaces:**
- Produces: `Config.pocketMasterSeed?: Hex`; env var `POCKET_MASTER_SEED` (32-byte hex).

- [ ] **Step 1: Write the failing test** — extend `test/config/pocketKey.test.ts` (mirror how it currently
  asserts `pocketPrivateKey`; if it constructs a base env object, add `POCKET_MASTER_SEED`):

```ts
test("POCKET_MASTER_SEED loads into cfg.pocketMasterSeed and is optional", () => {
  const seed = `0x${"ab".repeat(32)}`;
  expect(loadConfig({ ...base, POCKET_MASTER_SEED: seed }).pocketMasterSeed).toBe(seed);
  expect(loadConfig(base).pocketMasterSeed).toBeUndefined();
});
```
(If the file asserts `pocketPrivateKey` elsewhere, replace those assertions with `pocketMasterSeed`.)

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/config/pocketKey.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/config/env.ts`:
  - Replace the env schema line `POCKET_PRIVATE_KEY: privKeySchema.optional(),` with
    `POCKET_MASTER_SEED: privKeySchema.optional(),`.
  - Replace the `Config` field `pocketPrivateKey?: Hex;` with `pocketMasterSeed?: Hex;`.
  - Replace the mapping `pocketPrivateKey: e.POCKET_PRIVATE_KEY,` with `pocketMasterSeed: e.POCKET_MASTER_SEED,`.
  - Replace the redaction `pocketPrivateKey: cfg.pocketPrivateKey ? "REDACTED" : undefined,` with
    `pocketMasterSeed: cfg.pocketMasterSeed ? "REDACTED" : undefined,`.
  (`privKeySchema` already validates a 32-byte 0x-hex; reuse it — a seed has the same shape.)

- [ ] **Step 4: Run typecheck to find call sites** — `npm run typecheck` → expect errors in `liveRunner.ts`
  (uses `cfg.pocketPrivateKey`). Leave those for Task 3; the config test should pass:
  `npx vitest run test/config/pocketKey.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(config): POCKET_MASTER_SEED replaces POCKET_PRIVATE_KEY"`
  (typecheck is red until Task 3 — note this in the commit body; do NOT run the full suite yet.)

---

### Task 3: `fundPocket` derives the per-agent pocket (retire the global key)

**Files:**
- Modify: `src/agent/liveRunner.ts` (`fundPocket` ~140-182; `buildLiveAgentRunner` call site; the two
  `if (!cfg.pocketPrivateKey)` guards ~146/189 and the `pocketSignerFromKey(cfg.pocketPrivateKey)` ~211)
- Test: `test/agent/liveRunner.test.ts` (exists) — add a derivation-wiring assertion

**Interfaces:**
- Consumes: `derivePocketKey` (Task 1), `Config.pocketMasterSeed` (Task 2).
- Produces: `fundPocket(cfg, treasury, floatAtomic, operatorWallet, entityKey: string)` — same behaviour,
  pocket derived per-agent.

- [ ] **Step 1: Add a `requireMasterSeed` helper + failing test.** In `test/agent/liveRunner.test.ts` add:

```ts
test("fundPocket derives a per-agent pocket address from the entityKey", async () => {
  const { derivePocketKey } = await import("../../src/adapters/x402/pocketDerivation");
  const { privateKeyToAccount } = await import("viem/accounts");
  const seed = `0x${"cd".repeat(32)}` as const;
  const expected = privateKeyToAccount(derivePocketKey(seed, "entity-1")).address;
  // The pocket address the funding path targets must equal the per-agent derived address:
  expect(privateKeyToAccount(derivePocketKey(seed, "entity-1")).address).toBe(expected);
  expect(privateKeyToAccount(derivePocketKey(seed, "entity-2")).address).not.toBe(expected);
});
```
(This asserts the derivation contract the wiring must honour; the full on-chain path stays covered by the
gated live test.)

- [ ] **Step 2: Run, expect pass on the derivation contract** — `npx vitest run test/agent/liveRunner.test.ts -t "per-agent pocket"` (the assertion holds once Task 1 is in).

- [ ] **Step 3: Implement the wiring.** In `src/agent/liveRunner.ts`:
  - Add near the top-level helpers:

```ts
import { derivePocketKey } from "../adapters/x402/pocketDerivation";

/** The pocket master seed is required to derive a per-agent pocket. */
function requireMasterSeed(cfg: Config): Hex {
  if (!cfg.pocketMasterSeed) throw new Error("set POCKET_MASTER_SEED to run the funding bridge");
  return cfg.pocketMasterSeed;
}
```
  - Change `fundPocket`'s signature to append `entityKey: string`, and replace the pocket construction:

```ts
export async function fundPocket(
  cfg: Config,
  treasury: Address,
  floatAtomic: bigint,
  operatorWallet: WalletClient,
  entityKey: string,
): Promise<Hex[]> {
  const pocketKey = derivePocketKey(requireMasterSeed(cfg), entityKey);
  // ... createPublicClient + ArcAdapter unchanged ...
  const gateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });
  // ... topUpPocket call unchanged (pocketAddress: gateway.address) ...
}
```
  - Delete the `if (!cfg.pocketPrivateKey) throw …` guard in `fundPocket` (now `requireMasterSeed`).
  - In `buildLiveAgentRunner`: pass the resolved `entity.idempotencyKey` into `fundPocket(...)`, and replace
    the customer/pocket signer construction `pocketSignerFromKey(cfg.pocketPrivateKey)` with
    `pocketSignerFromKey(derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey))`, and the
    `if (!cfg.pocketPrivateKey)` guard at ~189 with `requireMasterSeed(cfg)`.

- [ ] **Step 4: Typecheck + full suite green** — `npm run typecheck && npm run lint && npm test` → all PASS
  (no more `pocketPrivateKey` references; existing deterministic tests unaffected).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(pocket): fundPocket uses the per-agent derived pocket"`

---

### Task 4: Sweep the pocket EOA residual back to the treasury

**Files:**
- Create: `src/payments/pocketFloat.ts`
- Test: `test/payments/pocketFloat.test.ts`

**Interfaces:**
- Consumes: `ArcAdapter.usdcBalanceOf` (exists), a pocket `WalletClient`.
- Produces: `sweepPocketToTreasury(deps: SweepDeps): Promise<Hex | null>` — transfers the pocket's residual
  USDC to the treasury; returns the tx hash, or `null` if the balance is at/below the dust floor.

- [ ] **Step 1: Write the failing test** — `test/payments/pocketFloat.test.ts` (inject deps, no chain):

```ts
import { expect, test, vi } from "vitest";
import { sweepPocketToTreasury } from "../../src/payments/pocketFloat";

const treasury = `0x${"aa".repeat(20)}` as const;
const usdc = `0x${"bb".repeat(20)}` as const;

function deps(balance: bigint) {
  return {
    treasury, usdc, dust: 10_000n, // 0.01 USDC floor
    pocketUsdcBalance: vi.fn(async () => balance),
    transferToTreasury: vi.fn(async () => "0xswept" as const),
  };
}

test("sweeps the full residual when above the dust floor", async () => {
  const d = deps(250_000n);
  const h = await sweepPocketToTreasury(d);
  expect(d.transferToTreasury).toHaveBeenCalledWith(treasury, 250_000n);
  expect(h).toBe("0xswept");
});

test("no-ops at/below the dust floor (leaves gas)", async () => {
  const d = deps(10_000n);
  const h = await sweepPocketToTreasury(d);
  expect(d.transferToTreasury).not.toHaveBeenCalled();
  expect(h).toBeNull();
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/payments/pocketFloat.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `src/payments/pocketFloat.ts`:

```ts
import type { Address, Hex } from "../types";

export interface SweepDeps {
  treasury: Address;
  usdc: Address;
  dust: bigint; // leave this much behind (gas reserve on Arc = USDC)
  pocketUsdcBalance: () => Promise<bigint>;
  transferToTreasury: (treasury: Address, amount: bigint) => Promise<Hex>; // pocket-signed ERC-20 transfer
}

/** Sweep the pocket EOA's residual USDC back to the treasury, keeping standing float ~zero.
 *  Gateway-held balance is NOT withdrawable via the current SDK wrapper — keep deposits JIT-minimal. */
export async function sweepPocketToTreasury(d: SweepDeps): Promise<Hex | null> {
  const bal = await d.pocketUsdcBalance();
  if (bal <= d.dust) return null;
  return d.transferToTreasury(d.treasury, bal);
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/payments/pocketFloat.test.ts` → PASS (2 tests).

- [ ] **Step 5: Wire the sweep into the live run.** In `src/agent/liveRunner.ts`, after the run completes,
  build the pocket wallet client from the derived key and call `sweepPocketToTreasury` with:
  `pocketUsdcBalance: () => adapter.usdcBalanceOf(cfg.usdc, pocketAddress)`,
  `transferToTreasury: (to, amt) => pocketWallet.writeContract({ address: cfg.usdc, abi: erc20TransferAbi,
  functionName: "transfer", args: [to, amt] })` (mirror `arcAdapter.operatorTransferUsdc`'s simulate+write),
  `dust: 10_000n`. (No new test for the wiring — the gated live test exercises it; unit coverage is Step 1.)

- [ ] **Step 6: Typecheck + suite** — `npm run typecheck && npm run lint && npm test` → PASS.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(pocket): sweep the pocket residual back to treasury (float ~zero)"`

---

### Task 5: `ChallengeStore` — tenant-scoped WebAuthn challenge issue/consume

**Files:**
- Create: `src/persistence/challengeStore.ts`
- Modify: `src/persistence/db.ts` (add the `webauthn_challenges` table in `migrate`, mirroring `auth_nonces`)
- Test: `test/persistence/challengeStore.test.ts`

**Interfaces:**
- Produces: `ChallengeStore { issue(tenantId, now, ttlMs): string; consume(tenantId, challenge, now): boolean }`.

- [ ] **Step 1: Add the migration.** In `src/persistence/db.ts`, in `migrate`, mirror the `auth_nonces`
  create-table with:

```ts
db.exec(
  "CREATE TABLE IF NOT EXISTS webauthn_challenges (" +
  "challenge TEXT PRIMARY KEY, owner_tenant TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
);
```

- [ ] **Step 2: Write the failing test** — `test/persistence/challengeStore.test.ts` (mirror the nonceStore test style):

```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteChallengeStore } from "../../src/persistence/challengeStore";

function store() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteChallengeStore(db);
}

test("issues then consumes once (burn-on-consume), tenant-scoped", () => {
  const s = store();
  const ch = s.issue("tenantA", 1_000, 60_000);
  expect(s.consume("tenantB", ch, 2_000)).toBe(false); // wrong tenant
  expect(s.consume("tenantA", ch, 2_000)).toBe(true); // ok, and burns it
  expect(s.consume("tenantA", ch, 3_000)).toBe(false); // already consumed
});

test("rejects an expired challenge (and burns it)", () => {
  const s = store();
  const ch = s.issue("tenantA", 1_000, 10);
  expect(s.consume("tenantA", ch, 2_000)).toBe(false); // expired
});
```

- [ ] **Step 3: Run, expect fail** — `npx vitest run test/persistence/challengeStore.test.ts` → FAIL.

- [ ] **Step 4: Implement** — `src/persistence/challengeStore.ts` (mirror `SqliteNonceStore`, add tenant scope):

```ts
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface ChallengeStore {
  issue(tenantId: string, now: number, ttlMs: number): string;
  consume(tenantId: string, challenge: string, now: number): boolean;
}

/** Single-use, TTL-bounded, tenant-scoped WebAuthn registration challenges. */
export class SqliteChallengeStore implements ChallengeStore {
  constructor(private readonly db: Database.Database) {}

  issue(tenantId: string, now: number, ttlMs: number): string {
    const challenge = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO webauthn_challenges (challenge, owner_tenant, issued_at, expires_at) VALUES (?,?,?,?)",
      )
      .run(challenge, tenantId, now, now + ttlMs);
    return challenge;
  }

  /** True iff the challenge existed for this tenant and was unexpired; deletes it either way. */
  consume(tenantId: string, challenge: string, now: number): boolean {
    const row = this.db
      .prepare("SELECT owner_tenant, expires_at FROM webauthn_challenges WHERE challenge = ?")
      .get(challenge) as { owner_tenant: string; expires_at: number } | undefined;
    this.db.prepare("DELETE FROM webauthn_challenges WHERE challenge = ?").run(challenge);
    return !!row && row.owner_tenant === tenantId && row.expires_at > now;
  }
}
```

- [ ] **Step 5: Run, expect pass** — `npx vitest run test/persistence/challengeStore.test.ts` → PASS (2 tests).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(passkey): tenant-scoped WebAuthn challenge store"`

---

### Task 6: Passkey route — issue a bound challenge, verify it on registration

**Files:**
- Modify: `src/api/routes/passkey.ts`
- Modify: `src/api/app.ts` (add `challenges: ChallengeStore` to `ApiDeps`; construct `SqliteChallengeStore`)
- Modify: `src/adapters/turnkey/provisioner.ts` (doc comment: Turnkey verifies the attestation)
- Test: `test/api/passkey.route.test.ts` (create if absent; mirror an existing route test's app setup)

**Interfaces:**
- Consumes: `ChallengeStore` (Task 5), `deps.passkeyRpId`, `deps.siweDomain`.
- Behaviour: `GET /passkey/challenge` now **requires auth**, issues a tenant-scoped challenge (TTL 10 min),
  returns `{ challenge, rpId }`. `POST /passkey` **consumes** the submitted challenge for the tenant (reject
  if unknown/expired) and verifies `clientDataJSON.type === "webauthn.create"`, `.challenge === submitted`,
  and `.origin`'s host === `deps.passkeyRpId`, before storing.

- [ ] **Step 1: Write the failing test** — `test/api/passkey.route.test.ts`. Build the app as other route
  tests do (find one, e.g. `test/api/schema.route.test.ts`, and copy its `buildApp`/deps harness + a helper
  to mint a JWT for a tenant). Assert:

```ts
test("POST /passkey rejects an unbound challenge", async () => {
  // auth as tenantA; do NOT issue a challenge first
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: "not-a-real-challenge",
      attestation: { credentialId: "c", clientDataJson: b64urlClientData("not-a-real-challenge"), attestationObject: "o", transports: [] },
    }),
  });
  expect(res.status).toBe(400);
});

test("POST /passkey accepts a freshly issued, matching challenge", async () => {
  const { challenge } = await (await app.request("/passkey/challenge", { headers: { Authorization: `Bearer ${jwt}` } })).json();
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      challenge,
      attestation: { credentialId: "c", clientDataJson: b64urlClientData(challenge), attestationObject: "o", transports: [] },
    }),
  });
  expect(res.status).toBe(201);
});
```
where `b64urlClientData(ch)` = `Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: ch, origin: "http://localhost" })).toString("base64url")` and the test deps set `passkeyRpId: "localhost"`.

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/api/passkey.route.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `src/api/routes/passkey.ts`:
  - Make `GET /passkey/challenge` require auth and issue a bound challenge:

```ts
app.get("/passkey/challenge", requireAuth(deps.jwtSecret), (c) => {
  const challenge = deps.challenges.issue(c.get("tenantId"), Date.now(), 10 * 60_000);
  return c.json({ challenge, rpId: deps.passkeyRpId });
});
```
  - In `POST /passkey`, after `GuardianPasskeySchema.parse(raw)` and before `deps.passkeys.store(...)`:

```ts
const tenantId = c.get("tenantId");
if (!deps.challenges.consume(tenantId, pk.challenge, Date.now()))
  throw new ApiError("validation_error", 400, "unknown or expired passkey challenge");
verifyClientData(pk.attestation.clientDataJson, pk.challenge, deps.passkeyRpId); // throws ApiError on mismatch
```
  - Add the `verifyClientData` helper in the same file:

```ts
function verifyClientData(clientDataJsonB64: string, expectedChallenge: string, rpId: string): void {
  let cd: { type?: string; challenge?: string; origin?: string };
  try {
    cd = JSON.parse(Buffer.from(clientDataJsonB64, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("validation_error", 400, "malformed clientDataJSON");
  }
  if (cd.type !== "webauthn.create")
    throw new ApiError("validation_error", 400, "clientDataJSON type must be webauthn.create");
  if (cd.challenge !== expectedChallenge)
    throw new ApiError("validation_error", 400, "clientDataJSON challenge mismatch");
  let host: string;
  try {
    host = new URL(cd.origin ?? "").hostname;
  } catch {
    throw new ApiError("validation_error", 400, "invalid clientDataJSON origin");
  }
  if (host !== rpId)
    throw new ApiError("validation_error", 400, "clientDataJSON origin does not match rpId");
}
```
  - `import { requireAuth } from "../../auth/middleware";` is already present; add `Buffer` is a Node global.

- [ ] **Step 4: Wire `ChallengeStore` into `ApiDeps`.** In `src/api/app.ts`: add `challenges: ChallengeStore`
  to the `ApiDeps` interface, construct `new SqliteChallengeStore(db)` where the other stores are built, and
  pass `deps` through to `mountPasskeyRoutes` (already receives `deps`). Update `src/api/main.ts` if it
  constructs `ApiDeps` explicitly.

- [ ] **Step 5: Document the Turnkey dependency.** In `src/adapters/turnkey/provisioner.ts`, above the
  `createSubOrganization` call, add:

```ts
// SECURITY: Turnkey is the WebAuthn RP for this sub-org and verifies the guardian attestation here — a
// forged/invalid attestation fails sub-org creation and can never control the vault (no private key behind
// it). Our POST /passkey challenge-binding (src/api/routes/passkey.ts) is defense-in-depth + freshness.
```

- [ ] **Step 6: Full gate** — `npm run typecheck && npm run lint && npm test` → all PASS (incl. the new
  passkey route tests; existing passkey/onboard tests updated for the auth'd challenge endpoint if they call it).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(passkey): bind + verify the WebAuthn registration challenge server-side"`

---

## Client contract note (for the frontend colleague + `tools/passkey-capture`)

The browser must now (1) call the **authenticated** `GET /passkey/challenge` and (2) use the returned
`challenge` in the WebAuthn `navigator.credentials.create` ceremony (today `tools/passkey-capture` generates
its own local challenge — it must switch to the server challenge), then submit that same `challenge`. Origin
must match `PASSKEY_RP_ID`. This is a coordinated change; the backend rejects unbound challenges once Task 6
lands, so the capture tool + frontend passkey step update together.

## Self-Review

**Spec coverage (§14.3 prerequisites):** #1 per-agent minimal float → Tasks 1–4 (derive per-agent key +
JIT + sweep, global key retired); #4 WebAuthn verification → Tasks 5–6 (challenge issue/consume + clientData
checks) + the documented Turnkey-verifies dependency. The ⚠ fast-follows (#3 key separation, #7 guardian
alerting, #8 payload-scoped Turnkey policy) are NOT in P0 — they are separate plans. ✓
**Placeholders:** every code step has complete code; no TBD/TODO. ✓
**Type consistency:** `derivePocketKey(masterSeed: Hex, entityKey: string): Hex` used identically in Tasks
1/3/4; `ChallengeStore.issue/consume` signatures match between Tasks 5 and 6; `cfg.pocketMasterSeed`
consistent across Tasks 2/3. ✓
**Known follow-ups (not P0):** Gateway-held float can't be swept via the current SDK wrapper — keep deposits
JIT-minimal (documented in `pocketFloat.ts`); if Gateway withdrawal is later wrapped, extend the sweep.
