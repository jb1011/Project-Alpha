# BYOA Frontend Screens — Design Spec

**Date:** 2026-07-03
**Feature:** The two "Bring Your Own Agent" (BYOA) entry screens in the `interface/` app — web-first
"Connect your agent" + agent-first magic-link bootstrap — consuming the already-shipped backend routes.

## Goal

Give a logged-in user two ways, in the browser, to link an existing MCP-capable agent (Claude Code, Cursor,
Codex, Hermes, …) to a legal body they own:

1. **Web-first "Connect your agent"** — from an entity's dashboard, mint an entity+capability-scoped
   connection and copy a paste-ready MCP config snippet for their agent.
2. **Agent-first bootstrap** — create a guardian passkey + a tenant-wide bootstrap connection with a
   one-time link code, so the user's agent can drive its own onboarding and confirm the binding via the
   `claim_connection` MCP tool.

Both consume backend routes that already exist and are deployed. This is (almost) pure frontend work in the
colleague's Next.js app, matching its existing patterns, plus one tiny backend addition (a Hermes snippet).

## Architecture

The `interface/` app is Next.js 16 (App Router) / React 19 / Tailwind v4 / wagmi v3 + viem / react-query
(installed but unused in practice) / `@turnkey/http`. Data access is a flat typed fetch client
(`src/lib/api/client.ts`) that attaches the SIWE JWT as `Authorization: Bearer` and is relayed to the VPS by
the `/backend/[[...path]]` proxy. Auth is a `useAuth()` context (`AuthProvider`) exposing
`ensureSession()`. UI primitives (`Button`, `Card`, `Callout`, `Field`, `TextInput`, `StepHeader`,
`Spinner`, icons, `cx`) live in `src/components/onboarding/primitives.tsx`. The dark theme uses token
utilities (`bg-paper`, `bg-paper-2`, `text-ink`, `text-muted-2`, `text-accent-soft`, `hairline`).

The two screens follow these patterns exactly: thin `page.tsx` under `src/app/…`, heavy UI in
`src/components/agents/…`, backend calls as thin typed client functions, auth via `ensureSession()`,
feedback via inline `Callout`, secrets kept in-memory only.

## Backend contracts consumed (already live)

