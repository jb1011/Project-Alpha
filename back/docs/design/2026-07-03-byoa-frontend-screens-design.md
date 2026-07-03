# BYOA Frontend Screens — Design Spec (v2, audit-revised)

**Date:** 2026-07-03 · **Revised:** 2026-07-03 after the spec audit
(`back/docs/audit/2026-07-03-byoa-frontend-spec-audit.md`).
**Feature:** The two "Bring Your Own Agent" (BYOA) entry screens in the `interface/` app — web-first
"Connect your agent" + agent-first magic-link bootstrap — consuming the already-shipped backend routes, plus a
key-revocation surface and the protocol-mandated authorization confirmation.

## Goal

Give a logged-in user two ways, in the browser, to link an existing MCP-capable agent (Claude Code, Cursor,
Codex, …) to a legal body they own, and to see/revoke those connections:

1. **Web-first "Connect your agent"** — from an entity's dashboard, mint an entity+capability-scoped
   connection and copy a paste-ready MCP config snippet for their agent.
2. **Agent-first bootstrap** — create a guardian passkey + a tenant-wide bootstrap connection with a one-time
   link code, after an explicit authorization confirmation, so the user's agent can drive its own onboarding
   (`claim_connection` → `onboard_agent`).
3. **Revoke** — a minimal "Active connections" list so any minted key is one-click revocable (§14.2).

Both flows consume backend routes that already exist and are deployed. This is (almost) pure frontend work in
the colleague's Next.js app, matching its existing patterns, plus one tiny backend addition (a Hermes snippet).

## Architecture

The `interface/` app is Next.js 16 (App Router) / React 19 / Tailwind v4 / wagmi v3 + viem / react-query
(installed but unused for data fetching) / `@turnkey/http`. Data access is a flat typed fetch client
(`src/lib/api/client.ts`) whose `request()` attaches the SIWE JWT as `Authorization: Bearer` and throws the
frontend `ApiError(status, { code, message, details })` (`types.ts:142-154`) on non-2xx; traffic is relayed to
the VPS by the `/backend/[[...path]]` proxy. Auth is a `useAuth()` context (`AuthProvider`) exposing
`ensureSession()` (re-logs-in if the session expired). UI primitives (`Button`, `Card`, `Callout`, `Field`,
`TextInput`, `StepHeader`, `Spinner`, icons, `cx`) live in `src/components/onboarding/primitives.tsx`; the dark
theme uses token utilities (`bg-paper`, `bg-paper-2`, `text-ink`, `text-muted-2`, `text-accent-soft`,
`hairline`). Feedback is inline `Callout`/red `<p>` — there is no toast or modal library.

The two screens follow these patterns exactly: thin `page.tsx` under `src/app/…`, heavy UI in
`src/components/agents/…`, backend calls as thin verb-led typed client functions, auth via `ensureSession()`,
feedback via inline `Callout`, secrets kept in-memory only.

## Backend contracts consumed (already live — verified against code)

- `POST /connection-package` — JWT-auth'd, ownership-gated. Body `{ entityId, capability }`. Returns
  `{ mcpUrl, apiKey, entityId, capability, snippets }` (`connection.ts:27-52`). `no-store` set server-side. The
  minted key `id` is **not** returned (revocation is via the separate list route, below).
- `POST /bootstrap-connection` — JWT-auth'd. Body `{ passkeyId, capability }`; requires the passkey to belong
  to the tenant. Returns `{ mcpUrl, apiKey, passkeyId, capability, linkCode, snippets }`; `linkCode` TTL 15 min
  (`connection.ts:54-79`). Mints a **tenant-wide** key (no entityId).
- `GET /passkey/challenge` — **now `requireAuth`-gated** (`passkey.ts:20`). Returns `{ challenge, rpId }`.
- `POST /passkey` — JWT-auth'd. Body is the `GuardianPasskey` `{ challenge, attestation }`
  (`GuardianPasskeySchema`); **consumes** the challenge (single-use) and returns `{ id }` (201).
- `GET /api-keys` (`listApiKeys`) → `ApiKeyView[]` (`{ id, label, capability?, entityId?, createdAt,
  revokedAt? }`) and `DELETE /api-keys/:id` (`revokeApiKey`) — **the revoke surface**; the store is shared with
  `/connection-package` + `/bootstrap-connection`, so keys minted there are listed/revoked here (labels are
  `connect:<entityId>` / `bootstrap:<passkeyId>`).
