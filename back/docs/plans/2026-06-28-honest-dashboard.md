# Honest Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the onboarding dashboard truthful for the 2026-06-29 Circle call — real on-chain treasury data + a real on-chain guardian pause, replacing the mocked balance/activity/guardian widgets.

**Architecture:** A new tenant-scoped backend read endpoint exposes the treasury's real on-chain state (USDC balance, available-vs-cap, paused). The dashboard fetches it and renders real numbers; the guardian Pause becomes a real wagmi `writeContract` to the treasury's `pause()/unpause()` signed by the connected (guardian) wallet. Fake activity + veto + recover are removed.

**Tech Stack:** Backend — TypeScript, Hono, better-sqlite3, viem, vitest. Frontend — Next 16.2, wagmi 3.6, viem 2.53, Tailwind.

**Reference spec:** `back/docs/design/2026-06-28-honest-dashboard-design.md`. Branch `feat/honest-dashboard`. Backend redeployed via VPS SSH; frontend via Vercel.

## Global Constraints

- Backend: `tenantId` from the authed session only (`c.get("tenantId")`); tenant-check every entity read (`rec.ownerTenantId !== tenantId` → 404). USDC amounts are atomic decimal strings (6 decimals). Reuse `ApiError`/`apiOnError`. Additive-only to `app.ts`/`main.ts`.
- Frontend: **heed `interface/AGENTS.md`** — read `node_modules/next/dist/docs/` and confirm the installed **wagmi 3.6 / viem 2.53** hook API before writing wallet code; do NOT trust training-data versions. Match existing component/styling patterns in `interface/src/components/onboarding/steps/`.
- Backend cwd `back/backend`; frontend cwd `interface`. Lint/typecheck/test: backend `npm run lint && npm run typecheck && npm test`; frontend `npm run lint && npm run build`.

---

## Phase 1 — Backend (real treasury reads)

### Task 1: `ArcAdapter.usdcBalanceOf`

**Files:**
- Modify: `back/backend/src/adapters/arc/arcAdapter.ts`

**Interfaces:**
- Produces: `usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint>` — ERC-20 `balanceOf`.

- [ ] **Step 1: Implement** — add to `ArcAdapter` (mirror the existing `treasuryAvailable` readContract shape; there is already a minimal ERC-20 fragment near the top of the file — extend it with `balanceOf` or define a local one):

