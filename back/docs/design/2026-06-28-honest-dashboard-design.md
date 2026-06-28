# Honest Dashboard — Design (Circle / Vivienne demo)

> Status: design approved 2026-06-28. Goal: make the onboarding dashboard **truthful** —
> real on-chain treasury data + a **real** guardian freeze — for the 2026-06-29 Circle product
> call. Built tonight; backend redeployed via VPS SSH, frontend via Vercel.
> Branch: `feat/honest-dashboard`, cut from `main` AFTER PRs #4 (MCP) + #5 (onboarding hardening)
> merge. **Stretch (separate, time-permitting):** wire live x402 nanopayment settlements into the
> Activity card.

## 1. Context & goal

The deployed onboarding wizard (`project-alpha-pi.vercel.app` + VPS backend `159.223.137.183:8789`)
is real end-to-end — SIWE login, passkey, on-chain deploy, treasury funding all work (4 agents
onboarded, 2 `funded`). But the final dashboard screen
(`interface/src/components/onboarding/steps/DashboardStep.tsx`) shows **mocked** data:

- `balance` = the daily-cap the user *typed* (not chain).
- "Spent today" = hardcoded `420`.
- Activity list + "Vendor payout · Held" row = hardcoded fiction.
- Guardian pause / veto / recover = local React state, no backend/chain call.

For a Circle **product** call we must not present mocks as real. This change makes the dashboard
truthful: real treasury balance + available-vs-cap, a **real on-chain guardian pause**, and removal
of the fakes.

**Already real — keep unchanged:** the on-chain identity card (agentId, treasury, operator,
guardian, create/bind/fund tx links) and the active-rules card (from the user's config).

## 2. Scope

**In (v1, tonight):**
- Backend read endpoint for real treasury state.
- Frontend: real balance / available / cap / paused; **real on-chain pause/unpause**; remove fake
  activity + fake veto/recover; honest empty Activity state.

**Out of scope:**
- Live x402 nanopayment settlements in the Activity card → **STRETCH**, separate pass, only after v1
  is solid + deployed (needs the never-run-live nanopayment pipeline stood up: ANTHROPIC + pocket/
  customer keys + a funded pocket; see [[lepton-hackathon-nanopayment-agent]]).
- **Veto** + **Recover** guardian actions — no real held-payout concept exists, and recover is a
  destructive treasury sweep we don't want one mis-click from in a live demo. Removed for v1.
- "Tier 2 wallet" stat card — leave labelled "soon" or remove.

## 3. Backend

New route **`GET /entities/:id/treasury`** (JWT, tenant-scoped — same auth/ownership pattern as
`GET /entities/:id`). For the entity's treasury (`rec.treasury`, set once status ≥ `bound`):

| Field | Source |
|---|---|
| `usdcBalance` | ERC-20 `balanceOf(rec.treasuryConfig.usdc, rec.treasury)` — **add** `ArcAdapter.usdcBalanceOf(usdc, owner): Promise<bigint>` |
| `available` | `ArcAdapter.treasuryAvailable(rec.treasury)` (cap − spent this window) — exists |
| `paused` | `ArcAdapter.treasuryPaused(rec.treasury)` — exists |
| `cap`, `period` | from stored `rec.treasuryConfig` (no chain call) |

- Returns JSON; all USDC amounts as **atomic decimal strings** (6 decimals): `{ usdcBalance,
  available, cap, period, paused }`.
- Guards: 404 if entity missing or `rec.ownerTenantId !== tenantId`; if `!rec.treasury` (not yet
  bound) → 409 `{ code: "not_ready" }`.
- Wiring: add `arc: ArcAdapter` to `ApiDeps` (the `arc` adapter is already constructed in
  `api/main.ts` — just pass it through). Mount in a new `src/api/routes/treasury.ts`
  (`mountTreasuryRoutes`) behind `requireAuth`, to keep `onboard.ts` focused.
- Reuse the existing `ApiError`/`apiOnError` envelope.

## 4. Frontend

- `src/lib/api/client.ts`: add `getEntityTreasury(token, id): Promise<TreasuryView>` +
  `TreasuryView` type in `src/lib/api/types`.
- `DashboardStep.tsx`:
  - Fetch treasury on mount and poll (~5 s) while on the dashboard.
  - Replace the `balance` StatCard with real `usdcBalance`; "Spent today" with real `cap − available`
    over `cap` (progress bar from real numbers); drive the **status pill** + the **pause toggle**
    from the real `paused` flag.
  - Delete the `ACTIVITY` constant + the hardcoded "Vendor payout · Held" row → render an honest
    empty state ("No agent payments yet — the agent hasn't transacted"). (Stretch fills this with
    real settlements.)
  - **Guardian pause/resume → REAL:** the connected wallet (which *is* the guardian — onboarding set
    `guardian = tenant = the SIWE wallet`) calls the treasury `pause()` / `unpause()` via wagmi
    `useWriteContract`; on confirmation, re-fetch `/treasury` and reflect the real `paused`. Handle
    pending + error (e.g. wrong-wallet revert) states.
  - Remove the veto + recover actions and their `ConfirmDialog` branches.
  - Keep the on-chain identity card + rules card unchanged.
- Needs a minimal treasury ABI fragment (`pause()`, `unpause()`, `paused()`), the treasury address
  from `entity.treasury`, the Arc chain config (already in `src/lib/chain`).
- **Heed `interface/AGENTS.md`:** read `node_modules/next/dist/docs/` and confirm the installed
  **wagmi / viem** API surface before writing — do not trust training-data versions.

## 5. Testing & verification

- **Backend:** unit test — route tenant-scoping + response shape with a fake `ArcAdapter`; an anvil
  `*.int.test.ts` reading a real deployed treasury's balance/available/paused. Run `npm test` +
  `npm run lint` + `npm run typecheck` green.
- **Frontend:** manual verification against the live (or local) backend — use a `funded` agent
  (e.g. `TestAgentMB_1`, treasury `0x9f01EF22…`): confirm the dashboard shows the **real** balance,
  then click Pause → wallet signs → confirm `paused` on Arcscan **and** in the UI; Resume to restore.
- **Rehearse the full demo path once before the call.**

## 6. Deploy (order matters: backend first)

- **Backend (me, via SSH):** on the VPS, `git -C /root/Project-Alpha pull` the merged code,
  `npm install` if deps changed, `systemctl restart legalbody-api`, confirm `/healthz` + a curl of
  the new `/entities/:id/treasury` (with a token).
- **Frontend (user, Vercel):** deploy after the backend endpoint is live, else the dashboard 404s.

## 7. Risks

- wagmi/viem version drift → local docs first (`AGENTS.md`).
- The pause tx needs the guardian wallet connected + USDC gas on Arc → confirm the demo wallet has a
  little USDC.
- Redeploying the colleague's frontend → user has Vercel access; coordinate.
- Keep all edits additive + scoped; do **not** touch the onboarding saga (PR #5 territory) or the
  MCP server (PR #4).

## 8. Deliverables

1. `ArcAdapter.usdcBalanceOf` + `GET /entities/:id/treasury` + `ApiDeps` wiring + tests.
2. `client.getEntityTreasury` + `DashboardStep` real data + real pause + mocks removed.
3. Backend redeployed (VPS) + frontend redeployed (Vercel).
4. A rehearsal confirming real balance + a real on-chain freeze.