- `claim_connection` MCP tool (agent-side) — agent submits `{ linkCode }`; single-use tenant-scoped consume
  returns `{ tenantId, entities, bound: true }` (`server.ts:62-84`). Not called by the frontend.
- `onboard_agent` MCP tool — **requires `passkeyId`** (`server.ts:359-363`); on a tenant-wide key
  (`entityId===null` + capability `spend`) this is how the bootstrapped agent creates its legal body.
- `snippets` shape (`buildSnippets`): `claudeCode` (CLI command, flagship), `cursor`, `codex`, `openclaw`,
  `gemini`, `windsurf`, `cline`, `vscode`, `claudeDesktop`, `generic`, **+ new `hermes`** (see §Hermes).

## File structure

**New — components (`src/components/agents/`):**
- `ConnectAgentPanel.tsx` — web-first panel. Replaces `<McpKeysPanel/>` in `AgentDashboard.tsx:317-319`.
- `ActiveConnectionsPanel.tsx` — list + revoke (extracted from `McpKeysPanel.tsx:130-155`). Rendered under
  `ConnectAgentPanel` (filtered to this entity) and on `/agents/connect` (bootstrap connections).
- `BootstrapAgent.tsx` — agent-first wizard (rendered by the new route).
- `ConnectionSnippet.tsx` — shared agent-picker + copyable `<pre>` block. Used by both screens.
- `connectTargets.ts` — ordered list mapping each snippet key → `{ label, hint }`.
- `capabilityCopy.ts` — single source for the read/earn/spend labels + descriptions (used by both selectors),
  differentiated for entity-scoped vs tenant-wide keys (see §Capability model).

**New — route:** `src/app/agents/connect/page.tsx` — thin client page rendering
`<RequireAuth><AgentShell title="Connect an agent"><BootstrapAgent/></AgentShell></RequireAuth>` (inherits
`Web3Provider`+`AuthProvider` from `src/app/agents/layout.tsx`; matches `[id]/page.tsx` thinness + `use(params)`
idiom where relevant).

**Modified:**
- `src/lib/api/client.ts` — add `createConnectionPackage(token, entityId, capability)`,
  `bootstrapConnection(token, passkeyId, capability)`, `storePasskey(token, passkey: GuardianPasskey):
  Promise<{ id: string }>` (POSTs `{ challenge, attestation }` to `/passkey`). **Fix** `getPasskeyChallenge` to
  take a `token` and forward it as `opts.token` (the route is now auth-gated — the current zero-arg version
  will 401). Remove `mintApiKey` (only `McpKeysPanel` used it). **Keep** `listApiKeys`/`revokeApiKey`
  (now used by `ActiveConnectionsPanel`).
- `src/lib/api/types.ts` — add `Capability = "read"|"earn"|"spend"`, `ConnectionSnippets`,
  `ConnectionPackage`, `BootstrapPackage`. Keep `ApiKeyView`. Remove `MintedApiKey` if now unused (verify).
- `src/components/onboarding/steps/WelcomeStep.tsx:98` — update the existing `getPasskeyChallenge()` call to
  pass the session token (it currently calls the soon-to-be-token-taking helper with no token).
- `src/components/agents/AgentDashboard.tsx` — render `<ConnectAgentPanel entityId={id}/>` (which itself renders
  `<ActiveConnectionsPanel/>`) where `<McpKeysPanel/>` was.
- `src/components/agents/AgentShell.tsx` — add a "Connect an agent" `NavLink` → `/agents/connect`.
- `src/app/agents/page.tsx` — add a "Connect an agent" button in the list header → `/agents/connect`.
- `back/backend/src/mcp/snippets.ts` — add a `hermes` entry (§Hermes).
- `back/backend/test/mcp/snippets.test.ts` — assert the `hermes` key is present + well-formed.
- `back/docs/BYOA_INTEGRATION.md` — list Hermes in the supported-agents section (only once verified).

**Retired:** `src/components/agents/McpKeysPanel.tsx` — deleted (its connect flow → `ConnectAgentPanel`, its
list/revoke UI → `ActiveConnectionsPanel`). The backend `/api-keys` mint route is left intact but unexposed.

