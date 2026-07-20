# S1 — `fund_treasury` Authorization: `provision` Capability + Funding Caps — Design

**Date:** 2026-07-20 · **Area:** `back/backend` (Hono/TS) + `interface` (copy only) · **Type:** security hardening (V2 audit S1)

Closes audit finding S1: the platform manager wallet (`PLATFORM_PRIVATE_KEY`) can be drained into any tenant's treasury by any key holding the `spend` capability, with no per-call or per-tenant bound; and `spend` conflates "pay third parties" with "provision platform resources". Latent today (single-tenant testnet — the platform wallet is the operator's own), critical for multi-tenant.

## Goal

Make moving **platform** USDC (funding a treasury, creating an entity) a distinct, opt-in privilege (`provision`) above `spend`, and bound every treasury-funding path with a per-call cap and a per-tenant lifetime quota — mirroring the `run_job` guard class ("audit fix A") — without breaking a single existing key or flow.

---

## The vulnerability (verified 2026-07-20 against `main`)

**The unbounded lever.** `src/mcp/server.ts:328-347` — the `fund_treasury` tool gates only on `hasCapability(scope,"spend")` (L336) and `entityInScope(scope,id)` (L338), then calls `runner.fund({ id, tenantId, amount: BigInt(amount) })` (L341). Tenant ownership is checked inside `OnboardingRunner.fund` (`src/workflow/runner.ts:79`). Nothing anywhere validates or bounds `amount`:

- No per-call cap, no per-tenant quota, no aggregate ceiling. The saga's Step 7 (`src/workflow/onboarding.ts:295-300`) passes the amount straight to `arcAdapter.fundTreasury` (`src/adapters/arc/arcAdapter.ts:230-243`), which is a plain ERC-20 `transfer` **from `managerWallet`** — the `PLATFORM_PRIVATE_KEY` account.
- `BigInt(amount)` at `server.ts:341` even accepts hex (`"0x..."`); a negative amount silently no-ops (the `fundAmount > 0n` guard at `onboarding.ts:295` skips Step 7 but the saga still "succeeds"). `pay` and `fund_pocket` both have the `/^-?\d+$/` + positive validation (`server.ts:174-183`, `213-222`); `fund_treasury` has neither.

