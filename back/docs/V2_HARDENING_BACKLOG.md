# V2 Hardening Backlog

Deferred items surfaced during Phase-2 backend implementation (the onboarding "brain") and the
Phase-1 contract audit. **None of these block the demo / testnet v1** — they are documented here so
they are not forgotten and can be prioritized for a production-grade v2. Each item notes where it was
found, why it's acceptable for v1, and the fix direction.

Status legend: 🔴 correctness/safety · 🟠 robustness/ops · 🟡 cleanup/cosmetic

---

## Onboarding saga (`backend/src/workflow/onboarding.ts`)

- 🔴 **create→persist double-mint window** (M5.1 review). If the process dies AFTER the `createEntity`
  tx mines but BEFORE the `'created'` upsert, a resume re-mints a SECOND agentId (the first entity +
  treasury are orphaned). `repo.transaction()` cannot close this — the gap is between an on-chain
  effect and its first persistence.
  *v1 ok because:* single trusted operator, testnet, narrow window, documented in the saga docstring.
  *Fix:* split `ArcAdapter.createEntity` into broadcast/confirm; persist the broadcast txHash BEFORE
  awaiting the receipt; on resume, look up that tx / scan `EntityCreated` and adopt the existing
  agentId instead of re-minting. (Ideally also a deterministic on-chain idempotency salt if the
  factory can dedup.)