## Component designs

### `ConnectionSnippet` (shared)
- **Props:** `{ snippets: ConnectionSnippets, mcpUrl: string }`.
- Renders a horizontal picker (pills, `rounded-full`, from `connectTargets` in order, Claude Code selected by
  default) and the selected snippet in `<pre className="… bg-paper-2 …">{snippet}</pre>` (mirrors
  `McpKeysPanel.tsx:116-118`; the copy button mirrors `:119-127`). **Never `dangerouslySetInnerHTML`** — React's
  default child-text escaping is the XSS defense; the snippet must stay plain-text.
- **Copy** is feature-detected: if `navigator.clipboard?.writeText` exists, use it; otherwise show a
  "select and copy manually" hint. The `<pre>` must remain text-selectable in all states.
- **Claude Code caveat:** when the `claudeCode` (CLI) target is selected, show a small `text-muted-2` note:
  "This command puts your key in your shell history — prefer the config-file options for a long-lived key."
- `connectTargets` (label → hint), Claude Code first, **Hermes appended last-of-the-verified-block, only if
  verified** (§Hermes): Claude Code (CLI, run in terminal), Cursor (`~/.cursor/mcp.json`), Codex (Codex MCP
  config), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Cline (`cline_mcp_settings.json`), Gemini CLI
  (`settings.json`), VS Code (`.vscode/mcp.json` — `servers`), Claude Desktop (`mcp-remote` bridge), OpenClaw
  (MCP config), Generic (raw endpoint + header)[, Hermes (per Hermes docs)].

### `ConnectAgentPanel` (web-first)
- **Props:** `{ entity: EntityView }` (the dashboard already has the entity + a session).
- **Entity-status gate:** if `entity.status ∉ { "bound", "funded" }`, the idle state shows a
  `Callout tone="info"`: "This agent's legal body is still being set up — a connection generated now won't be
  able to pay or take jobs until it's bound." (Generate stays enabled — read connections are still useful — but
  the warning is explicit.)
- **States:**
  - **idle** — a `Card` titled "Connect your agent" + explainer, a capability selector (from `capabilityCopy`,
    entity-scoped variant, **default `spend`** — this key is bounded by *this* body's on-chain caps), and a
    "Generate connection" `Button`.
  - **loading** — button `loading`; inputs disabled (guards double-submit; note mints are non-idempotent).
  - **result** — a `Callout tone="accent"` titled "Copy your key now" ("You won't see this key again"), the
    API key in a copy box, then `<ConnectionSnippet>`. If `pkg.mcpUrl` contains `localhost`/`127.0.0.1`, show a
    `Callout tone="warn"`: "Server MCP URL looks misconfigured — the snippet may not work." A "Generate a new
    connection" ghost button returns to idle and clears the shown key from React state (copy: "Start over" —
    NOT "invalidate"; to actually revoke, use Active connections below).
- **Data flow:** `const auth = await ensureSession(); const pkg = await createConnectionPackage(auth.token,
  entity.idempotencyKey, capability);` → **result** with `pkg`.
- Renders `<ActiveConnectionsPanel entityId={entity.idempotencyKey}/>` beneath the connect card.
- **Errors:** caught into local state → inline `Callout tone="warn"` with `err.message`; uniform 404 →
  "Couldn't find that agent body — reload and try again." (Copy stays generic — no existence oracle.)

### `ActiveConnectionsPanel` (list + revoke)
- **Props:** `{ entityId?: string }` (filter). Polls once via `ensureSession()` → `listApiKeys(token)`; filters
  to keys for this entity (by `entityId`/label) on the dashboard, or bootstrap keys on `/agents/connect`.
- Renders the list + per-row Revoke exactly as `McpKeysPanel.tsx:130-155` (label, `id.slice(0,8)…`, capability,
  Revoke → `revokeApiKey(token, id)` → refresh; "Revoked" when `revokedAt`). Empty state: a one-line
  "No active connections yet."

### `BootstrapAgent` (agent-first)
- A 4-phase string-union machine: `Phase = "passkey" | "capability" | "confirm" | "generate"`. **No
  persistence** — a *deliberate deviation* from the onboarding persist-idiom (we will NOT write a `passkeyId`
  tied to an unclaimed connection to localStorage); a mid-flow refresh restarts the wizard. Secrets live in
  component state only.