**Attack (multi-tenant):** any tenant mints a `spend` key (it's the *default*: `connection.ts:10,15` zod defaults, `apiKeyStore.ts:56` mint default, and `POST /api-keys` at `api/routes/apiKeys.ts:14` mints tenant-wide `spend` with no way to say otherwise) → `fund_treasury(id, <platform wallet's entire USDC balance>)` → their treasury now holds platform funds → spend to a payee they control via `pay`/`fund_pocket` within their own policy caps, or simply repeat.

**Second unguarded surface (not in the original finding):** REST `POST /entities/:id/fund` (`src/api/routes/onboard.ts:55-70`) reaches the same `runner.fund` gated only by the SIWE/JWT session — also unbounded. Any fix that only patches the MCP tool leaves this open, so the ceiling must live at the shared choke point.

**The conflation.** `spend` today grants: `pay` (entity's own treasury, on-chain-capped), `fund_pocket` (entity's own treasury → its Gateway float, bounded by the on-chain `fundOperator` cap), **and** `fund_treasury` + `onboard_agent` (`server.ts:336`, `366`) — which move *platform* funds / create entities and consume platform gas + Turnkey provisioning. Two privilege levels, one rung.

**Precedent.** `run_job` got exactly this guard class: `maxJobBudget` + `maxInflightJobsPerTenant` (`server.ts:262-276`, REST twin `api/routes/jobs.ts:25`, config `env.ts:50-51`, defaults `"5"` / `3`).

---

## Fix design

### 1. Capability model: new top rung `provision`

Extend the existing **ordered ladder** (no orthogonal flag): `read < earn < spend < provision`.

Why a ladder extension, not an orthogonal capability: the privilege *is* strictly ordered in this product — a key that can pull platform funds into a treasury it operates can effectively spend, so "provision but not spend" has no use case; and the single `capability TEXT` column, `hasCapability`, both mint surfaces, and the frontend selector all assume one ordered value. Orthogonality buys nothing and costs every surface.

**`src/mcp/scope.ts`** — the only ladder change:

```ts
const LEVEL: Record<Capability, number> = { read: 0, earn: 1, spend: 2, provision: 3 };
```

**`src/persistence/apiKeyStore.ts:13`**:

```ts
export type Capability = "read" | "earn" | "spend" | "provision";
```

`mint`'s `opts.capability ?? "spend"` default (L56) and the `COALESCE(...,'spend')` fallbacks in `verify`/`list` (L82, L89) are **unchanged** — least privilege stays the default; `provision` is always explicit.

**Per-tool required capability (the complete matrix):**

| Tool / route | Today | After S1 | Why |
|---|---|---|---|
| `fund_treasury` (MCP) | `spend` + `entityInScope` | **`provision`** + `entityInScope` (+ ownership in `runner.fund`, unchanged) | moves platform USDC |
| `onboard_agent` (MCP) | `spend` + tenant-wide (`entityId === null`) | **`provision`** + tenant-wide (gate shape unchanged) | creates entity; platform gas + Turnkey provisioning |
| `fund_pocket` (MCP) | `spend` | `spend` (unchanged) | moves the entity's OWN treasury funds, bounded on-chain by the `fundOperator` cap; the embedded gas-seed does touch the platform wallet but is bounded to `GAS_SEED_TARGET_USDC` dust (~0.2 native) — acceptable at `spend` |
| `pay`, `run_job`, all reads | unchanged | unchanged | |
| REST `POST /onboard`, `POST /entities/:id/fund` | SIWE/JWT session | session (no capability gate added) | the browser session IS the human controller — the highest trust level; MCP capabilities scope *delegated agent keys*, not the controller. The funding **caps still apply** via `runner.fund` (below) |

Concrete edits in `src/mcp/server.ts`:
- L336: `if (!hasCapability(scope, "spend"))` → `if (!hasCapability(scope, "provision"))` in `fund_treasury`. Keep the uniform `"not found"` error text.
- L366: `if (!hasCapability(scope, "spend") || scope.entityId !== null)` → `if (!hasCapability(scope, "provision") || scope.entityId !== null)` in `onboard_agent`.
- `fund_treasury` additionally gains the same amount validation as `fund_pocket` (`/^-?\d+$/` test, `BigInt` in try/catch, `> 0n`) **before** calling `runner.fund` — closes the hex/negative sloppiness. Uniform error strings: `"invalid amount"` / `"amount must be positive"`.
- Update the gate-triad comment block (L44-50) and the two tool descriptions to say `provision`.

### 2. Back-compat / migration: one-shot promote of existing effective-`spend` keys

**Decision: a guarded, one-time SQL backfill that promotes every existing key whose effective capability is `spend` (stored `'spend'` or legacy `NULL`) to `provision`.** This is strictly behavior-preserving and grants nothing new:

- Tenant-wide `spend` keys (incl. the live prod bootstrap key `bootstrap:e81ca24a…` that today onboards AND funds) could already call both acting tools → after promotion they still can. **Nothing breaks.**
- Entity-scoped `connect:` `spend` keys could already `fund_treasury` their own entity (and never `onboard_agent`, blocked by the tenant-wide gate) → after promotion, same powers, no more.
- Keys minted **after** the change get the split: `spend` no longer provisions; `provision` must be explicitly selected at mint. The security win applies to all new keys; no tenant re-mints anything.

Alternatives rejected: (a) *no migration* breaks the flagship agent-first bootstrap flow (tenant-wide key onboard+fund) and the advertised entity-scoped "fund this treasury" flow — unacceptable; (b) *gating provisioning behind the web session only* removes the agent-first `onboard_agent` MCP flow entirely — that flow is the product ("BYOA"); (c) *default-`provision`-on-mint* would perpetuate the conflation for all future keys.

**Mechanics.** `migrate()` (`src/persistence/db.ts:15`) runs on every boot and is guarded today by column-existence checks; a *data* migration needs an explicit marker. Add a `meta` table and guard the backfill on it:

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Then, in `migrate()` after the existing additive `api_keys` column migrations (`db.ts:202-204`):

```ts
const done = db.prepare("SELECT value FROM meta WHERE key = ?").get("apikey_capability_provision_backfill");
if (!done) {
  db.transaction(() => {
    db.exec("UPDATE api_keys SET capability = 'provision' WHERE capability IS NULL OR capability = 'spend'");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, '1')").run("apikey_capability_provision_backfill");
  })();
}
```

The marker is essential: without it, a re-run would promote keys deliberately minted as `spend` after the change. Revoked rows are included (cosmetic only — `verify()` excludes them; the dashboard badge then shows what the key *could* do, which is honest).

**Mint surfaces** (`src/api/routes/connection.ts`):
- `BodySchema` / `BootstrapSchema` (L10, L15): `z.enum(["read","earn","spend","provision"]).default("spend")` — defaults unchanged.
- `POST /api-keys` (`src/api/routes/apiKeys.ts:6-16`): accept an optional `capability` body field validated with the same enum, default `"spend"`, passed to `mint`. (Today this surface silently mints tenant-wide `spend`; post-change such keys can pay but not provision — the bootstrap/connection surfaces are the provisioning mint path.)

**Frontend (same PR, `interface/`)** — types + copy only, no flow change:
- `interface/src/lib/api/types.ts:134`: add `"provision"` to the `Capability` union.
- `interface/src/components/agents/capabilityCopy.ts`: add to `TENANT_CAPABILITIES` only: `{ value: "provision", label: "Provision", description: "Spend + fund treasuries from the platform + create new agent legal bodies across your tenant." }`; reword tenant `spend` to `"Earn + pay via x402 across your tenant."` and entity `spend` to `"Earn + pay via x402, within this treasury's caps/allowlist."` (both currently advertise the powers that moved). `ENTITY_CAPABILITIES` does **not** offer `provision` (an entity-scoped provision key is accepted by the API but is not a flow we advertise). Defaults (`ENTITY_DEFAULT_CAPABILITY = "spend"`, `TENANT_DEFAULT_CAPABILITY = "read"`) unchanged. `BootstrapAgent.tsx`'s `capability === "spend"` warning (L139) becomes `capability !== "read"`.

### 3. Ceilings on treasury funding: per-call cap + per-tenant lifetime quota

**Decision: enforce BOTH, at the single choke point `OnboardingRunner.fund` (`src/workflow/runner.ts:77`),** so the MCP tool and the REST route are covered by one gate (unlike run_job's duplicated route/tool checks).

**Config (`src/config/env.ts`)**, mirroring `MAX_JOB_BUDGET_USDC`:

| Env var | Zod | Config field | Default |
|---|---|---|---|
| `MAX_TREASURY_FUND_USDC` | `z.string().default("25")` | `maxTreasuryFund: bigint` (via `usdToUnits`) | 25 USDC per call |
| `MAX_TREASURY_FUNDED_PER_TENANT_USDC` | `z.string().default("100")` | `maxTreasuryFundedPerTenant: bigint` (via `usdToUnits`) | 100 USDC lifetime per tenant |

Both validated positive by `usdToUnits`; add a cross-check like the gasSeed floor/target one (`env.ts:235-237`): `maxTreasuryFund <= maxTreasuryFundedPerTenant` or throw `Invalid config`. Non-secret, but `redact()` spreads Config — add `.toString()` entries for both (bigints), like `maxJobBudget` at `env.ts:251`.

Defaults rationale: live smoke funding has been 0.5–3 USDC per call; 25/100 is generous testnet headroom while making "drain the wallet" impossible by default. Env-overridable per deployment.

**Quota accounting — no new write path.** Every successful fund already records an event atomically with the tx (`onboarding.ts:303-312`): `events` row with `step='fundTreasury'`, `status='funded'`, `detail = {"amount":"<atomic>"}`, keyed to the entity. Sum it per tenant via the `entities` join. Add to the `EntityRepository` interface (`src/persistence/entityRepository.ts`) and the SQLite impl:

```ts
/** Total atomic USDC ever moved platform->treasuries for this tenant (successful funds only). */
sumFundedByTenant(tenantId: string): bigint;
```

```sql
SELECT COALESCE(SUM(CAST(json_extract(e.detail, '$.amount') AS INTEGER)), 0) AS total
FROM events e JOIN entities t ON t.idempotency_key = e.idempotency_key
WHERE e.step = 'fundTreasury' AND e.status = 'funded' AND t.owner_tenant_id = ?
```

Return `BigInt(total)`. (SQLite 64-bit integer SUM; atomic-USDC totals are nowhere near 2^63. Onboarding Step 7 is the only writer of this step name.) Any in-memory/fake repo used in tests implements it over its event list.

**Enforcement in `OnboardingRunner`** — new **required** constructor dep (fail-closed by construction; the compiler flags every call site):

```ts
constructor(private readonly deps: {
  repo: EntityRepository;
  runSaga: RunSaga;
  fundCaps: { perCall: bigint; perTenantTotal: bigint };
}) {}
```

In `fund()`, after the ownership/status checks (`runner.ts:79-89`) and before scheduling the saga:

```ts
if (p.amount <= 0n) throw new ApiError("validation_error", 400, "amount must be positive");
if (p.amount > this.deps.fundCaps.perCall)
  throw new ApiError("limit_exceeded", 400, "amount exceeds the max treasury fund per call");
