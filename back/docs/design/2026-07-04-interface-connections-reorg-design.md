# Interface Connections & Passkeys Reorg (Part B) — Design

**Date:** 2026-07-04 · **Area:** `interface/` (Next.js 16 / React 19 / Tailwind v4) + one small `back/backend` change · **Type:** frontend IA reorg

## Goal

Stop dumping an unfiltered, raw-labelled list of every API key + guardian passkey (revoked ones included) at the bottom of the "Connect an agent" page. Give each credential the right home, hide revoked items, and make rows readable.

## Architecture — the three-way split

Each credential lands where it belongs, which dissolves the "label by agent" problem (the page becomes the label):

- **Per-agent connections** (`connect:<entityId>` keys, `entityId` set) → the agent's own dashboard.
- **Tenant-wide** bootstrap connections (`entityId === null`) + **guardian passkeys** → a new tenant "Account" page.
- **"Connect an agent"** page → just the bootstrap flow (no dumped lists).
- **Revoked** items → filtered out of every list.

## Backend change (the only one)

`GET /api-keys` → `apiKeys.list(tenantId)` currently returns `{ id, label, createdAt, revokedAt }`. The `api_keys` table already has `entity_id` and `capability` columns (used by `mint`/verify), so **no migration** — just surface them:

- `SqliteApiKeyStore.list()` query (`src/persistence/apiKeyStore.ts`): add `entity_id AS entityId, capability` to the `SELECT`.
- `ApiKeyView` interface: add `entityId: string | null` and `capability: Capability`.
- Frontend `ApiKeyView` type (`interface/src/lib/api/types.ts`): add `entityId: string | null` and `capability: "read" | "earn" | "spend"`.

This lets the UI filter by `entityId` (robust) instead of `label` string-matching (fragile), and render a `read/earn/spend` badge. `GuardianPasskeysPanel` needs no backend change (`PasskeyView` already carries `name`/`revokedAt`).

## Frontend changes

### 1. New "Account" page
- Route `interface/src/app/agents/account/page.tsx` (wrapped in `AgentShell`), plus an **"Account"** nav entry in `AgentShell` immediately after "My agents" (both tenant-level).
- Renders:
  - **Tenant-wide connections** — `ActiveConnectionsPanel` in tenant mode (`entityId === null`), each row labelled **"Tenant-wide · \<capability\>"** with a capability badge + created date (not `bootstrap:uuid`).
  - **Guardian passkeys** — `GuardianPasskeysPanel` (moved here), name + created date.
- Revoked hidden. **The page MUST wrap its content in `<RequireAuth>`** (like every sibling `/agents/*` page — `interface/src/components/agents/RequireAuth.tsx`), not merely rely on the layout's `AuthProvider` + each panel's own `ensureSession()`. Audit finding: without `RequireAuth`, a logged-out (or connected-but-unauthenticated) wallet would mount the panels with no established session → permanently-empty "No connections/passkeys yet" lists (both panels swallow the `ensureSession` failure) AND `ActiveConnectionsPanel` + `GuardianPasskeysPanel` would fire two concurrent `login()`/SIWE prompts racing each other. `RequireAuth` gates rendering until a stored session resolves, exactly as the other pages do.

### 2. Per-agent dashboard "Connections" section
- `ConnectAgentPanel` (already at the bottom of `AgentDashboard`) keeps the per-entity connection generator and its embedded `ActiveConnectionsPanel`, now:
  - filters by **`k.entityId === entity.id`** (was `k.label === \`connect:${entityId}\``),
  - **hides revoked**, shows a **capability badge**. No agent-name label (the page is the agent).

### 3. "Connect an agent" page cleanup
- **Edit target = `interface/src/components/agents/BootstrapAgent.tsx`, NOT `app/agents/connect/page.tsx`** (audit correction: the connect page only renders `<BootstrapAgent />`; the two panels are rendered *inside* `BootstrapAgent.tsx` at ~lines 200 + 203, imported at ~lines 9 + 12). Remove those two `<ActiveConnectionsPanel />` + `<GuardianPasskeysPanel />` renders (and their now-unused imports) from `BootstrapAgent`. Keep only the bootstrap flow. Add a small link **"Manage connections & passkeys → Account"** (to `/agents/account`).

### 4. Revoked filtering
- In `ActiveConnectionsPanel` and `GuardianPasskeysPanel`, filter `revokedAt != null` out of the rendered list. The existing revoke handler already bumps `reloadKey` → refetch → the just-revoked item is gone. (The now-unused "Revoked" disabled-button branch is removed.)

### 5. Readability / shared row
- Replace the raw-`label` + `id.slice(0,8)…` rows with a shared **`ConnectionRow`** presentation: a **capability badge**, a human label (agent context or "Tenant-wide"), and a created date, with a shared **`RevokeButton`** extracted from the two panels (they currently duplicate it). Uses the existing `Card`/`Button`/token primitives (`src/components/onboarding/primitives.tsx`) — no new styling system.
- **Capability badge colors (fresh decision — no existing per-capability mapping):** tier by privilege — `read` = neutral/muted (`text-muted-2` on a subtle chip), `earn` = accent (`--accent`), `spend` = a warm emphasis tone (reuse the existing `#ff8a84` danger token family for the highest-privilege badge). Three static classes, no new tokens.
- **`RevokeButton` confirm (audit — the two panels differ today):** the shared button takes an optional `confirmMessage?: string`; when set it runs `window.confirm(confirmMessage)` before revoking. Preserve `GuardianPasskeysPanel`'s existing passkey warning, and ADD a connection message ("Revoking disconnects any agent using this connection. Continue?") so both confirm consistently.
- **`ActiveConnectionsPanel` filter contract (audit — avoid mixing tenant + per-agent):** replace the current optional `entityId` prop (and its "no prop → show everything unfiltered" fallback, which is removed) with an explicit `filter: { mode: "entity"; entityId: string } | { mode: "tenant" }`. `mode:"entity"` renders `k.entityId === entityId`; `mode:"tenant"` renders `k.entityId === null`. Both ALWAYS drop `revokedAt != null`. This guarantees the Account page's tenant view shows ONLY tenant-wide keys, never per-agent ones.

## Data flow

`listApiKeys(token)` returns the new `entityId`/`capability` fields. Account page filters `entityId === null`; the dashboard panel filters `entityId === entity.id`; both hide `revokedAt`. `listPasskeys(token)` feeds the Account passkeys, revoked hidden. No react-query change — keep the current `useState`/`useEffect` + `reloadKey`-refetch-after-revoke pattern.

## Testing

- **Backend:** a vitest test that `SqliteApiKeyStore.list()` (and `GET /api-keys`) returns `entityId` + `capability` for a minted key (per-agent + tenant-wide). Add to the existing api-keys/apiKeyStore tests.
- **Frontend:** the `interface/` app has **no test runner** today. Under the deadline this reorg is verified by `tsc --noEmit` (types line up with the new `ApiKeyView`) + a production build + a manual pass (revoked hidden, per-agent vs tenant split, capability badge, Account nav). The plan will state this explicitly rather than stand up a frontend test harness.

## Non-goals

- No new backend list/filter endpoints (the client filters the tenant's own small key list).
- No react-query migration.
- No change to how connections/passkeys are minted or revoked (only where they're shown + how they're labelled).
- No standing up a frontend test framework in this PR.