- **passkey** — `StepHeader` explaining the guardian passkey is the human approval anchor; "Create guardian
  passkey" runs `getPasskeyChallenge(token)` → `createGuardianPasskey(challenge, rpId)` (existing
  `src/lib/api/passkey.ts`) → `storePasskey(token, passkey)` → keep `{ id }`. Up front, detect
  `!window.PublicKeyCredential`; if unsupported, show "Passkeys aren't available in this browser — use the
  web-first Connect flow from an agent's dashboard instead" and don't dead-end. WebAuthn cancel → recoverable
  `Callout`, stay here.
- **capability** — capability selector (from `capabilityCopy`, **tenant-wide variant**, **default `read`** —
  this key can act across your whole tenant, so opt-up is explicit); "Continue".
- **confirm** — the §14.2 authorization confirmation (audit-Critical). Plain-language `Callout`: "You're about
  to create a **tenant-wide** connection with **<capability>** power, anchored to the guardian passkey you just
  created. Any agent that receives the one-time link code can act on your legal bodies at this level" — with, for
  `spend`, the extra line "spend also lets the agent fund treasuries and create new agent legal bodies." A
  "Confirm & generate" primary button + a "Back" ghost.
- **generate** — `await ensureSession()` again (guards stale token across the multi-step flow), then
  `bootstrapConnection(token, passkeyId, capability)`. Show: the `<ConnectionSnippet>`; the **`passkeyId`** in a
  copy box (required for the next step); the `linkCode` in a highlighted box with a **live 15-min countdown**
  (note: regenerating leaves the prior code valid until its own TTL); and a numbered "next steps for your
  agent": (1) paste the MCP config, (2) run `claim_connection` with this link code → `bound: true`, (3) run
  `onboard_agent` with `passkeyId: <id>` to create the legal body, (4) poll `get_entity` until `bound`. A
  "Start over" ghost returns to **passkey**. Also renders `<ActiveConnectionsPanel/>` (bootstrap filter) so the
  just-minted key is immediately revocable.
- **Errors:** as above; passkey-not-found (404) → "That passkey isn't recognized — create a new one."; stale
  session → the re-`ensureSession()` transparently re-logs-in.

## Capability model surfaced in the UI (`capabilityCopy.ts`)

The read < earn < spend ladder (`mcp/scope.ts`) is a segmented selector. Copy is **accurate to what the backend
actually gates** and differs for entity-scoped vs tenant-wide keys:

- **read** — "See balances, jobs, and status. Cannot move money or take jobs."
- **earn** — "read + run jobs to earn (ERC-8183)."
- **spend (entity-scoped / web-first)** — "earn + pay via x402 **and fund this treasury**, within its
  caps/allowlist." (default here)
- **spend (tenant-wide / bootstrap)** — "earn + pay + fund treasuries **+ create new agent legal bodies**
  across your tenant." (NOT default here — read is)

`capabilityCopy.ts` exports both variants so the two screens never drift. Add `connectTargets satisfies
Record<keyof ConnectionSnippets, { label: string; hint: string }>` (once `hermes` lands) so a renamed/missing
snippet key is a compile error — cheap coverage given there's no frontend test harness.

## Hermes

Adds a `hermes` snippet, but **verified, not guessed** (a wrong config snippet is worse than no entry):
- Verify Hermes's actual MCP config format + the "where to paste" path against its own docs as a **separate
  checkpoint** during implementation.
- If it uses the common `{ "mcpServers": { "legalbody": { url, headers } } }` block, add `hermes: jsonBlock`.
- If it can't be verified before ship (no stable MCP config, stdio-only, or not actually an MCP client),
  **omit it** — the other ~10 targets are already known-correct and must not be blocked on Hermes. The Hermes
  addition (`snippets.ts` + test + `connectTargets` entry + docs) is an isolated commit that can land later.

## Error handling

- All backend calls go through `request()`, which throws the frontend `ApiError`. Screens catch into a local
  `error` state → inline `Callout tone="warn"` (existing convention; no toast/modal lib). **Raw network
  failures** (fetch reject before `res.ok`) are caught by the same try/catch and shown generically.