const funded = this.deps.repo.sumFundedByTenant(p.tenantId);
if (funded + p.amount > this.deps.fundCaps.perTenantTotal)
  throw new ApiError("limit_exceeded", 400, "tenant treasury funding quota exhausted");
```

Error propagation needs no new handling: the MCP tool's existing try/catch (`server.ts:340-345`) returns `e.message` as `isError`; REST's `ApiError` flows to the standard error handler.

**Wiring.** `api/main.ts:104`: `new OnboardingRunner({ repo, runSaga, fundCaps: { perCall: cfg.maxTreasuryFund, perTenantTotal: cfg.maxTreasuryFundedPerTenant } })`. Test constructors (~10 files, `test/mcp/*.int.test.ts` etc.) get a shared helper constant, e.g. `TEST_FUND_CAPS = { perCall: usdToUnits("25"), perTenantTotal: usdToUnits("100") }`, overridden tight in the cap tests.

**Known TOCTOU (accepted, documented):** the quota reads *committed* fund events; the event is written only after the on-chain tx succeeds, and `inFlight` (`runner.ts:90`) serializes funds per *entity*, not per tenant — concurrent funds across a tenant's entities can overshoot the quota by at most `perCall × (concurrent entities − 1)`. Bounded and acceptable; the platform-wide backstop is S5's job (see Non-goals).

**Self-funding from the tenant's own wallet** (the audit's deeper option): **out of scope for S1, deliberately.** It is the correct multi-tenant end-state (the platform should never be the funding source on command), but it is a product feature — deposit attribution/detection or a permit/transferFrom flow plus UX — not an authz fix, and it lands naturally with the v2 smart-account migration. Note for docs/support meanwhile: the treasury contract is a plain ERC-20 receiver — a tenant can already `transfer` USDC directly to its treasury address out-of-band today; `fund_treasury` is a platform *subsidy* lever, which is exactly why it gets a rung + quota.

---

## Data-flow / back-compat summary

- Existing keys: all effective-`spend` keys → `provision` once, via the guarded backfill. Zero re-mints, zero broken flows (prod tenant-wide bootstrap key keeps onboard+fund).
- New keys: `spend` by default everywhere; `provision` only when explicitly selected (bootstrap flow selector, or explicit `capability` in the three mint bodies).
- Ceilings apply to **both** funding surfaces (MCP tool + REST route) via `runner.fund`; existing behavior below the caps is byte-identical.
- `GET /api-keys` (dashboard badges) needs no change — it already returns the raw `capability` string; the frontend union gains the value.
- DB: one new `meta` table + one one-shot UPDATE; no `api_keys` schema change (column already exists, `db.ts:203`).

## Testing (non-vacuous; extend the named suites)

- **`scope.test`**: `provision` satisfies `spend`/`earn`/`read`; `spend` does **NOT** satisfy `provision`.
- **`test/mcp/actingToolGates.int.test.ts`** (the negatives — the point of S1):
  - tenant-wide `spend` key → `fund_treasury` **rejected** (`"not found"`, `isError`) and `onboard_agent` **rejected** (`"not authorized"`);
  - tenant-wide `provision` key → both succeed (the migrated-bootstrap-key equivalence);
  - entity-scoped `provision` key → `fund_treasury` on its own entity passes the gate; `onboard_agent` still rejected (tenant-wide gate);
  - `fund_treasury` amount `"0x10"` and `"-5"` → rejected before `runner.fund`.
- **Caps** (new `runner`/int tests):
  - `amount > perCall` → MCP `isError` "exceeds the max treasury fund per call" AND REST `POST /entities/:id/fund` → 400 `limit_exceeded` (both surfaces, same gate);
  - quota: with `perTenantTotal = 3 USDC`, fund 2 then fund 2 → second rejected "quota exhausted"; a *failed* first fund (no `funded` event) does **not** consume quota;
  - `sumFundedByTenant` counts only `step='fundTreasury' AND status='funded'` rows and only the target tenant's entities.
- **Migration** (db test): seed `api_keys` rows with capability `NULL`, `'spend'`, `'read'`, and an entity-scoped `'spend'`; run `migrate()` → `NULL`/`'spend'` become `'provision'`, `'read'` untouched; mint a fresh `'spend'` key, run `migrate()` **again** → it stays `'spend'` (marker guard) and the backfilled rows are unchanged (idempotent).
- **Mint surfaces**: `POST /bootstrap-connection` with `capability:"provision"` mints a key that `verify()` returns as `provision` and that passes both acting-tool gates end-to-end; `POST /api-keys` default remains `spend`; all three endpoints reject an unknown capability value (zod 400).
- **Config**: defaults 25/100 parse; `MAX_TREASURY_FUND_USDC > MAX_TREASURY_FUNDED_PER_TENANT_USDC` → `loadConfig` throws; `redact()` stringifies both new bigints.

`npx biome check src test` + `npx tsc --noEmit` clean; full vitest suite green (the required `fundCaps` dep will surface every un-updated constructor at compile time — that is intended).

## Non-goals

- **S5** — the platform-wide **aggregate** outflow ceiling / rate-limit / alerting. Seam for S5: the platform wallet's outflow points are `runner.fund` → `arcAdapter.fundTreasury`, the gasSeeder, the job-escrow funding, and x402 gas — S5 wraps all of them behind one meter; S1's per-tenant quota is the per-actor bound underneath it.
- S2 (x402 path escaping on-chain policy), S3 (`POCKET_MASTER_SEED`), S4 (`PLATFORM_PRIVATE_KEY` overload) — separate audit items.
- First-class tenant self-funding (deposit attribution / permit flow) — v2 smart-account migration; direct ERC-20 transfer to the treasury address works today.
- Per-capability rate limiting, key rotation/expiry UX, MCP-side admin (key mgmt stays REST/session-only).

## Open questions (for Martin)

1. **Cap defaults** — 25 USDC/call and 100 USDC/tenant-lifetime are my calls for the current testnet demo cadence. If an upcoming demo needs a bigger single fund, override the env vars on the VPS; confirm the defaults or name better ones.
2. **Backfill policy** — I chose "promote all existing effective-`spend` keys to `provision`" for zero breakage. If you'd rather force explicit re-mint for *entity-scoped* keys (tightest posture, breaks the advertised entity-key fund flow until re-mint), say so before implementation; the migration predicate simply gains `AND entity_id IS NULL`.
