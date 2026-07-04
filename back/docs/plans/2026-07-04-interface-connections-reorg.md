# Interface Connections & Passkeys Reorg (Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give connections + guardian passkeys the right home (per-agent vs a tenant "Account" page), hide revoked items, and make rows readable with a capability badge.

**Architecture:** One small backend add (`GET /api-keys` surfaces `entityId`+`capability`, no migration) enables robust `entityId` filtering + a badge. Frontend: `ActiveConnectionsPanel` gains an explicit `filter` prop; a new `/agents/account` page holds tenant-wide items; the "Connect an agent" flow (`BootstrapAgent`) drops its dumped lists. Revoked items filtered everywhere.

**Tech Stack:** Backend `back/backend` (better-sqlite3, Hono, vitest). Frontend `interface/` (Next.js 16.2.7, React 19, Tailwind v4) — **no test runner**, so frontend tasks verify via `npx tsc --noEmit` + `npm run build` + a manual pass.

## Global Constraints

- Backend: `GET /api-keys` → `apiKeys.list(tenantId)` MUST also return `entityId: string | null` and `capability: "read"|"earn"|"spend"` (existing `api_keys` columns; no migration). Response NEVER includes the key/hash (unchanged).
- Frontend `ActiveConnectionsPanel` takes exactly `filter: { mode: "entity"; entityId: string } | { mode: "tenant" }` — no optional `entityId`, no "show everything" fallback. `mode:"entity"` → `k.entityId === entityId`; `mode:"tenant"` → `k.entityId === null`. Both ALWAYS drop `revokedAt != null`.
- `GuardianPasskeysPanel` drops `revokedAt != null` too.
- The new `/agents/account/page.tsx` MUST wrap its content in `<RequireAuth>` (like every sibling `/agents/*` page).
- The "Connect an agent" panels to remove live in `interface/src/components/agents/BootstrapAgent.tsx` (NOT the connect page). Add a "Manage connections & passkeys → Account" link there.
- Capability badge colors (tier by privilege): `read` = `text-muted-2`, `earn` = `text-accent`, `spend` = `text-[#ff8a84]`.
- Shared `RevokeButton` takes optional `confirmMessage`; connections + passkeys both confirm.
- Per-task: backend runs `npx vitest run <file> && npx tsc --noEmit && npx biome check src test`; frontend runs `npx tsc --noEmit` (in `interface/`), final task also `npm run build`.

---

## File Structure

- `back/backend/src/persistence/apiKeyStore.ts` (modify) — `list()` SELECT + `ApiKeyView` type.
- `back/backend/src/api/routes/apiKeys.ts` — no change (bare pass-through already returns whatever `list()` gives).
- `interface/src/lib/api/types.ts` (modify) — frontend `ApiKeyView`.
- `interface/src/components/agents/connectionRow.tsx` (create) — shared `CapabilityBadge` + `RevokeButton`.
- `interface/src/components/agents/ActiveConnectionsPanel.tsx` (rewrite) — `filter` prop + hide revoked + badge.
- `interface/src/components/agents/ConnectAgentPanel.tsx` (modify) — its `<ActiveConnectionsPanel>` call site.
- `interface/src/components/agents/BootstrapAgent.tsx` (modify) — remove the two panels + imports, add the link.
- `interface/src/components/agents/GuardianPasskeysPanel.tsx` (modify) — hide revoked + shared `RevokeButton`.
- `interface/src/app/agents/account/page.tsx` (create) — the Account page.
- `interface/src/components/agents/AgentShell.tsx` (modify) — "Account" nav entry.

Task order: **1 (backend + types) → 2 (ActiveConnectionsPanel refactor + shared row + call sites) → 3 (GuardianPasskeysPanel + Account page + nav)**.

---

### Task 1: Backend — `GET /api-keys` returns `entityId` + `capability`

**Files:**
- Modify: `back/backend/src/persistence/apiKeyStore.ts` (`ApiKeyView` at ~4-11, `list()` at ~84-90)
- Modify: `interface/src/lib/api/types.ts` (`ApiKeyView` at 125-130)
- Test: `back/backend/test/persistence/apiKeyStore.test.ts`

**Interfaces:**
- Produces: backend `ApiKeyView` gains `entityId: string | null` + `capability: Capability`; frontend `ApiKeyView` matches (used by Tasks 2-3).

- [ ] **Step 1: Write the failing test**