- `POST /connection-package` — JWT-auth'd, ownership-gated. Body `{ entityId, capability:
  "read"|"earn"|"spend" (default "spend") }`. Returns `{ mcpUrl, apiKey, entityId, capability, snippets }`.
  Response is `Cache-Control: no-store`.
- `POST /bootstrap-connection` — JWT-auth'd. Body `{ passkeyId, capability }`. Requires the passkey to
  belong to the tenant. Returns `{ mcpUrl, apiKey, passkeyId, capability, linkCode, snippets }`. `linkCode`
  TTL is 15 minutes. Response is `no-store`.
- `GET /passkey/challenge` → `{ challenge, rpId }`; `POST /passkey` (WebAuthn attestation) → `{ id }` — used
  to create a fresh guardian passkey for the bootstrap flow.
- `claim_connection` MCP tool (agent-side) — the agent submits `{ linkCode }`; on the tenant-scoped
  single-use consume it returns `{ tenantId, entities, bound: true }`. Not called by the frontend; the
  bootstrap screen only instructs the user's agent to run it.
- `snippets` shape (from `buildSnippets`): keys `claudeCode` (CLI command, flagship), `cursor`, `codex`,
  `openclaw`, `gemini`, `windsurf`, `cline`, `vscode`, `claudeDesktop`, `generic`, **+ new `hermes`**.

## File structure

**New — components (`src/components/agents/`):**
- `ConnectAgentPanel.tsx` — web-first panel. Replaces `<McpKeysPanel/>` inside `AgentDashboard.tsx`.
- `BootstrapAgent.tsx` — agent-first wizard (rendered by the new route).
- `ConnectionSnippet.tsx` — shared agent-picker + copyable snippet block. Used by both screens.
- `connectTargets.ts` — ordered list mapping each snippet key → `{ label, hint }` (Claude Code first).

**New — route:**
- `src/app/agents/connect/page.tsx` — thin client page:
  `<RequireAuth><AgentShell title="Connect an agent"><BootstrapAgent/></AgentShell></RequireAuth>`.
  Inherits `Web3Provider`+`AuthProvider` from the existing `src/app/agents/layout.tsx`.

**Modified:**
- `src/lib/api/client.ts` — add `connectionPackage(token, entityId, capability)`,
  `bootstrapConnection(token, passkeyId, capability)`, and `storePasskey(token, passkey: GuardianPasskey):
  Promise<{ id: string }>` (POSTs the `{ challenge, attestation }` `GuardianPasskey` — the type already
  exists in `types.ts` — to `/passkey`, which consumes the challenge and returns `{ id }`).
- `src/lib/api/types.ts` — add `Capability`, `ConnectionSnippets`, `ConnectionPackage`, `BootstrapPackage`.
- `src/components/agents/AgentDashboard.tsx` — render `<ConnectAgentPanel entityId={id}/>` where
  `<McpKeysPanel/>` was.
- `src/components/agents/AgentShell.tsx` — add a "Connect an agent" `NavLink` → `/agents/connect`.
- `src/app/agents/page.tsx` — add a "Connect an agent" button in the list header → `/agents/connect`.
- `back/backend/src/mcp/snippets.ts` — add a `hermes` entry (format verified against Hermes docs; default
  to the shared `mcpServers` JSON block if it uses the common format).
- `back/backend/test/mcp/snippets.test.ts` — extend the snippet test to assert the `hermes` key is present
  and well-formed.
- `back/docs/BYOA_INTEGRATION.md` — list Hermes in the supported-agents section.

**Retired:**
- `src/components/agents/McpKeysPanel.tsx` — deleted (replaced by `ConnectAgentPanel`).
- `mintApiKey` / `listApiKeys` / `revokeApiKey` in `client.ts` and their `types.ts` types — removed if
  `McpKeysPanel` was their only consumer (verify by grep before deleting). The backend `/api-keys` route is
  left intact but no longer surfaced in the UI.

## Component designs

### `ConnectionSnippet` (shared)
- **Props:** `{ snippets: ConnectionSnippets, mcpUrl: string }`.
- Renders a horizontal picker (pills, `rounded-full`, from `connectTargets` in order, Claude Code selected
  by default) and, below it, the selected snippet in `<pre class="bg-paper-2 font-mono text-[11px]
  break-all overflow-x-auto">` with an inline copy `Button` (`navigator.clipboard.writeText`) and the
  target's `hint` line ("where to paste", e.g. `~/.cursor/mcp.json`). Mirrors `McpKeysPanel`'s snippet
  rendering (`McpKeysPanel.tsx:104,123`).
- `connectTargets` entries (label → hint), in order: Claude Code (CLI, run in terminal), Cursor
  (`~/.cursor/mcp.json`), Hermes (per Hermes docs), Codex (Codex MCP config), Windsurf
  (`~/.codeium/windsurf/mcp_config.json`), Cline (`cline_mcp_settings.json`), Gemini CLI
  (`settings.json`), VS Code (`.vscode/mcp.json` — `servers`), Claude Desktop (`mcp-remote` bridge),
  OpenClaw (MCP config), Generic (raw endpoint + header).

### `ConnectAgentPanel` (web-first)
- **Props:** `{ entityId: string }`. Rendered inside `AgentDashboard` (already has the entity + a session).
- **States:**
  - **idle** — a `Card` titled "Connect your agent" with a short explainer, a capability selector
    (segmented control: **read** / **earn** / **spend**, default **spend**, each with a one-line
    description of what the linked agent may do), and a "Generate connection" `Button`.
  - **loading** — button `loading`; disable inputs.
  - **result** — a `Callout tone="warn"` "This key is shown once — copy it now", the API key in a copy box,
    then `<ConnectionSnippet>`, then a "Generate a new connection" ghost button that resets to idle
    (invalidating the shown key from view).
- **Data flow:** `const auth = await ensureSession(); const pkg = await connectionPackage(auth.token,
  entityId, capability);` → move to **result** with `pkg`.
