# BYOA Full-Feature Audit (P0–P4)

**Date:** 2026-07-03 · **Method:** 4 independent parallel Fable audit agents against a local integration
tree (`main` = P0–P2c + P3 #21 + P4 #22 merged, 449 tests green), each on a distinct lens: spec fidelity,
adversarial security, cross-slice correctness, product coherence. This report consolidates + dedupes their
findings and re-prioritizes for prod.

## Headline verdict

**The BYOA custody/governance model is SOUND.** All four audits independently agree: a malicious linked
agent **cannot** reach another tenant's funds or keys, **cannot** overspend its treasury's on-chain leash,
**cannot** bypass the `authorizePayment` chokepoint, **cannot** double-settle, and **no** API key / private
key / seed leaks. The payment chokepoint, tenant isolation on acting tools, capability ladder, SSRF (literals
+ decimal/octal + IPv4-mapped-IPv6), idempotency (signed-vs-unsigned), and magic-link binding (SIWE tenant,
single-use tenant-scoped codes, confirmation-not-key) all hold under trace.

**But the whole-feature view surfaced issues per-slice reviews could not see** — one economic hole, one
broken flagship journey, one operational dead-end, and a read-confinement gap — plus a batch of hardening
items. None break the security core; all should be addressed before "everything running in prod."

Per-lens verdicts: spec = **Yes-with-gaps**; security = **Sound-with-caveats**; cross-slice = **Yes-with-fixes**;
product = **Yes-with-gaps**.

## Confirmed solid (do not re-litigate)
- **Chokepoint:** `pay → entityPayment.pay → buyWithX402 → authorize → authorizePayment → signX402` is the only
  signer path; the pocket signer is built inside `buildAuthorize` and invoked only after `evaluatePolicy` passes.
- **Tenant isolation** on all acting tools; operator/pocket/provider always from the resolved record, never a
  tool arg; uniform not-found (no existence oracle).
- **Payment safety:** atomic idempotency claim; signed-but-unconfirmed is cached not released (no re-sign);
  surprise-price ceiling; returned-payee re-asserted; on-chain nonce single-use.
- **Bootstrap:** SIWE-only tenant on both REST + MCP; wrong-tenant cannot consume/burn a link_code; no key leak.
- **Coherence:** dep threading complete (no NPE path); migrations idempotent on fresh + existing DBs; MCP pay
  composition == liveRunner chokepoint; config fail-closed on JWT/WEB_ORIGIN; `resolveTenant` removal complete.
- Keys stored sha-256 only; secrets redacted in logs; prod boot guard present.

---

## Findings — prioritized for prod

### Tier 1 — fix before enabling the corresponding face in prod

**A. `run_job` budget is uncapped → drains the platform job-funding wallet.** (security I-2, cross-slice #1)
`run_job(budgetUsdc)` (and the REST twin `POST /entities/:id/jobs`) validate only format + `>0`; the escrow is
funded from the **platform** client/evaluator wallet (`JOB_CLIENT_PRIVATE_KEY ?? PLATFORM_PRIVATE_KEY`), released
to the caller's operator and swept to the caller's treasury. An `earn`-key agent can loop `run_job(budgetUsdc:
huge)` and convert platform USDC into its own treasury + starve other tenants. Not a tenant-treasury overspend
or cross-tenant access, but a real economic hole. **Fix:** config max-job-budget + per-tenant quota, enforced in
both surfaces before `jobRunner.start`. `src/mcp/server.ts:188-216`, `src/api/routes/jobs.ts:21`.

**B. Earn→spend loop doesn't close; treasury can't be topped up after first fund.** (product #2/#3, cross-slice #2)
(1) `fund_treasury` works **once** per entity — `runner.fund` requires status `bound`, funding sets `funded`,
later top-ups 409. (2) `pay` settles from the per-agent **pocket/Gateway float**, but NO MCP tool or HTTP route
funds the pocket (`topUpPocket` is only wired into the standalone `liveRunner`); `treasury_status` reads the
treasury, not the pocket. So the first `pay` on any entity not pre-funded out-of-band signs, fails to settle
(empty Gateway), caches an `unconfirmed` receipt (burns the idempotency key), and leaves an unsettleable pending
row. The flagship "earn then spend" story does not close via the tools. **Fix:** a pocket-funding path (JIT
`topUpPocket` in `pay`, or a fund-pocket tool/route + a balance preflight that fails *before* signing) + allow
treasury re-funding after `funded` + surface the float in `treasury_status`. `src/payments/funding.ts:55`,
`src/agent/liveRunner.ts:188`, `src/workflow/runner.ts:81-82`.

**C. Agent-first onboarding is functionally broken — the agent can't author a valid `spec`.** (product #1)
`AgentSpecSchema` requires `roles.manager` = the platform manager wallet, which is **undiscoverable** (not in
`whoami`, the connection package, `schema://agent-spec`, or the docs). A wrong guess onboards on-chain, fails at
bind, and **permanently burns the entity name** (`entityRepository` `ON CONFLICT DO NOTHING` → 409 on retry).
Web-first survives because the frontend fills the spec; agent-first (the story the product is named for) has no
equivalent. **Fix:** default/force `manager` server-side exactly like `guardian` (`server.ts:298`), or include
it in the bootstrap package. `src/mcp/server.ts:296-300`, `src/policy/agentSpec.ts:51`.

**D. `list_entities` + `get_entity` skip `entityInScope` → an entity-scoped key reads sibling entities.**
(security I-1, product #6) Read-only, same-tenant (no spend, no cross-tenant), but it breaks the intra-tenant
blast-radius guarantee entity-scoping is sold on. **Correction to our deferred-list:** the assumption "only
tenant-wide keys are mintable today" is **false** — `/connection-package` mints entity-scoped keys, so this is
**reachable now**. **Fix:** one-line `entityInScope` parity on both tools. `src/mcp/server.ts:94-116`.

**E. P2b ledger `runningPending` unscoped + `markSettled` never called.** (all agents, confirmed as previously
tracked) Fails closed (over-denial DoS, never overspend), but cross-entity/tenant coupling once `pay` is shared.
**Fix (pre-`pay`-enable):** scope `runningPending` per treasury/entity + call `markSettled` on a confirmed 200.
`src/payments/ledger.ts:41-46`, `src/payments/authority.ts:50`.

### Tier 2 — hardening + consistency (before or shortly after prod)

- **`fund_treasury` validation:** bare `BigInt(amount)` accepts hex/negatives; a non-positive amount no-ops as
  `{status:"bound"}` success; no idempotency key. Apply pay's `/^\d+$/` + `>0` (§14.2 boundary validation). Same
  on the REST fund route. `src/mcp/server.ts:262-273`.
- **`whoami` self-discovery:** returns only the tenant address; the agent can't learn its `entityId`/
  `capability`, and a capability-miss returns "not found" for an entity it can simultaneously `get_entity` →
  contradictory, retry-loop-inducing. Enrich `whoami` with `{entityId, capability}`. `src/mcp/server.ts:43-47`.
- **`treasury_status` under-informs the pay decision:** omits spent-in-window (§4.3), `perTxCap`, the §14.1
  threshold, and the pocket float, so the agent can't pre-compute whether a `pay` will pass.
- **`pay` accepts empty `idempotencyKey`** (no min-length) → two `""` payments replay each other. Add `min(1)`.
- **§14.2 audit event on `pay`/`fund`:** not emitted (only ledger rows). Written into §14.2; untracked.
- **API-key TTL never applied:** `apiKeyStore` supports `ttlMs` but no mint surface passes it → all BYOA keys
  non-expiring (§14.2 lists TTL for the spend key). Decide a default or record the exception.
- **`MCP_PUBLIC_URL` no prod check** (defaults `localhost`) → hands agents localhost snippets if unset.
- **`run_job` doomed without `JOB_EVALUATOR_PRIVATE_KEY`** (fallback evaluator==client fails at `complete`);
  no boot gate/warning. Gate the tool like `payments`, or add a prod check.
- **Unit incoherence:** `pay.amountUsdc` + `fund_treasury.amount` are atomic 6-dec integers; `run_job.budgetUsdc`
  is decimal USD — same "Usdc" naming, 10^6 apart. Confusing for agents; align or rename.
- **SSRF DNS-rebinding TOCTOU** (security I-3, documented): blind (response not surfaced → internal probe only,
  no exfiltration). Pin the connection to the validated IP (custom undici dispatcher).
- **`pay` signs the `asset` from the 402** without re-pinning to configured USDC (security M-1): non-exploitable
  today (pocket holds only USDC → non-USDC fails to settle), but re-pin as defense-in-depth. `signX402.ts:76`.
- **Error-string non-uniformity** across tools ("not found" / "entity not found" / "not in this key's scope" /
  "not authorized") — no oracle, but inconsistent envelope.
- **`run_job` on an unbound entity** returns `pending` then fails async instead of a synchronous "not bound yet,
  poll get_entity" (§9). `pay` correctly returns `treasury-not-ready`.
- **`liveRunner` uses `new Database()` not `openDatabase`** → skips `foreign_keys = ON` on that connection.
- **`POST /api-keys`** still mints tenant-wide **spend** keys with no capability/entity/TTL option — a legacy
  full-power mint surface alongside the scoped connection routes. Consider deprecating/scoping it.
- **`requireMasterSeed` duplicated** (entityPayment vs liveRunner); `liveRunner` authorityDeps lacks `threshold`
  (its own buys skip §14.1) — pre-existing.
- **Capability bucketing:** `spend` conflates paying third parties with provisioning (`fund_treasury`,
  `onboard_agent`). A `provision`/`admin` rung (or human-only onboard) would map better to real grants. (Design
  note, not a bug.)

### Confirmed known-deferred (verified not worse)
Non-atomic link_code/challenge `consume` (safe single-process SQLite; atomic `DELETE … RETURNING` if multi-worker);
no expiry sweep; mint-before-issue (key discarded → unusable, harmless); signed-evaluator seam (§14.2 fast-follow);
§14.4 signed policy-decision log ("adopt", currently untracked).

## Recommended pre-prod sequence
The core is validated sound, so this is a hardening pass, not a rework. Suggested order (quick-high-value first):
1. **D** (entityInScope on list_entities/get_entity) — one-liner, closes the reachable read gap.
2. **A** (cap `run_job` budget + quota) — before enabling earn.
3. **C** (default `manager` server-side) — unblocks agent-first onboarding + stops the name-burn.
4. **B** (pocket-funding path + treasury re-fund + float visibility) — makes the operate loop real (bigger).
5. **E** (ledger `runningPending` scope + `markSettled`) — before enabling pay multi-tenant.
6. Tier-2 batch (validation/whoami/treasury_status/audit-event/config guards).
