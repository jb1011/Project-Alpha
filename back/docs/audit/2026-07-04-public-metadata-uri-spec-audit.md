# Public Metadata URI — Spec Audit

**Date:** 2026-07-04 · **Target:** `back/docs/design/2026-07-04-public-metadata-uri-design.md`
**Method:** context7 doc-verification (Hono cors/middleware) + 2 Sonnet codebase-lens auditors (fidelity/
correctness, adversarial security), each verifying spec claims against the real `back/backend` code.

## Headline
The core architecture is **sound**: the riskiest claim — a `publicId` minted in the *translating* step
survives a resume and bakes on-chain exactly once — was traced and **confirmed** (behaves like the proven
`createTxHash` preservation). `arcAdapter` passes `metadataURI` through unchanged; `/metadata` is genuinely
outside the auth paths; the metadata JSON has no *keys*. **But** two of the spec's security claims are
incomplete — "no path traversal" (the traversal is via the DB-derived key, not the `publicId` URL param) and
"nothing sensitive exposed" (the `ein` field) — plus four implementation gaps that would crash the boot,
fail to compile, or 500-instead-of-404.

## Must-fix (fold into the spec before planning)

**M1 — Migration ordering will crash boot on the existing prod DB.** (fidelity) `CREATE UNIQUE INDEX … public_id`
must be placed **after** the guarded `ALTER TABLE entities ADD COLUMN public_id` (mirroring the
`payments_ledger.entity_key` block at `db.ts:209-216`), NOT inside the initial unconditional `db.exec` like
`idx_entities_agent_id` (an original column). On the live DB the column doesn't exist until the ALTER runs;
indexing it first throws `no such column: public_id` → service won't boot.

**M2 — `EntityRecord.publicId` needs 2 more call sites than the spec names.** (fidelity) Two places build a
*complete* `EntityRecord` literal (not a spread): `onboarding.ts:88-116` (Step-0 provisioned row) and
`runner.ts:36-59` (initial pending record). Add `publicId: null` to both (matches the existing explicit-null
style), or the branch won't compile.

**M3 — `docStore.get()` throws on a missing file; it won't auto-404.** (fidelity) `documentStore.ts:31` does
`readFileSync` → `ENOENT` (a `.code` error, not `.status`), which `apiOnError` turns into a **500**, not the
spec's "Missing file → 404." The route handler must `try { … } catch { throw new ApiError("not_found", 404) }`.

**M4 — Thread `metadataBaseUrl` into the CLI onboard path too.** (fidelity) `src/cli/index.ts:35-44` also calls
`runOnboarding(...)`; if missed, the CLI bakes a localhost URL (or fails to compile). `CliContext.cfg` already
carries the full config — one-line fix, but the spec's enumeration omits it.

**S1 — Path traversal via the unsanitized entity key/name (CRITICAL).** (security) `AgentSpecSchema.name`
(`agentSpec.ts:48`) and the caller-supplied `idempotencyKey` (`onboard.ts:33`) are unrestricted strings — no
`/` or `..` check. They flow into `key = tenantId:userKey` → `docStore.put(\`meta-${key}.json\`)` →
`FileDocumentStore` does a raw `join(root, id)` (`documentStore.ts:25,31`) with no containment. A SIWE-auth'd
(no-KYC) tenant can plant a record whose meta file lands on a traversed path, and the **new public route serves
it, unauthenticated, to the whole internet**. The spec's "no traversal" reasoning only covers the raw
`:publicId` param, never the provenance of the DB key. This is a pre-existing doc-store weakness that the new
route **amplifies from a self-write bug into a world-readable oracle**. **Fix:** allowlist-validate the
name/`idempotencyKey` used to form filenames (e.g. `^[A-Za-z0-9._-]{1,128}$`) at the onboard boundary (protects
the OA doc filename too), and/or hash the key before using it as a filename.

**S3 — CORS override fails for preflight (OPTIONS).** (security + context7) The global
`app.use("*", cors({origin: webOrigin}))` (`app.ts:65`) **short-circuits OPTIONS itself, before the handler**,
and won't emit ACAO if the Origin ≠ `webOrigin` — so any cross-origin browser fetch that triggers a preflight is
blocked, contradicting "any origin/tool may fetch." (For simple non-preflighted GETs the handler's
`c.header('ACAO','*')` does win — but that's not enough.) **Fix:** a path-scoped `cors({origin:"*"})` mounted on
`/metadata/*` (so it handles OPTIONS), or an `origin` callback on the global cors returning `*` when
`c.req.path` starts with `/metadata/`. This replaces the spec's `c.header` approach.

**S4 — Prod fail-closed guard is too blunt.** (security) Substring `localhost`/`127.0.0.1` misses `0.0.0.0`,
IPv6 loopback, other 127/8, non-`https`, and an explicitly-empty `METADATA_BASE_URL=` bypasses both zod's
`.default()` and the check. Inconsistent with sibling URL vars that use `z.string().url()`. **Fix:**
`METADATA_BASE_URL: z.string().url()`, require `https://` in prod, and reject loopback/private hosts by parsing
the URL (not substring). Given the value is baked permanently on-chain, under-strict here is a real risk.

## Decision needed (genuine product call)

**S2 — the `ein` (business tax ID) would be world-published, unauthenticated, and unvalidated.** (security)
`legal.ein` is `z.string().optional()` with **no format validation** (`agentSpec.ts:74`) and is emitted verbatim
in the served JSON (`generator.ts:82-87`). Risks: (a) a user could paste an SSN believing it's "like an EIN,"
now permanently crawlable + on-chain with no takedown; (b) even a real EIN becomes a one-GET machine-readable
profile (a large practical exposure jump vs. its current form as ABI-encoded on-chain calldata). Options:
**(A)** drop `ein` from the served JSON (it stays in the OA doc behind the on-chain `oaHash`, so legal
verifiability is preserved without broadcasting it); **(B)** keep it but enforce an EIN format regex + warn at
onboard that it's permanently public. → surfaced to the user.

## Notes (defense-in-depth / roadmap, non-blocking)
- **S5** — first fully-public route doing synchronous SQLite + `readFileSync`; a flood can stall the event loop
  for *all* routes. `Cache-Control: public, max-age=300` only helps if an upstream CDN caches. Consider a rate
  limit / edge cache later; not a v1 blocker.
- **S6** — `publicId`/`metadataURI` persist at the pre-`createEntity` step, so a failed registration can leave a
  live URL for an agent with no on-chain identity. Low exploitability (owner-only visibility early).
- **S7** — enumeration is a non-issue (122-bit UUID); tenant↔publicId correlation is already possible on-chain.

## Verdict
Architecture is plan-able, but **not as written**: fold in M1–M4 + S1/S3/S4 (S1 is the important one — it turns a
latent doc-store traversal into a public oracle), and resolve the S2 (EIN) decision. Then re-review.