- **Double-submit** is prevented by `loading` + disabled inputs; mints are non-idempotent, so the guard matters.
- **Session expiry mid-flow** — `ensureSession()` is called immediately before each mutating call (and again
  before the bootstrap `generate` POST), transparently re-authing.
- **WebAuthn** — `!window.PublicKeyCredential` is detected up front (route to web-first); user-cancel is
  recoverable in place.
- **Clipboard** — feature-detected with a manual-copy fallback.
- Uniform backend 404s are mapped to generic friendly copy that does not reveal which resources exist.

## Security

- API keys and link codes live **only** in React component state, never localStorage/sessionStorage, and are
  cleared on reset. (This is exposure-window hygiene — it prevents survival across reload/tabs/disk, not live
  XSS, which in-memory state is equally exposed to.) The SIWE JWT continues in `sessionStorage` as today.
- **Correction to v1:** the backend's `Cache-Control: no-store`/`Referrer-Policy: no-referrer` on these
  responses do **not** reach the browser — the app proxy (`interface/src/app/backend/[[...path]]/route.ts:35-40`)
  strips all response headers except `content-type`. POST responses aren't HTTP-cached by default, and referrer
  on a JSON response is inert, so the practical exposure is low; the real protections are not-persisting +
  one-click revoke. *Optional hardening:* have the proxy set `Cache-Control: no-store` for the two connect
  paths.
- **XSS:** snippets render as `<pre>` text via React escaping; **no `dangerouslySetInnerHTML`** anywhere in these
  components (guard against a future syntax-highlighter regression).
- **Revocation:** every minted key is one-click revocable via `ActiveConnectionsPanel` (§14.2 satisfied).
- **Capability defaults** follow blast radius: entity-scoped web-first defaults to `spend` (bounded by one
  body's on-chain caps); tenant-wide bootstrap defaults to `read` with explicit opt-up + the confirm screen.
- **Accepted risk (tracked follow-up):** guardian-passkey proliferation — every bootstrap run stores a
  permanent guardian anchor and `PasskeyStore` has no delete. Mitigation deferred to a backend follow-up
  (list/revoke passkeys endpoint + small UI); recorded here, not silently dropped.

## Testing / verification

The `interface/` app has **no test harness** (scripts are `dev`/`build`/`start`/`lint`). Frontend verification:
- `npm run build` (Next type-check, incl. the `satisfies` guard) + `npm run lint` clean.
- **Manual smoke against the live VPS:** (a) on a restored agent (e.g. TestAgentMB_1), generate a web-first
  connection, paste the Claude Code snippet, confirm a tool call (`whoami`/`list_entities`); revoke it and
  confirm the tool call now 401s. (b) run the bootstrap flow through the confirm screen, have an agent run
  `claim_connection` then `onboard_agent { passkeyId }`, confirm a new entity reaches `bound`.
- Backend Hermes change is covered by extending `back/backend/test/mcp/snippets.test.ts` (keeps the green suite).

## Out of scope / deferred (tracked)

- Backend **list/revoke passkeys** endpoint + UI (see Accepted risk) — follow-up.
- Optional proxy `Cache-Control: no-store` hardening for the connect paths.
- No live "was it claimed yet?" polling on bootstrap (no endpoint); success is learned from the agent's tools.
- Deprecating/removing the backend `/api-keys` mint route — later backend cleanup (audit Tier-2).
- No changes to onboarding, treasury/settings, or backend routes beyond the Hermes snippet.

## Changelog
- **v2 (2026-07-03):** applied the spec audit. Added `ActiveConnectionsPanel` (revoke, §14.2) + kept
  `listApiKeys`/`revokeApiKey`; added the bootstrap **confirm** phase (§14.2 authorization confirmation); surfaced
  `passkeyId` + `onboard_agent` next-steps (closes the agent-first journey); fixed `getPasskeyChallenge` auth;
  corrected + differentiated capability copy (`capabilityCopy.ts`) with blast-radius defaults (web-first spend /
  bootstrap read); corrected the `no-store` claim; added entity-status gating, mcpUrl guard, clipboard fallback,
  stale-session re-check, WebAuthn-unsupported path, shell-history note; hedged Hermes; hygiene (Callout tone,
  verb-led naming, citations, `satisfies` guard, deliberate-deviation note).