```ts
/** Real ERC-20 USDC balance of an address (e.g. the treasury vault). */
async usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint> {
  return this.d.publicClient.readContract({
    address: usdc,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [owner],
  });
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` (no dedicated unit test; this thin read is verified end-to-end via Task 2's route test with a fake adapter + the live curl in Deploy). 

- [ ] **Step 3: Commit** — `git add src/adapters/arc/arcAdapter.ts && git commit -m "feat(arc): usdcBalanceOf read"`

---

### Task 2: `GET /entities/:id/treasury` route + `ApiDeps` wiring

**Files:**
- Create: `back/backend/src/api/routes/treasury.ts`
- Modify: `back/backend/src/api/app.ts` (ApiDeps += `arc`; mount under `requireAuth`)
- Modify: `back/backend/src/api/main.ts` (pass the already-constructed `arc` into deps)
- Test: `back/backend/test/api/treasury.routes.test.ts`

**Interfaces:**
- Consumes: `ArcAdapter.usdcBalanceOf/treasuryAvailable/treasuryPaused` (Task 1 + existing), `EntityRepository.findByIdempotencyKey`, `requireAuth`, `ApiError`.
- Produces: `GET /entities/:id/treasury` → `200 { usdcBalance, available, cap, period, paused }` (all USDC fields atomic decimal strings; `paused` boolean). `404` if not found / not owned. `409 {code:"not_ready"}` if `!rec.treasury`.

- [ ] **Step 1: Extend `ApiDeps`** in `src/api/app.ts` — add to the interface:

```ts
  arc: import("../adapters/arc/arcAdapter").ArcAdapter;
```

- [ ] **Step 2: Mount the route** in `buildApiApp` (after the existing `app.use("/entities/*", requireAuth(...))` guard — that guard already covers `/entities/:id/treasury`; just mount):

```ts
  mountTreasuryRoutes(app, deps);
```
Add import: `import { mountTreasuryRoutes } from "./routes/treasury";`

- [ ] **Step 3: Write the failing test** `test/api/treasury.routes.test.ts` (mirror `test/api/jobs.routes.test.ts` harness — copy its `account`/`DOMAIN`/`CHAIN`/`login`/`beforeEach`; build the app with a fake `arc`; seed a bound entity):

```ts
// ...copy imports + login + db setup from jobs.routes.test.ts...
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";

const FAKE_ARC = {
  usdcBalanceOf: async () => 1_500_000n, // 1.50 USDC
  treasuryAvailable: async () => 800_000n, // 0.80 available
  treasuryPaused: async () => false,
} as unknown as import("../../src/adapters/arc/arcAdapter").ArcAdapter;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  return buildApiApp({
    webOrigin: "*", nonceStore: new SqliteNonceStore(db), siweDomain: DOMAIN,
    chainId: CHAIN, jwtSecret: "s", jwtTtlSec: 3600, repo, runner,
    passkeyRpId: "wizard.local", apiKeys: new SqliteApiKeyStore(db), arc: FAKE_ARC,
  } as never);
}

function seedBound(tenant: string, key: string) {
  const id = `${tenant}:${key}`;
  repo.upsert({
    idempotencyKey: id, name: "A", status: "bound",
    manager: "0x000000000000000000000000000000000000000A" as `0x${string}`,
    guardian: tenant as `0x${string}`, operator: null,
    amendmentDelay: "0", ein: "", formationDate: 0, oaHash: null, metadataURI: null, docPath: null,
    treasuryConfig: { usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
      payoutAddress: "0x000000000000000000000000000000000000000A" as `0x${string}`,
      cap: 1_000_000n, period: 86_400n, allowlistEnabled: false },
    agentId: "42", proxy: null, treasury: "0x000000000000000000000000000000000000000F" as `0x${string}`,
    createTxHash: null, bindTxHash: null, fundTxHash: null, ownerTenantId: tenant,
  });
  return id;
}

test("GET /entities/:id/treasury → 200 real on-chain shape", async () => {
  const app = makeApp(); const token = await login(app);
  const id = seedBound(account.address, "a1");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/treasury`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b).toEqual({ usdcBalance: "1500000", available: "800000", cap: "1000000", period: "86400", paused: false });
});