- **Errors:** `ApiError` → inline `Callout tone="warn"` with `err.message`; 404 → "Couldn't find that agent
  body — reload and try again." Stay on idle.

### `BootstrapAgent` (agent-first)
- A 3-phase string-union machine (`Phase = "passkey" | "capability" | "generate"`), matching the onboarding
  step idiom; no persistence (short-lived; the key + linkCode live in component state only).
- **passkey** — `StepHeader` explaining the guardian passkey is the human approval anchor; a "Create
  guardian passkey" `Button` runs `getPasskeyChallenge()` → `createGuardianPasskey(challenge, rpId)`
  (existing `src/lib/api/passkey.ts`) → `storePasskey(token, passkey)` → keep the returned `id`; advance.
  WebAuthn cancel/failure → recoverable `Callout`, stay here.
- **capability** — the same read/earn/spend selector as the web-first panel (default **spend**); "Continue".
- **generate** — `bootstrapConnection(token, passkeyId, capability)` → show: `<ConnectionSnippet>` (paste
  into the agent), the `linkCode` in a highlighted box with a "valid 15 minutes" note, and a numbered
  "next steps for your agent": (1) paste the MCP config, (2) ask your agent to run the `claim_connection`
  tool with this code, (3) it confirms with `bound: true`. A "Start over" ghost button returns to
  **passkey**.
- **Errors:** as above; passkey-not-found (404) → "That passkey isn't recognized — create a new one."

## Capability model surfaced in the UI

The read < earn < spend ladder is shown as a segmented selector with plain-language descriptions:
- **read** — "See balances, jobs, and status. Cannot move money or take jobs."
- **earn** — "read + run jobs to earn (ERC-8183)."
- **spend** — "earn + pay via x402 within the treasury's caps/allowlist." (default)

Default **spend** matches the backend defaults and the "full-operate" product decision.

## Error handling

- All backend calls go through the client's `request()` which throws `ApiError(code, status, details)`.
  Screens catch into a local `error` state and render an inline `Callout tone="warn"` (existing
  convention — no toast/modal library exists).
- WebAuthn errors (user cancels, no authenticator) are caught in the passkey phase and shown as a
  recoverable message; the user stays on the passkey step.
- Uniform backend 404s ("entity not found" / "passkey not found") are mapped to friendly copy without
  implying existence of others' resources.

## Security

- API keys and link codes are **never** written to localStorage/sessionStorage — they live only in React
  component state and are cleared on reset (mirrors onboarding stripping the passkey before persisting,
  `OnboardingFlow.tsx:114-126`). The JWT session continues to live in `sessionStorage` as today.
- The backend already returns these responses `Cache-Control: no-store; Referrer-Policy: no-referrer`.
- The "shown once" `Callout` sets the expectation that the key is not retrievable later.

## Testing / verification

The `interface/` app has **no test harness** (scripts are `dev`/`build`/`start`/`lint` only). Frontend
verification is therefore:
- `npm run build` in `interface/` (Next type-check passes) + `npm run lint` clean.
- **Manual smoke against the live VPS:** (a) on a restored agent (e.g. TestAgentMB_1), generate a web-first
  connection, paste the Claude Code snippet, confirm a tool call (`whoami`/`list_entities`) works; (b) run
  the bootstrap flow end-to-end, have an agent run `claim_connection` with the code, confirm `bound: true`.

The backend Hermes addition **is** covered by the backend's existing vitest suite: extend the snippets test
to assert the `hermes` key exists and is a valid config string. This keeps `back/backend`'s green-suite
guarantee intact.

If the team wants real frontend tests, adding a harness (Vitest + React Testing Library) is a separate,
larger scope — flagged, not assumed.

## Out of scope / deferred

- No "list my passkeys" picker (no backend endpoint); the bootstrap flow always creates a fresh passkey.
- No live "was it claimed yet?" polling on the bootstrap screen (no such endpoint); the user learns success
  from their agent's `claim_connection` result. Optional future enhancement: poll `listEntities` for change.
- No changes to the onboarding wizard, treasury/settings screens, or the backend routes themselves (beyond
  the Hermes snippet).
- Deprecating/removing the backend `/api-keys` route is left for a later backend cleanup (audit Tier-2).
