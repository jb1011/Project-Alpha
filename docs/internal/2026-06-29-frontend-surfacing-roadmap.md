# Frontend Surfacing Roadmap — exposing the built-but-invisible backend

> Status: draft for team review, 2026-06-29. Author: backend audit (Martin/Claude).
> Goal: turn already-built backend capability into product. **No backend feature work is
> required for most of this** — it is almost entirely frontend surfacing.

## TL;DR

Project-Alpha has three backend "faces": **(A) onboarding + treasury**, **(B) MCP server**,
**(C) jobs + reputation**. Only **A** is meaningfully in the UI. B and C are fully built, routed,
and (for C) on-chain-proven — but a user can't see or reach them. Separately, the **governed
treasury can't be governed from the UI** (only pause/unpause is wired). This doc specs the work to
close those gaps and suggests an owner split.

Sequencing matters: the dashboard is currently the **last step of the onboarding wizard**
(session-bound, no standalone URL). Jobs/keys/governance all belong *in an agent's dashboard*, so
**Phase 1 (standalone dashboard + agents list) is the foundation** for the rest.

## Ownership at a glance (front vs back)

The work is **~80% frontend, ~20% backend**. The backend pieces are few, small, and well-defined —
they're the *interfaces* the frontend consumes.

| Item | Frontend (interface/) | Backend (back/backend/) |
|---|---|---|
| **P1 — My Agents + standalone dashboard** | `app/agents` list, `app/agents/[id]`, redirect after onboarding, nav links | — (routes already exist) |
| **2a — Jobs & reputation** | "Jobs & Reputation" card (display-only) + client fns | `GET /entities/:id/reputation` |
| **2b — MCP keys** | API-keys / "Connect via MCP" panel + client fns | — (routes already exist) |
| **2c — Governance Settings page** | Settings page; guardian wagmi (allowlist, veto, emergency, rotate); cap-change UI; timelock banner | manager-signed cap/period policy route |
| **Bug ① — allowlist** | wire creation recipients + Settings (guardian `setAllowlistEntry` wagmi) | tiny: derive `allowlistEnabled` from recipients |
| **Bug ② — per-tx cap** | map the per-payment field + Settings edit | `perTxCapUsdc` spec field + `evaluatePolicy` enforcement + edit route |

**Interfaces to agree up front** (so both sides can build in parallel): the `GET …/reputation`
response shape, the `POST …/policy` request/response, and the `perTxCapUsdc` field name + units.

---

## Phase 1 — Foundation: "My Agents" + a standalone agent dashboard

**Why:** A returning user currently has no way back to an existing agent — the dashboard only
exists at the end of a fresh onboarding session. This also blocks demoing a specific agent and is
the host for every feature below.

**Backend: already exists.** `GET /entities` (list, tenant-scoped) and `GET /entities/:id`
(+ `/treasury`, `/runs`) — all live. `listEntities()` is already in the API client but **unused**.

**Frontend work:**
- New route `app/agents/page.tsx` — **"My Agents"** list (calls the existing `listEntities`; one user
  can own multiple agents), each row linking to its dashboard. Show name, status badge, treasury
  short-addr, balance. Include a **"Create a new agent"** button → the onboarding wizard.
- New route `app/agents/[id]/page.tsx` — render the existing `DashboardStep` content for any owned
  entity by id (reuse the component; fetch via `getEntity`/`getEntityTreasury`/`getEntityRuns`).
- **DECIDED (Option A):** onboarding's final step **redirects to `/agents/[id]`** — a single,
  bookmarkable standalone dashboard. The wizard does **not** keep its own duplicate dashboard screen.