test("cross-tenant → 404", async () => {
  const app = makeApp(); await login(app);
  seedBound(account.address, "a1");
  const otherToken = await login(app, otherAccount);
  const res = await app.request(`/entities/${encodeURIComponent(`${account.address}:a1`)}/treasury`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(res.status).toBe(404);
});

test("no auth → 401", async () => {
  const app = makeApp();
  expect((await app.request("/entities/x/treasury")).status).toBe(401);
});
```

- [ ] **Step 4: Run, expect fail** — `npx vitest run test/api/treasury.routes.test.ts` → FAIL (route missing).

- [ ] **Step 5: Implement** `src/api/routes/treasury.ts`:

```ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { Address } from "../../types";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

export function mountTreasuryRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/treasury", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    if (!rec.treasury || !rec.treasuryConfig)
      throw new ApiError("not_ready", 409, "treasury not deployed yet");
    const treasury = rec.treasury as Address;
    const usdc = rec.treasuryConfig.usdc;
    const [usdcBalance, available, paused] = await Promise.all([
      deps.arc.usdcBalanceOf(usdc, treasury),
      deps.arc.treasuryAvailable(treasury),
      deps.arc.treasuryPaused(treasury),
    ]);
    return c.json({
      usdcBalance: usdcBalance.toString(),
      available: available.toString(),
      cap: rec.treasuryConfig.cap.toString(),
      period: rec.treasuryConfig.period.toString(),
      paused,
    });
  });
}
```

- [ ] **Step 6: Wire `main.ts`** — add `arc` to the `buildApiApp({ ... })` deps object in `src/api/main.ts` (the `arc` adapter is already constructed there as `const arc = new ArcAdapter(...)`).

- [ ] **Step 7: Run + lint + typecheck** — `npx vitest run test/api/treasury.routes.test.ts && npm run lint && npm run typecheck` → PASS. Then `npm test` once for no regressions.

- [ ] **Step 8: Commit** — `git add src/api/routes/treasury.ts src/api/app.ts src/api/main.ts test/api/treasury.routes.test.ts && git commit -m "feat(api): GET /entities/:id/treasury real on-chain state"`

---

## Phase 2 — Frontend (real data + real pause)

### Task 3: API client + type

**Files:**
- Modify: `interface/src/lib/api/client.ts`, `interface/src/lib/api/types.ts`

**Interfaces:**
- Produces: `getEntityTreasury(token, id): Promise<TreasuryView>`; `TreasuryView = { usdcBalance: string; available: string; cap: string; period: string; paused: boolean }`.

- [ ] **Step 1: Add the type** to `src/lib/api/types.ts`:

```ts
export type TreasuryView = {
  usdcBalance: string;
  available: string;
  cap: string;
  period: string;
  paused: boolean;
};
```

- [ ] **Step 2: Add the client fn** to `src/lib/api/client.ts` (mirror `getEntity`):

```ts
export async function getEntityTreasury(token: string, id: string): Promise<TreasuryView> {
  return request(`/entities/${encodeURIComponent(id)}/treasury`, { token });
}
```
(add `TreasuryView` to the type import from `./types`.)

- [ ] **Step 3: Typecheck** — `npm run build` (or `npx tsc --noEmit`) compiles.

- [ ] **Step 4: Commit** — `git add src/lib/api/client.ts src/lib/api/types.ts && git commit -m "feat(ui): treasury client + type"`

---

### Task 4: Dashboard real data (read-only) — remove the mocks

**Files:**
- Modify: `interface/src/components/onboarding/steps/DashboardStep.tsx`

**Interfaces:**
- Consumes: `getEntityTreasury` (Task 3), the auth token (how the dashboard already gets it — confirm from `OnboardingFlow.tsx`/`AuthProvider.tsx`).

- [ ] **Step 1: Fetch treasury on mount + poll.** Add state + an effect that calls `getEntityTreasury(token, entity.id)` when `entity?.treasury` exists, every ~5 s. (Get `token` the same way other steps do — check `OnboardingFlow.tsx` for how the token is threaded; if not passed to `DashboardStep`, thread it as a prop the same way `entity` is.)

- [ ] **Step 2: Replace the fake StatCards** — delete `const balance = ...` / `const dailySpent = recovered ? 0 : 420`, and render from the fetched `TreasuryView`:
  - "Treasury balance" → `formatUsdc(Number(t.usdcBalance) / 1e6)` USDC (USDC has 6 decimals; confirm `formatUsdc`'s expected input units in `../types`).
  - "Spent today" → `formatUsdc((Number(t.cap) - Number(t.available)) / 1e6)` over `formatUsdc(Number(t.cap)/1e6)` cap; progress bar from `(cap-available)/cap`.
  - Drive the status pill from real `t.paused` (Paused vs Operational), not local state.
  - Show a "—" placeholder while `t` is loading.

- [ ] **Step 3: Delete the fake activity** — remove the `ACTIVITY` constant and the hardcoded "Vendor payout · Held" `<li>`; render an honest empty state in the Activity card: `No agent payments yet — the agent hasn't transacted.`

- [ ] **Step 4: Remove veto + recover** — delete the `GuardianAction` "Veto"/"Recover funds" buttons, the `dialog`/`pendingVetoed`/`recovered` state, and the `ConfirmDialog`'s veto/recover branches (Task 5 keeps only Pause). Remove the now-unused `Tier 2 wallet` card or label it `soon`.