Append to `back/backend/test/persistence/apiKeyStore.test.ts` (reuse the file's existing in-memory `db` + `SqliteApiKeyStore` setup — mirror the top of the file):

```ts
test("list() surfaces entityId + capability (per-agent and tenant-wide)", () => {
  const tenant = "0xTEN";
  store.mint(tenant, { entityId: `${tenant}:agent-1`, capability: "read", label: `connect:${tenant}:agent-1` });
  store.mint(tenant, { capability: "spend", label: "bootstrap:pk-1" }); // tenant-wide: no entityId
  const rows = store.list(tenant);

  const connect = rows.find((r) => r.label === `connect:${tenant}:agent-1`);
  expect(connect?.entityId).toBe(`${tenant}:agent-1`);
  expect(connect?.capability).toBe("read");

  const boot = rows.find((r) => r.label === "bootstrap:pk-1");
  expect(boot?.entityId).toBeNull();
  expect(boot?.capability).toBe("spend");
});
```

(If the file names the store differently, use its variable. If `mint` signature differs, check `MintOpts` at the top of `apiKeyStore.ts` — it accepts `{ entityId?, capability?, label? }`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/persistence/apiKeyStore.test.ts`
Expected: FAIL — `entityId`/`capability` are `undefined` on the returned rows (not selected) / type error.

- [ ] **Step 3: Implement — widen the type + query**

In `back/backend/src/persistence/apiKeyStore.ts`, add to the `ApiKeyView` interface (after its `revokedAt` field):

```ts
  entityId: string | null;
  capability: Capability;
```

(`Capability` is already imported/defined in this file — it's used by `MintOpts`.)

Change the `list()` SELECT (line ~87) to also select the two columns:

```ts
      .prepare(
        "SELECT id, label, entity_id AS entityId, capability, created_at AS createdAt, revoked_at AS revokedAt FROM api_keys WHERE owner_tenant = ? ORDER BY created_at",
      )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/persistence/apiKeyStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen the frontend type**

In `interface/src/lib/api/types.ts`, add to `ApiKeyView` (after `revokedAt`):

```ts
  entityId: string | null;
  capability: Capability;
```

(`Capability` is already exported from this file at line 132.)

- [ ] **Step 6: Verify**

Run: `cd back/backend && npx tsc --noEmit && npx biome check src test`
Run: `cd interface && npx tsc --noEmit`
Expected: both clean. (The frontend addition is additive; no existing frontend code constructs `ApiKeyView` literals, so nothing breaks.)

- [ ] **Step 7: Commit**

```bash
cd /home/mbarr/Project-Alpha && git add back/backend/src/persistence/apiKeyStore.ts back/backend/test/persistence/apiKeyStore.test.ts interface/src/lib/api/types.ts
git commit -m "feat(api-keys): surface entityId + capability on GET /api-keys (interface reorg)"
```

---

### Task 2: `ActiveConnectionsPanel` filter refactor + shared row + call sites

**Files:**
- Create: `interface/src/components/agents/connectionRow.tsx`
- Rewrite: `interface/src/components/agents/ActiveConnectionsPanel.tsx`
- Modify: `interface/src/components/agents/ConnectAgentPanel.tsx` (its `<ActiveConnectionsPanel>` call)
- Modify: `interface/src/components/agents/BootstrapAgent.tsx` (remove both panels + imports; add link)

**Interfaces:**
- Consumes: `ApiKeyView` (with `entityId`/`capability`) from Task 1; `Capability` from `@/lib/api/types`; `cx` from `@/components/onboarding/primitives`.
- Produces: `CapabilityBadge`, `RevokeButton` (from `connectionRow.tsx`); `ActiveConnectionsPanel({ filter })` with `filter: { mode: "entity"; entityId: string } | { mode: "tenant" }` (used by Task 3's Account page).

- [ ] **Step 1: Create the shared row primitives**

Create `interface/src/components/agents/connectionRow.tsx`:

```tsx
"use client";

import type { Capability } from "@/lib/api/types";
import { cx } from "@/components/onboarding/primitives";

const CAP_STYLE: Record<Capability, string> = {
  read: "text-muted-2",
  earn: "text-accent",
  spend: "text-[#ff8a84]",
};

/** A read/earn/spend chip, tiered by privilege. */
export function CapabilityBadge({ capability }: { capability: Capability }) {
  return (
    <span
      className={cx(
        "shrink-0 rounded-full border hairline px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]",
        CAP_STYLE[capability],
      )}
    >
      {capability}
    </span>
  );
}

/** Shared revoke text-button; runs an optional window.confirm before revoking. */
export function RevokeButton({
  onRevoke,
  disabled,
  confirmMessage,
}: {
  onRevoke: () => void;
  disabled?: boolean;
  confirmMessage?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (confirmMessage && !window.confirm(confirmMessage)) return;
        onRevoke();
      }}
      className="shrink-0 text-[11.5px] text-[#ff8a84] underline-offset-2 hover:underline disabled:opacity-50"
    >
      Revoke
    </button>
  );
}
```

- [ ] **Step 2: Rewrite `ActiveConnectionsPanel`**

Replace the whole body of `interface/src/components/agents/ActiveConnectionsPanel.tsx` with:

```tsx
"use client";

import * as React from "react";
import { listApiKeys, revokeApiKey } from "@/lib/api/client";
import type { ApiKeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { CapabilityBadge, RevokeButton } from "@/components/agents/connectionRow";

type ConnectionFilter = { mode: "entity"; entityId: string } | { mode: "tenant" };

export function ActiveConnectionsPanel({ filter }: { filter: ConnectionFilter }) {
  const { ensureSession } = useAuth();
  const [keys, setKeys] = React.useState<ApiKeyView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  // Stabilize effect deps (filter is a fresh object each render).
  const mode = filter.mode;
  const entityId = filter.mode === "entity" ? filter.entityId : null;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await ensureSession();
        const all = await listApiKeys(auth.token);
        const visible = all.filter(
          (k) => !k.revokedAt && (mode === "tenant" ? k.entityId === null : k.entityId === entityId),
        );
        if (!cancelled) setKeys(visible);
      } catch {
        /* keep the prior list on a transient failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSession, mode, entityId, reloadKey]);

  async function onRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokeApiKey(auth.token, id);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Active connections</div>
      {keys.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-2">No active connections yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-xl border hairline px-3 py-2.5 text-[12px]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <CapabilityBadge capability={k.capability} />
                <span className="truncate text-ink">{mode === "tenant" ? "Tenant-wide" : "This agent"}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-2">{k.id.slice(0, 8)}…</span>
              </div>
              <RevokeButton
                disabled={busy}
                confirmMessage="Revoking disconnects any agent using this connection. Continue?"
                onRevoke={() => void onRevoke(k.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Update the per-agent call site**

In `interface/src/components/agents/ConnectAgentPanel.tsx`, find the `<ActiveConnectionsPanel entityId={entity.id} />` render and change it to:

```tsx
<ActiveConnectionsPanel filter={{ mode: "entity", entityId: entity.id }} />
```

- [ ] **Step 4: Remove the panels from `BootstrapAgent` + add the link**

In `interface/src/components/agents/BootstrapAgent.tsx`:
- Remove the two imports `import { ActiveConnectionsPanel } from "@/components/agents/ActiveConnectionsPanel";` and `import { GuardianPasskeysPanel } from "@/components/agents/GuardianPasskeysPanel";`.
- Remove the two JSX renders `<ActiveConnectionsPanel />` and `<GuardianPasskeysPanel />` (rendered unfiltered near the bottom).
- In their place, add a link (import `Link from "next/link"` if not already imported):

```tsx
<Link
  href="/agents/account"
  className="text-[12px] text-accent underline-offset-2 hover:underline"
>
  Manage connections & passkeys → Account
</Link>
```

- [ ] **Step 5: Verify**

Run: `cd interface && npx tsc --noEmit`
Expected: clean. (No `<ActiveConnectionsPanel>` without a `filter` prop remains; `GuardianPasskeysPanel` is now unused but still exported — that's fine, Task 3 renders it on the Account page.)

- [ ] **Step 6: Commit**

```bash
cd /home/mbarr/Project-Alpha && git add interface/src/components/agents/connectionRow.tsx interface/src/components/agents/ActiveConnectionsPanel.tsx interface/src/components/agents/ConnectAgentPanel.tsx interface/src/components/agents/BootstrapAgent.tsx
git commit -m "feat(interface): ActiveConnectionsPanel filter prop + capability badge + hide revoked; declutter Connect page"
```

---

### Task 3: `GuardianPasskeysPanel` hide-revoked + new Account page + nav

**Files:**
- Modify: `interface/src/components/agents/GuardianPasskeysPanel.tsx`
- Create: `interface/src/app/agents/account/page.tsx`
- Modify: `interface/src/components/agents/AgentShell.tsx` (nav)

**Interfaces:**
- Consumes: `ActiveConnectionsPanel({ filter })` + `RevokeButton` from Task 2; `RequireAuth`, `AgentShell`, `Card` (from `@/components/onboarding/primitives`).

- [ ] **Step 1: `GuardianPasskeysPanel` — hide revoked + shared RevokeButton**

In `interface/src/components/agents/GuardianPasskeysPanel.tsx`:
- Add the import `import { RevokeButton } from "@/components/agents/connectionRow";`.
- In the load effect, filter revoked: change `if (!cancelled) setPasskeys(list);` to `if (!cancelled) setPasskeys(list.filter((p) => !p.revokedAt));`.
- Move the confirm into `RevokeButton`: delete the `window.confirm(...)` block at the top of `onRevoke` (keep the rest of `onRevoke`).
- Replace the inline `<button ...>{p.revokedAt ? "Revoked" : "Revoke"}</button>` with:

```tsx
<RevokeButton
  disabled={busy}
  confirmMessage="Revoking stops this passkey from creating new agents. Existing agents are unaffected. Continue?"
  onRevoke={() => void onRevoke(p.id)}
/>
```

(The `cx` import may become unused after removing the old button — drop it if `npx tsc`/biome flags it.)

- [ ] **Step 2: Create the Account page**

Create `interface/src/app/agents/account/page.tsx`:

```tsx
"use client";

import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";
import { ActiveConnectionsPanel } from "@/components/agents/ActiveConnectionsPanel";
import { GuardianPasskeysPanel } from "@/components/agents/GuardianPasskeysPanel";
import { Card } from "@/components/onboarding/primitives";

export default function AccountPage() {
  return (
    <RequireAuth>
      <AgentShell title="Account" subtitle="Tenant-wide connections & guardian passkeys">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6">
          <Card>
            <p className="text-[12px] text-muted-2">
              These operate across your whole tenant. Bootstrap connections can act on any of your
              agents; guardian passkeys authorize creating new agents. Per-agent connections live on
              each agent&apos;s dashboard.
            </p>
          </Card>
          <Card>
            <ActiveConnectionsPanel filter={{ mode: "tenant" }} />
          </Card>
          <Card>
            <GuardianPasskeysPanel />
          </Card>
        </div>
      </AgentShell>
    </RequireAuth>
  );
}
```

(Confirm `Card` is exported from `@/components/onboarding/primitives` — the map says it is; if the export name differs, use the actual bordered-panel primitive.)

- [ ] **Step 3: Add the "Account" nav entry**

In `interface/src/components/agents/AgentShell.tsx`, add a `NavLink` right after "My agents" (line ~36):

```tsx
<NavLink href="/agents">My agents</NavLink>
<NavLink href="/agents/account">Account</NavLink>
<NavLink href="/agents/connect">Connect an agent</NavLink>
```

- [ ] **Step 4: Verify (types + build)**

Run: `cd interface && npx tsc --noEmit && npm run build`
Expected: tsc clean; `npm run build` succeeds (the new route compiles).

- [ ] **Step 5: Manual pass (no test runner)**

With the backend running, sign in and check: `/agents/account` shows tenant-wide connections (badge + "Tenant-wide") + guardian passkeys, no revoked entries; revoking one makes it disappear; a per-agent dashboard's Connections shows only that agent's keys with a badge; the "Connect an agent" page no longer lists keys and shows the "Manage → Account" link; the "Account" nav entry works; loading `/agents/account` logged-out shows the RequireAuth sign-in card.

- [ ] **Step 6: Commit**

```bash
cd /home/mbarr/Project-Alpha && git add interface/src/components/agents/GuardianPasskeysPanel.tsx interface/src/app/agents/account/page.tsx interface/src/components/agents/AgentShell.tsx
git commit -m "feat(interface): tenant Account page (connections + passkeys), Account nav, hide revoked passkeys"
```

---

## Self-Review

**Spec coverage:** backend `entityId`+`capability` → Task 1 ✓ · new Account page + nav + RequireAuth → Task 3 ✓ · ActiveConnectionsPanel filter contract + hide revoked + badge → Task 2 ✓ · GuardianPasskeysPanel hide revoked → Task 3 ✓ · BootstrapAgent cleanup + link → Task 2 ✓ · per-agent call site → Task 2 ✓ · shared RevokeButton + confirm + capability colors → Task 2 (primitives) + Tasks 2/3 (usage) ✓.

**Deliberate simplification (note vs spec):** the spec §5 mentioned "a created date" on each row; the plan omits it (the `created_at` unit isn't displayed anywhere today and adds a timestamp-unit risk under the deadline) — rows show the capability badge + a scope label + the short id instead. Easy to add later.

**Placeholder scan:** every code step has complete code; the two "find-and-change" steps (ConnectAgentPanel call site, BootstrapAgent removals) name the exact JSX/imports to change.

**Type consistency:** `ConnectionFilter`/`filter` prop shape identical in `ActiveConnectionsPanel` (Task 2) and its two call sites (`ConnectAgentPanel` Task 2 `mode:"entity"`, Account page Task 3 `mode:"tenant"`). `CapabilityBadge`/`RevokeButton` signatures identical across `connectionRow.tsx` (Task 2) and consumers (Tasks 2-3). `ApiKeyView.entityId/capability` added in Task 1 are consumed in Task 2's filter + badge.
