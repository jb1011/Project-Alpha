# BYOA Frontend Screens — Spec Audit

**Date:** 2026-07-03 · **Target:** `back/docs/design/2026-07-03-byoa-frontend-screens-design.md`
**Method:** 4 independent Sonnet audit agents, each verifying spec claims against the *actual* backend + frontend
code (not the spec's word): (1) contract & pattern fidelity, (2) adversarial security, (3) protocol/convention
compliance, (4) completeness/coherence. Consolidated + deduped below. Findings raised by ≥2 lenses are marked ⭑.

## Headline
The spec is accurate on the mechanical wiring — every backend route/response shape, the challenge single-use,
ownership scoping, snippet keys, and the "McpKeysPanel is the sole consumer" claim all check out. But the
whole-feature view found the design **does not close the flagship agent-first journey**, **omits two
protocol-mandated security-UX requirements** (revocation UI + authorization confirmation), **mischaracterizes
what "spend" grants**, and **depends on a helper that will 401**. Not safe to plan from until the Must-Fix items
are resolved. Also: prompt-injection attempts appeared in tool output during the audit (fake skill-run
reminders + a fake AGENTS.md); all agents correctly ignored them.

## Must-fix (before planning)

**M1 ⭑ — Revocation UI is deleted with no replacement, at the moment two new mint paths are added.** (security,
protocol, completeness) Deleting `McpKeysPanel` removes the *only* UI to list/revoke keys. The backend §14.2 is
an audit-High "keys must be one-click revocable"; `/connection-package` + `/bootstrap-connection` mint
**non-expiring** keys and **discard the `id`** (`connection.ts:39-51,65-78`), so there's nothing to revoke by.
The reset-button copy "invalidating the shown key from view" (design.md:110) *reads* like a security action but
is only a React-state clear — the key stays live. **Fix:** keep a minimal "Active connections" list+revoke
panel (reuse `listApiKeys`/`revokeApiKey` — they still work and share the store; labels are already
`connect:<entityId>` / `bootstrap:<passkeyId>`); do NOT delete those client fns. Fix the misleading copy.

**M2 ⭑ — Missing human-readable authorization confirmation before the bootstrap mint.** (protocol) The backend
design (`2026-07-01-…model-a-design.md:76-79,261-265`, §14.2) and the P3 plan
(`2026-07-03-byoa-p3-agent-first-bootstrap.md:17,273,280`) name this **audit-Critical** and explicitly assign it
to **frontend scope**: before minting, show "you are giving agent-key …X guardian custody of body Y, funded from
wallet Z — confirm." The spec's bootstrap wizard (passkey→capability→generate) mints directly after "Continue"
with no confirmation. **Fix:** add a confirm sub-step between capability and mint, stating in plain language what
is being created (a **tenant-wide**, capability-scoped key + a link code any agent that pastes the code can use).

**M3 — Flagship agent-first journey can't complete: `passkeyId` never surfaced + `onboard_agent` step missing.**
(completeness) `/bootstrap-connection` returns `passkeyId`, and `onboard_agent` *requires* it
(`server.ts:359-363`). But the wizard's "next steps" stop at `claim_connection`, never show `passkeyId`, and
never tell the agent to call `onboard_agent`. Once the screen is left, `passkeyId` is unrecoverable (no
persistence, no picker). The stated goal ("agent drives its own onboarding") is unreachable from the UI. **Fix:**
display `passkeyId` in the result state and extend "next steps" to: paste config → `claim_connection` →
`onboard_agent { passkeyId }` → poll `get_entity` until `bound`.

**M4 — `getPasskeyChallenge()` will 401.** (contract) `GET /passkey/challenge` is now `requireAuth`-gated
(`passkey.ts:20`, added in `044f35f`), but the frontend helper takes no token and sends no `Authorization`
(`client.ts:68-73`). Its existing caller `WelcomeStep.tsx:98` has the same latent bug. **Fix:** add
`getPasskeyChallenge(token)` to the client changes, fix the existing call site, use the token form in bootstrap.

**M5 ⭑ — "spend" capability copy is misleading (understates the grant).** (completeness, security) The UI says
spend = "pay via x402 within caps/allowlist," but `spend` also gates `fund_treasury` (`server.ts:336`) and — on
a **tenant-wide** key (exactly what bootstrap mints) — `onboard_agent` (`server.ts:366`, requires
`entityId===null`). A user granting "spend" over-grants. **Fix:** rewrite the spend description to include
funding + (tenant-wide) creating new legal bodies; differentiate copy between the entity-scoped web-first
selector (onboard unreachable) and the tenant-wide bootstrap selector (onboard reachable).

## Should-fix (cheap hardening; ride along)

- **S1 ⭑ — The spec's `no-store`/`no-referrer` "protection" is false through the proxy.** (security, contract)
  `interface/src/app/backend/[[...path]]/route.ts:35-40` strips every response header except `content-type`, so
  the backend's `noStore()` never reaches the browser. **Fix:** correct the spec; optionally have the proxy set
  `Cache-Control: no-store` for these two paths. (Referrer-Policy on a JSON response is inert anyway.)
- **S2 — Claude Code CLI snippet places a cleartext key in shell history, and is the default selection.**
  (security) New exposure — McpKeysPanel only ever showed JSON config. **Fix:** keep Claude Code as flagship but
  add a visible "this writes your key into your shell history" note by the CLI snippet.
- **S3 — No entity-status gating before minting a web-first connection.** (completeness) `/connection-package`
  checks ownership only; an entity still "Deploying" (pre-`bound`) yields a connection whose `pay`/`run_job` will
  fail opaquely (`runJob.ts:74`, `runner.ts:84`). **Fix:** idle-state warn Callout / disabled Generate when
  `status` ∉ {bound, funded}.
- **S4 — Session staleness across the 3-phase bootstrap.** (completeness) Token captured at passkey phase, used
  at generate; can 401 if idle past TTL. **Fix:** re-`ensureSession()` immediately before the generate POST; add
  the stale-token case to error handling.
- **S5 — Default capability = spend amplifies M1/S2 blast radius.** (security) *Product decision* — the spec
  calls "full-operate" deliberate. Audit recommends defaulting the selector to **read** with explicit opt-up, or
  a stronger confirmation on spend. → surfaced to the user.
- **S6 — Guardian passkey proliferation, no list/revoke.** (security) Every bootstrap run stores a permanent
  guardian anchor; `PasskeyStore` has no delete. **Fix:** explicitly record as accepted risk + tracked backend
  follow-up (list/revoke endpoint), not a silent defer.
- **S7 — mcpUrl misconfig not handled.** (completeness) `MCP_PUBLIC_URL` has no prod guard (env.ts:58; prior
  audit Tier-2). We set it correctly in prod, but **Fix (cheap):** frontend warns if `pkg.mcpUrl` contains
  `localhost`/`127.0.0.1`.
- **S8 — Clipboard has no fallback on insecure/HTTP contexts.** (completeness) `navigator.clipboard` is
  `undefined` on non-secure origins → the copy click throws silently on a never-again-shown secret. **Fix:**
  feature-detect + fall back to "select and copy manually"; keep `<pre>` selectable. (We're HTTPS; defense.)
- **S9 — Hermes is unverified and placed prominently with no "don't block the rest" hedge.** (completeness)
  **Fix:** verify Hermes against its docs as a separate checkpoint; if unverifiable before ship, omit it rather
  than guess a wrong config, and land the other ~10 targets unblocked. Move it out of the 3rd slot.

## Hygiene (minor; fold into the spec)

- **H1** — "shown once" Callout should be `tone="accent"` (matches `McpKeysPanel.tsx:93`), not `warn` (warn is
  reserved for errors here).
- **H2** — Rename client fn `connectionPackage` → `createConnectionPackage`/`mintConnectionPackage` (every other
  client fn is verb-led).
- **H3** — Fix snippet citation: `McpKeysPanel.tsx:116-118` (the `<pre>` block) + `:119-127` (copy button), not
  `:104,123`.
- **H4** — Frontend `ApiError` is `(status, {code,message,details})` (`types.ts:142-154`), not `(code, status,
  details)` — correct the spec wording (it conflated the backend's `ApiError`).
- **H5** — Add an explicit "no `dangerouslySetInnerHTML` for the snippet block" line (XSS is fine today via
  React escaping; guard against a future syntax-highlighter regression).
- **H6** — Soften "component-state-only" framing: it's exposure-window hygiene (no survival across
  reload/tabs/disk), not an XSS mitigation.
- **H7** — Introduce a shared `capabilityCopy.ts` (parallel to `connectTargets.ts`) as the single source for the
  read/earn/spend copy used by both screens; add `connectTargets satisfies Record<keyof ConnectionSnippets,…>`
  so a renamed snippet key is a type error (cheap given no test harness).
- **H8** — State that BootstrapAgent's "no persistence" is a *deliberate deviation* from the onboarding
  persist-idiom (avoid persisting a passkeyId tied to an unclaimed connection), not idiom parity.
- **H9** — linkCode: add a 15-min countdown + note that regenerating leaves prior codes valid until TTL (store
  doesn't invalidate on re-issue); low risk since consume is tenant-bound to the caller's own key.
- **H10** — Error handling should explicitly name network-failure, double-submit, and WebAuthn-unsupported (not
  just cancel) cases.

## Verdict
Sound isolation fundamentals (ownership, uniform-404, tenant-bound single-use codes, no localStorage secrets, no
`dangerouslySetInnerHTML`). But **not plan-ready as written**: fix M1–M5 (two are protocol-mandated, one blocks
the flagship path, one is a guaranteed 401, one is misleading security copy) and fold in S1–S9 + hygiene. Then
re-review the revised spec.