- [ ] **Step 5: Verify in the browser** — `npm run dev`, open the dashboard for a funded agent (point `NEXT_PUBLIC_API_URL` at the VPS or local backend); confirm the real balance shows and matches Arcscan for that treasury. `npm run build` compiles.

- [ ] **Step 6: Commit** — `git commit -am "feat(ui): real treasury data on dashboard; remove mocked balance/activity"`

---

### Task 5: Real on-chain guardian pause

**Files:**
- Modify: `interface/src/components/onboarding/steps/DashboardStep.tsx`
- Create: `interface/src/lib/treasuryAbi.ts`

**Interfaces:**
- Consumes: wagmi 3.6 wallet hooks (confirm the exact API first), `arcTestnet` from `src/lib/chain`, `entity.treasury`.

- [ ] **Step 1: CONFIRM the wagmi 3.6 write API** — read `node_modules/wagmi/README.md` / the installed wagmi dist types and `interface/src/components/providers/Web3Provider.tsx` + `WelcomeStep.tsx` (how the wallet is connected + how the account/wallet-client is obtained). Identify the hook to send a contract write (likely `useWriteContract` → `writeContractAsync`, or `useWalletClient` + viem `walletClient.writeContract`). Do not assume — use what the installed version exposes.

- [ ] **Step 2: Add the treasury ABI fragment** `src/lib/treasuryAbi.ts`:

```ts
export const treasuryAbi = [
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
```
(Confirm the real function names against `back/backend/src/adapters/arc/arcAdapter.ts` `treasuryPaused` / the treasury contract — `paused`/`pause`/`unpause`. If the contract uses different names, match them.)

- [ ] **Step 3: Wire the Pause toggle to a real tx** — replace `onClick={() => setPaused(p => !p)}` with a handler that calls the confirmed wagmi write against `entity.treasury` with `treasuryAbi`, function `paused ? "unpause" : "pause"`, on `arcTestnet`. On success, re-fetch `getEntityTreasury` to reflect the real `paused`. Show pending state on the button; on error (e.g. wrong-wallet revert, no gas) show an inline message and do NOT flip the UI. The toggle's visual state comes from the fetched `t.paused`, never optimistic local state.

- [ ] **Step 4: Verify in the browser** — with the guardian wallet connected (the wallet that onboarded the agent), click Pause → wallet signs → tx confirms → `paused` flips in the UI AND on Arcscan (`treasury.paused()` = true). Click again to Resume. `npm run build` compiles.

- [ ] **Step 5: Commit** — `git commit -am "feat(ui): real on-chain guardian pause/unpause"`

---

## Deploy (order: backend first)

- [ ] **Backend** (over SSH, by the controller). Once the backend tasks are merged to `main`: `ssh root@159.223.137.183`, then `cd /root/Project-Alpha && git checkout main && git pull`, `cd back/backend` (no new deps, so skip `npm install`), `systemctl restart legalbody-api`. Confirm: `curl -s localhost:8789/healthz` → `{"ok":true}`, then `curl` the new `/entities/:id/treasury` with a valid token for a funded agent → real numbers matching that treasury on Arcscan. (If demoing before merge, `git fetch && git checkout feat/honest-dashboard` on the box instead.)
- [ ] **Frontend** (Vercel, by the user): deploy `feat/honest-dashboard` (preview) or merge → production **after** the backend endpoint is live.

## Self-Review

- Spec §3 (backend endpoint) → Tasks 1-2. §4 (frontend real data + real pause + remove mocks) → Tasks 3-5. §5 (verification) → Task 2 test + Task 4/5 browser checks. §6 (deploy) → Deploy section. ✓
- Phasing: Phase 1 (backend) and Task 4 (read-only honest data) are shippable without Task 5 — if the wagmi-v3 pause hits version issues, the dashboard is still honest (real data, pause labelled preview). ✓
- Known risk surfaced: wagmi 3.6 / Next 16 API confirmation (Task 5 Step 1) — do not trust training data.