- **Each agent dashboard has two nav affordances:** (a) a link back to **"My Agents"** (the generic
  list of all the user's agents), and (b) a **"Create a new agent"** button/link → the onboarding flow.
- Gate all routes behind the existing auth (SIWE/JWT). 404/redirect if not owned.

**Open decisions:** list/dashboard empty-state copy (minor, defer to build).

**Effort:** S–M. **Owner:** Frontend (colleague). No backend changes.

---

## Phase 2a — Jobs & Reputation (Track C)

**Why:** Beyond buying/selling data, the agent can complete on-chain **ERC-8183 jobs** to earn USDC
and build an **on-chain reputation** that travels with it. This is a whole shipped subsystem with
zero UI.

**Scope (decided):** we are **NOT building a jobs *marketplace*** — other builders already do that on
ERC-8183, and it isn't our platform's goal right now. We surface the agent's **job history +
reputation as a verifiable track record**, display-only (like the activity feed).

**Backend: mostly exists.** `GET /entities/:id/jobs` (list), `GET /jobs/:jobKey` (status, addresses,
budget, deliverable hash, tx hashes). Jobs are created **out-of-band** (operator/programmatic, like
the live agent runs) — the dashboard *reads*, it does not start them. **One small new backend route
needed:** `GET /entities/:id/reputation` — reputation lives on-chain and has no route yet (owner: me).
`POST /entities/:id/jobs` exists but the frontend does **not** call it (no start-a-job button).

**Frontend work:**
- Add client fns: `listEntityJobs(token, id)`, `getJob(token, jobKey)`, `getEntityReputation(token, id)`.
- A **"Jobs & Reputation"** card on the agent dashboard: the **reputation score** up top, then a
  **display-only list** of jobs (status, budget, USDC earned, deliverable, tx links). No start button.
- Poll job status like the treasury/runs polls (5s) until terminal.

**DECIDED:** (A) **display-only** — no "Start a job" button (jobs originate outside the platform; a
"start a *test* job" trigger can come later behind a demo toggle). (B) **show the reputation score** —
add the small `GET /entities/:id/reputation` backend route.

**Effort:** M (frontend) + S (one backend reputation read route, me). **Owner:** Frontend (colleague)
+ backend (me) for the reputation route.

---

## Phase 2b — API Keys + "Connect via MCP" (Track B)

**Why:** The MCP server (5 tools, live at `POST /mcp`) lets a user's agent be driven from MCP
clients (Claude, Cursor, etc.) — but there's **no UI to create the API key** it needs, so the whole
MCP product is unreachable by end users.

**Backend: already exists.** `POST /api-keys` (mint), `GET /api-keys` (list — labels only, never the
secret), `DELETE /api-keys/:id` (revoke).

**Frontend work:**
- Add client fns: `mintApiKey(token, label)`, `listApiKeys(token)`, `revokeApiKey(token, id)`.
- A **"Developer / MCP access"** panel (settings page or dashboard tab): mint key (show the
  plaintext **once**, with a copy button + "you won't see it again" warning), list/revoke existing
  keys, and a **connect snippet** — the MCP endpoint URL + a ready-to-paste client config block.

**Open decisions:** (1) account-level keys or per-agent? (audit: keys are tenant-scoped, so
account-level — confirm). (2) Connect-snippet uses these **verified** values: endpoint `POST https://project-alpha-pi.vercel.app/mcp` (Streamable HTTP, stateless), auth header `Authorization: Bearer <api-key>`; just settle the client-config block shape for Claude/Cursor.

**Effort:** S–M. **Owner:** Frontend (colleague). No backend changes.

---

## Phase 2c — Treasury governance controls (make the governed treasury *governable*)

**Why:** The dashboard *shows* the rules (cap, period, allowlist) but the only write it performs is
pause/unpause. The contract supports a full governance lifecycle that's never exposed. This is the
richest story to complete: *"you set the rules — and you can change them, on a timelock you control,
with a guardian veto."*

**Roles decide who signs (verified against `back/src/AgentTreasury.sol` modifiers + on-chain role holders):**
- **guardian = the user's connected wallet** → `pause`/`unpause`, `setAllowlistEntry`,
  `vetoPolicyUpdate`/`liftVeto`, `emergencyWithdraw`, `setOperator` are all **guardian-gated →
  direct wagmi writes, exactly like the existing `pause()`** (no backend).
- **manager = the platform key (backend-held)** → `schedulePolicyUpdate` + `executePolicyUpdate`
  (i.e. **changing cap/period**) are **manager-gated → the user's wallet CANNOT sign them**. These
  need a small backend route that signs as the manager.
- **operator = the per-agent vault key (backend)** → `spend`/`fundOperator` only; not user-facing.

**DECIDED — placement:** the dashboard stays **read-only** (rules shown, plus the existing
**Freeze/pause** button as the one-click emergency stop) with a small **⚙ Settings** button. **ALL
rule modifications — everyday *and* break-glass — live on a dedicated Settings page**
(`/agents/[id]/settings`), to keep the dashboard clean (per user: "purest UI").

**Settings page — guardian wagmi writes (extend `treasuryAbi.ts`, signed by the user's wallet like `pause`):**
- **Manage allowlist:** `setAllowlistEntry(account, allowed)` — add/remove allowed payees (see Bug ① below).
- **Guardian veto:** `vetoPolicyUpdate(policyId)` / `liftVeto(policyId)` on a pending change.
- **Emergency withdraw:** `emergencyWithdraw()` — high-friction, confirm modal.
- **Rotate operator:** `setOperator(newOperator)` — advanced/rare.
- **Pending-policy display:** read `pendingPolicy`/`policyVetoed`; show a timelock countdown banner.

**Settings page — the one backend-signed action (cap/period change):**
- Change the **daily/period cap** via a manager-signed route, e.g. `POST /entities/:id/policy`
  (schedule) + execute-after-timelock. Routes through the backend (manager = platform key), **not**
  wagmi, because only the manager may schedule/execute. (Small backend route, owner: me.)

**Open decisions:** timelock UX (pending-change banner + countdown) — a build detail, not blocking.

**Effort:** M–L (write-heavy). **Owner:** Frontend (colleague) for the Settings page + guardian wagmi
actions; backend (me) for the manager-signed cap/period policy route.

---

## Confirmed bugs to FIX (found during this audit — real defects, not just missing UI)

Independent of the new features above, the audit surfaced two things the creation form *collects*
but the system does **not** apply. Verified in code.

### Bug ① — Allowlist addresses can never be set
`AgentSpec` has only `allowlistEnabled` (a bool); there is **no field for which addresses are
allowed**, and `setAllowlistEntry` is **never called** anywhere in the backend
(`back/backend/src/policy/agentSpec.ts:60`; grep: `setAllowlistEntry` appears only in the ABI). The
creation form's "recipient allowlist" input is therefore **collected and dropped**. Worse: if a user
*enables* the allowlist, the agent can pay **no one** (no entry is ever added → `isAllowed` is false
for everyone), silently blocking every payment.
**DECIDED — (a) wire it for real + also add to Settings.** Make the creation-form allowlist actually
work, and add the same management to the Settings page. Behavior:
- **Empty → `allowlistEnabled=false` → everyone allowed.** Zero extra signatures — the common case.
- **Filled → `allowlistEnabled=true` (set at deploy) + one `setAllowlistEntry` per address.**

`setAllowlistEntry` is **guardian-gated → signed by the user's OWN wallet** (a wagmi tx like `pause`),
**not** a backend/enclave cost. Work: (frontend) carry the entered recipients and issue the guardian
`setAllowlistEntry` writes after deploy in the wizard, and the same management in Settings; (backend,
tiny) derive `allowlistEnabled` from whether recipients were provided. This also **fixes the current
bug** where typed recipients are dropped.

### Bug ② — Per-payment cap is collected but not enforced
The spec/contract have only a per-*period* cap (`spendingCapUsdc` + `spendingPeriod`); there is **no
per-transaction cap field and no per-tx check** in the Payment Authority (`evaluatePolicy` checks
only available/paused/allowlist — `back/backend/src/payments/authority.ts`). The creation form's
"per-payment cap" is **collected and silently dropped** — the only real limit is the daily/period cap.
**DECIDED — (a) implement a real per-tx cap.** (backend, me) add a `perTxCapUsdc` field to the spec +
enforce it in the Payment Authority's `evaluatePolicy` (off-chain — no contract change): reject any
single payment over the cap. It's stored as off-chain Authority policy (with the entity), so the
on-chain per-*period* cap stays the hard timelocked guardrail, while the per-tx cap is an additional
check that's **editable instantly via a backend route** (no timelock). (frontend) the creation
"per-payment" field now maps to it, and it's editable in Settings. Makes the existing UI honest +
adds a real per-payment safety lever.

---

## Smaller / polish (opportunistic)
- **Explorer links + live identity:** link agentId/treasury/tx to testnet.arcscan.app; optionally
  verify `ownerOf`/`getAgentWallet` live (reads exist in the adapter; would need small routes or
  wagmi reads).
- **Schema-driven config form:** `fetchAgentSchema()` is defined-but-unused — drive ConfigureStep
  from the live JSON-Schema instead of a hardcoded form (DRY).

## Explicitly OUT of scope (do not build — intentional)
- **No "run the agent" button** — the live x402 loop runs out-of-band by design; the activity feed
  is display-only.
- **No step-by-step job UI** — the job saga is atomic (start + poll), not manual stages.

---

## Suggested split & order
1. **Phase 1 (foundation)** — frontend, after PR #7 merges (it touches `DashboardStep`, so avoid
   conflicts until then).
2. **2b (MCP keys)** and **2a (Jobs)** in parallel — both mostly frontend; I take the reputation read
   route for 2a.
3. **2c (governance Settings page)** last — biggest, write-heavy.
4. **Bugs ① + ②** fold into the relevant work: ① with the allowlist UI (creation + Settings), ② with
   2c / the per-tx cap (backend, me).

**Backend work total (all me, all small):**
- `GET /entities/:id/reputation` — reputation read (Phase 2a).
- Manager-signed cap/period policy route — `POST /entities/:id/policy` schedule + execute (Phase 2c).
- `perTxCapUsdc` spec field + `evaluatePolicy` enforcement + an edit route (Bug ②).
- Derive `allowlistEnabled` from whether recipients were provided at creation (Bug ①, tiny).

Everything else is either surfacing routes that already exist, or guardian-signed wagmi writes from
the user's own wallet (like the existing `pause`).