- 🔴 **concurrency: no key-claim lock** (M5.1 review). Two concurrent `runOnboarding(key)` calls both
  pass `findByIdempotencyKey` (returns undefined) and both mint. The PK on `idempotency_key` does NOT
  protect — `upsert` is `ON CONFLICT DO UPDATE`, which resolves rather than rejects.
  *v1 ok because:* run exactly one onboarding worker per key.
  *Fix:* claim the key first (`INSERT ... ON CONFLICT DO NOTHING`, treat `changes()==0` as "owned by
  another runner") or an advisory lock keyed by idempotencyKey, before any on-chain call.

- 🟠 **key-wins semantics / no spec-hash compare** (M5.1 review). Re-running a key reuses the stored
  record and silently ignores a changed spec (different cap/guardian/payout). Worse if re-run while
  still `translating`: `upsert` blindly overwrites the record with the new spec, then mints it.
  *v1 ok because:* callers are told not to reuse a key with a different spec (docstring).
  *Fix:* store a spec hash on the record; on re-run, throw `IdempotencyConflict` if the incoming spec
  differs (for any non-completed status); warn/no-op for completed.

- 🟠 **status not monotonic at the DB layer** (M5.1 review). The SQLite CHECK constrains status to the
  enum but does not prevent writing it backward; `upsert` has no monotonic guard.
  *Fix:* reject backward transitions in `upsert` (or a guarded `advanceStatus`).

- 🟡 **`rec.field!` non-null assertions** (M5.1 review). Sound given the status→field invariants, but the
  type system can't prove them; an external writer or a future refactor could turn `!` into a runtime
  `undefined` passed to a contract call.
  *Fix:* small `assertTranslated(rec)` / `assertCreated(rec)` narrowing helpers (or a zod refinement).

## On-chain binding (`backend/src/adapters/arc/`)

- 🔴 **AgentWalletSet signature replay within the deadline** (M4.2 review; confirmed against verified
  live source). The canonical registry's `AgentWalletSet` typehash carries NO nonce and the signature
  is not consumed — an authorized caller can replay it until its deadline. Same class as the deferred
  Phase-1 policy-nonce item.
  *v1 ok because:* deadlines are short (chain time + 30 min, max 1h) and the manager is trusted.
  *Fix:* this is a property of the canonical contract (not ours to change); keep deadlines short and
  treat each signature as one-shot. Revisit if/when the registry adds a nonce.

- 🟠 **re-bind after a crash** (M4.2 / M5.1 review). Crash between the `setAgentWallet` tx mining and the
  `'bound'` upsert → resume re-binds the same operator. On the mock this succeeds (idempotent set); on
  the LIVE registry the re-set behavior is unconfirmed — it could emit a duplicate event or revert
  (wedging the saga at `created`).
  *Fix:* a fork test against the live registry to confirm re-set behavior; if it reverts, make the
  bind step tolerate "already bound to this wallet" as success.

- 🟡 **`readContract(...) as Promise<...>` casts** (M3.4 review). The generated ABIs are `as const`, so
  viem already infers the return types; the casts are redundant and would mask a future ABI change.
  *Fix:* drop the casts on the read helpers.

## Types / validation (`backend/src/`)

- 🟠 **`formationDate` is a JS `number` end-to-end** (M3.4 review). uint64 unix-seconds are within
  `Number.MAX_SAFE_INTEGER`, so no precision loss for realistic dates, but `BigInt(<non-integer>)`
  throws (`RangeError`).
  *Fix:* validate integer-ness at the spec boundary, or carry `formationDate` as `bigint`.

## Phase-1 contracts (from the 2026-06-11 audit, still deferred)

- 🔴 **policy nonce** — replay protection for policy actions (related to the bind-replay item above).
- 🟠 **storage gap** — reserve `__gap` slots in upgradeable contracts before adding state.
- 🟠 **live `register()` fork-test** — exercise the real ERC-8004 registry register path on a fork.
- 🟡 **`via_ir` bytecode re-review** — review the IR-optimized bytecode before mainnet.

## Static-analysis hygiene (Slither + Aderyn, 2026-06-30 security pass)

Low / informational source-level nits surfaced by the 2026-06-30 static-analysis pass. None is a security issue; all touch contract source, so they are Martin's call. Deferred as a batch rather than fixed this pass (see `docs/audit/2026-06-30-contracts-security-pass.md`).

- 🟡 **index `PolicyUpdated` address param** (`AgentTreasury.sol:85`). The event has an `address` parameter that is not `indexed`, so off-chain consumers cannot filter by it.
  *Fix:* mark the address parameter `indexed`.
- 🟡 **local variables shadow state variables** (`AgentTreasury.sol:44-47`, the policy-setter params `cap` / `period` / `payoutAddress` / `allowlistEnabled`). Compiles correctly but hurts readability.
  *Fix:* rename the locals (e.g. a leading underscore).
- 🟡 **`nonReentrant` is not the first modifier** (`AgentTreasury.spend/fundOperator/emergencyWithdraw`, `LegalManager.sweep/sweepNative`). v1 ok because the preceding access modifiers (`onlyOperator` / `onlyGuardian`) make no external calls, so there is no through-modifier reentrancy.
  *Fix:* reorder `nonReentrant` to first if adopting the defensive convention.
- 🟡 **unspecific pragma `^0.8.24`** (all `src/*.sol`). A floating pragma can compile under an unintended compiler.
  *Fix:* pin to `0.8.24` before mainnet.
- 🟡 **`available()` public but unused internally** (`AgentTreasury.sol:132`).
  *Fix:* mark `external` (minor gas / clarity).

## Deployment / ops

- 🟠 **beacon owner → multisig/timelock** (`addresses.arc-testnet.json`). Today `beaconOwner == deployer`
  (a testnet MetaMask key). Move to a multisig/timelock before production — it controls upgrades.

## Deferred features (not bugs)

- **M4.3 `TurnkeySigner`** (enclave key) — the production non-custodial `OperatorSigner`. Deferred until
  real Turnkey creds + an SDK API re-check are available. Tracked separately; `LocalKeySigner` covers
  v1/anvil. The live operator key is the point where this becomes required.

## Wizard API (`backend/src/routes/`)

- 🟠 **Nonce burn-on-attempt** — The SIWE nonce is burned on successful verification, so a valid nonce
  survives bad-signature attempts until its 10-minute TTL. A brute-force or replay attacker can keep
  trying until the window expires.
  *v1 ok because:* nonces are random 128-bit hex; timing attacks are impractical within 10 min.
  *Fix:* burn the nonce on first use regardless of signature outcome if abuse is observed.

- 🟡 **`POST /entities/:id/fund` returns 202 with status `'bound'` (pre-fund)** — The funding endpoint
  returns 202 immediately with the entity's current status (`bound`) before any funds arrive. Pollers
  cannot distinguish "funding in progress" from "not yet funded".
  *Fix:* introduce a transient `'funding'` status that the saga sets before broadcasting the fund tx and
  clears to `'funded'` on confirmation, giving pollers a meaningful intermediate state.

- ✅ **AUTH_JWT_SECRET / WEB_ORIGIN fail-closed in production (done 2026-06-21)** — A startup guard now
  throws if either key retains its insecure dev default when `NODE_ENV === "production"`.
  *Future:* revisit cookie-session option (httpOnly, SameSite) and add rate limiting (e.g. express-rate-limit)
  before production traffic hits the SIWE auth routes.

---

## Before any LIVE bind / mainnet — pre-flight (mostly DONE)

- ✅ Live EIP-712 domain verified (`ERC8004IdentityRegistry` / v1) and `AgentWalletSet` typehash verified
  against the verified impl source (2026-06-15). The builder + mock match live.
- ⬜ Re-confirm with a live `setAgentWallet` simulate once a live agentId exists (belt-and-suspenders).
