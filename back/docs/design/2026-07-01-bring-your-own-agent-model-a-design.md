# Bring Your Own Agent (BYOA) — Model A Design

> Status: brainstormed + approved-in-conversation 2026-07-01. Model A ships first (v1); Model B is
> documented here as v2 (§12). Backend = us; the "Connect your agent" UI + magic-link completion page =
> the frontend colleague.
>
> **Architecture-audited 2026-07-01** (3 adversarial threat-models: custody/governance, app attack-surface,
> cryptographic alternatives). The core model was found sound; the security requirements + the chosen
> spending posture (hybrid) are in **§14**.

**Goal:** Let a user **link their *existing* agent** (Claude Code, Codex, Cursor, OpenClaw, Gemini, or any
MCP-capable agent) to a **user-custodied legal body** it can then fully operate — onboard, get funded,
**earn** (ERC-8183 jobs) and **spend** (governed x402 payments) — all through our MCP server, within the
governance the user sets. This is the **core product**: the legal + financial body for an agent the user
already has.

**Core principle — custody stays with the human owner (Model A).** The operator key is a per-agent
**Turnkey vault the user roots** (guardian-root passkey) + the on-chain **guardian** role; the backend
holds only a **bounded, revocable sign-only delegate**. The linked agent *decides*; it never holds a key
and never escapes the on-chain caps/allowlist/guardian. "The agent operates on a leash the user holds."

---

## 1. Vision & scope (v1 = "link + full operate")

A user brings an agent they already run. In minutes it has a legal body (Wyoming-DAO-LLC + governed USDC
treasury + ERC-8004 identity) and can act economically **through MCP** while the human keeps custody and a
kill-switch. v1 finish line (chosen): the linked agent can **onboard, fund, earn, and spend** via MCP.

**Out of scope for v1** (see §11): Model B / self-custody (v2, §12); native non-MCP plugins
(AgentKit/ElizaOS, v2); a real external-counterparty job marketplace (v1 `run_job` is self-contained,
§4.1); migrating existing agents between custody models.

## 2. What already exists (reused, not rebuilt)

- **MCP server**, live at `/mcp`, per-tenant **Bearer API key → tenantId** auth (`src/mcp/{server,auth,
  transport}.ts`). Tools: `whoami`, `list_entities`, `get_entity`, `fund_treasury`, `onboard_agent` +
  resource `schema://agent-spec`.
- **API keys:** `POST/GET/DELETE /api-keys` behind SIWE/JWT; `ApiKeyStore` (sha-256 hashed, plaintext
  shown once) — `src/persistence/apiKeyStore.ts`, `src/api/routes/apiKeys.ts`.
- **Guardian passkey:** `POST /passkey` behind SIWE/JWT; `PasskeyStore` (attestation by handle) —
  `src/api/routes/passkey.ts`, `src/persistence/passkeyStore.ts`. `onboard_agent` requires a `passkeyId`.
- **Onboarding runner:** `runner.start({spec, userKey, tenantId, guardianPasskey}) → {id, status:'pending'}`,
  poll `get_entity` until `bound`; `runner.fund({id, tenantId, amount})`.
- **Per-agent Turnkey operator vault** (`buildOperatorWalletClientForEntity`) — the Model-A signer.
- **Earn rails:** ERC-8183 job saga (`src/jobs/runJob.ts`, `buildJobDeps`) — proven live (jobId 144629).
- **Spend rails:** Payment Authority (`authorizePayment` / `evaluatePolicy`) + x402/Gateway settle
  (`liveRunner.ts`, `src/payments/*`). The chokepoint that gates every spend.

~80% of the plumbing exists. Net-new = the *linking experience* + two *operate* tools + the *agent-driven
bootstrap hand-off*.

## 3. Two entry paths, one destination (a linked, operating agent)

Because the MCP API key (needed to connect) and the guardian passkey (needed for `onboard_agent`) can
**only** be created by a human in a browser (SIWE login + WebAuthn), every path front-loads a **one-time
human bootstrap**, after which the agent takes over.

### 3.1 Web-first ("link your agent" step in onboarding)
1. Human logs in (SIWE), creates the **guardian passkey**, and the wizard creates the body (existing flow).
2. Wizard lands on a **"Connect your agent"** screen: it mints a **scoped API key** and shows the
   **connection package** (§5) + per-agent snippets (§6).
3. Human pastes the snippet into their agent. The agent is now linked and can operate (§4).

### 3.2 Agent-first (agent-driven, with magic-link hand-off)
1. Human tells their agent (via a short bootstrap prompt we publish) to "get a legal body from Project
   Alpha." The agent cannot connect yet (no key), so it surfaces a **magic link** to the human.
2. The human opens the link → a **bootstrap page** that does SIWE login + creates the guardian passkey +
   mints the API key in one short flow → outputs the **connection package**.
3. The human pastes it back to the agent (or the agent reads it from a returned deep-link token). The agent
   then calls `onboard_agent(spec, passkeyId)` itself, polls `get_entity` until `bound`, funds, and
   operates — driving everything after the bootstrap.

**The magic link** = a short-lived, single-use, high-entropy URL carrying a bootstrap *request* id (not a
tenant). **Binding (see §14.2):** the tenant is derived from the human's **SIWE login**, never from the
agent-supplied link, and before anything is minted the completion page shows an explicit human-readable
**authorization confirmation** ("you are giving agent-key …X guardian custody of body Y, funded from wallet
Z — confirm"). The API key is delivered once on that confirmed, `no-store` page; the agent-first `link_code`
+ `claim_connection` (§4.3) return only a **binding confirmation**, never the key.

## 4. The "operate" MCP tools (full-operate)

All operate tools are **tenant-scoped** (tenantId closed over from the API key, never a tool arg — matching
the current server) and **governed**: every spend still flows through the Payment Authority + on-chain
caps/allowlist, and the guardian can pause on-chain at any time. Custody/governance are unchanged.

### 4.1 `run_job` — earn (ERC-8183)
- **Input:** `{ id: string /* entity idempotency key */, budgetUsdc?: string }`.
- **Behaviour (v1, self-contained):** runs the proven job saga (`buildJobDeps(...).runJob`) with the agent
  as **provider**, signed by its Turnkey operator; the platform stands in for the client + evaluator (temporary — see Evolution below; as in
  the live proof-of-life) so the agent can demonstrate **earning USDC + reputation** on demand. Returns
  `{ jobKey, status, jobId, txHashes… }`; the agent polls a job-status read.
- **Evolution (designed-in, not built in v1):** the client + evaluator are **pluggable seams**. In v1 the
  platform stands in for them because of low initial traction (few registered agents). As registered agents
  reach critical mass, **agents opt in as evaluators — and post jobs as clients** — progressively enabling
  the **full decentralized ERC-8183 agent-to-agent flow** with no rearchitecture. Real independent
  evaluators also strengthen reputation credibility (vs. a platform stand-in). The opt-in / matching
  mechanics for agent-evaluators are future scope; the v1 requirement is only that these roles stay behind
  swappable interfaces so the transition needs no rework.

### 4.2 `pay` — spend (governed x402 payment)
- **Input:** `{ id: string, to: string /* address or x402 resource URL */, amountUsdc: string, idempotencyKey: string }`.
- **Behaviour:** validate `amountUsdc` is a positive integer; if `to` is a URL, **SSRF-guard** it (https
  only; block private/link-local/loopback + cloud-metadata hosts; no redirects to them; strict timeout;
  optional resource-domain allowlist). `authorizePayment` evaluates per-tx + per-period caps and the
  **hybrid allowlist rule (§14.1):** micro-payments (≤ threshold) may pay *any* payee; payments above it
  require an **allowlisted** payee — and the payee the x402 resource returned is re-asserted against that
  rule. If allowed, the Turnkey operator signs and it settles via x402/Gateway. If rejected, returns the
  policy reason (`over-tx-cap`, `over-cap`, `not-allowlisted`, `over-threshold-needs-allowlist`) — **the
  agent cannot spend outside the leash.** `idempotencyKey` dedupes retries (a repeat returns the original
  receipt). Tenant-scoped: re-checks `ownerTenantId === tenantId`. Returns `{ ok, txOrTransferId, reason? }`.

### 4.3 Supporting reads (small additions)
- `get_job(jobKey)` / `list_jobs(id)` — surface job progress to the agent (job HTTP/CLI already exist;
  expose read-only via MCP).
- `treasury_status(id)` — convenience read (available balance, cap, spent-in-window, paused) so the agent
  can reason before spending.
- `claim_connection(link_code)` (agent-first only) — exchange the one-time code from the bootstrap page for
  confirmation the agent is bound to the right body (the API key itself is already the auth).

## 5. The connection package

Produced after the human bootstrap (either path). Contains:
- `mcp_url` — the server endpoint (`https://…/mcp`).
- `api_key` — a **scoped, revocable** Bearer key bound to this tenant/body (sha-256 hashed at rest; shown
  once).
- `passkey_id` — the guardian passkey handle `onboard_agent` needs (agent-first path).
- `entity_id` — present if the body already exists (web-first path); absent if the agent will onboard.
- Rendered as **per-agent snippets** (§6).

## 6. Per-agent "paste-here" snippets (universal MCP; Claude Code = flagship)

The server is identical for all; only the *registration format* differs. Ship a snippet generator that
emits, from one connection package, the config for each of the **main agents**:

- **Claude Code** (flagship — first verified E2E + the demo):
  `claude mcp add legalbody --transport http <mcp_url> --header "Authorization: Bearer <api_key>"`
- **Cursor** — `~/.cursor/mcp.json` entry (url + `Authorization` header).
- **Codex** (OpenAI) — its MCP config entry.
- **OpenClaw** — its MCP/tool config entry.
- **Gemini CLI** — its MCP config entry.
- **Generic MCP** — raw `{ url, headers: { Authorization } }` any MCP client accepts.

Snippets are generated from a small per-agent template map; adding an agent = adding a template. Claude
Code is the one we test end-to-end, demo, and lead the docs with — no other agent is second-class.

## 7. Components / seams to build

**Backend (us):**
- `POST /connection-package` (behind SIWE/JWT) — mint scoped key + assemble the package + snippets.
- Snippet generator (`src/mcp/snippets.ts`) — package → per-agent config strings.
- Magic-link / bootstrap: a short-lived single-use **bootstrap token** store + `POST /bootstrap/start`
  (issues the link) + the bootstrap-completion path that runs login→passkey→key-mint and emits the package;
  plus `claim_connection` MCP tool.
- New MCP tools: `run_job`, `pay`, `get_job`, `list_jobs`, `treasury_status`, `claim_connection` — wired to
  the existing job saga + Payment Authority + Turnkey operator.
- A published **bootstrap prompt** (docs) the user gives their agent for the agent-first path.

**Frontend (colleague):**
- "Connect your agent" screen (connection package + copyable per-agent snippets).
- A "link an existing agent" entry point in onboarding.
- The magic-link **bootstrap page** (SIWE + passkey + key-mint in one short flow).

## 8. Data model

- **Bootstrap-link record** (new, ephemeral): `{ token, tenantId?, status: pending|completed|expired,
  createdAt, expiresAt, link_code? }`. Single-use, short TTL.
- **API keys** already bind to `tenantId`; add an optional `entityId` scope + a `label` so a body can have
  named, individually-revocable keys (extend `ApiKeyStore`).
- No change to entity/treasury schema (custody stays "turnkey"; the `custody` field already exists for the
  v2 Model B branch).

## 9. Error handling

- **Spend rejected by policy** → return the exact Payment Authority reason; never silently drop.
- **Key revoked / invalid** → MCP 401 (existing auth). Guardian can revoke a key or pause on-chain to cut
  the agent off instantly.
- **Magic link expired / reused** → clear error + re-issue; single-use enforced.
- **Passkey missing on `onboard_agent`** → existing "passkey handle not found" error; the agent-first flow
  guarantees the bootstrap creates it first.
- **Onboarding still pending** → tools that need `bound` return a "not bound yet, poll get_entity" error.

## 10. Testing

- **Unit:** snippet generator (each agent format), connection-package assembly, bootstrap-token lifecycle
  (issue/complete/expire/reuse), `pay` policy-gating (allowed + each rejection reason), `run_job` wiring
  (mocked saga).
- **Integration:** agent-driven onboard via MCP with the human bootstrap mocked → `bound`; a governed `pay`
  that is allowed and one that is rejected; a `run_job` self-contained loop (mocked chain).
- **E2E (flagship):** Claude Code connects with a real snippet against a test server and drives
  onboard → fund → run_job → pay. Verified first for Claude Code, smoke-checked for one other (generic MCP).
- **No regressions:** existing MCP tools + onboarding stay green; governance tests unchanged.

## 11. Sequencing (slices)

1. **Slice 1 — Connect (web-first):** `POST /connection-package` + snippet generator + the "Connect your
   agent" screen. Links an *already-onboarded* body to an agent. Smallest shippable increment.
2. **Slice 2 — Operate:** `pay` + `run_job` (+ `treasury_status`, `get_job`, `list_jobs`) MCP tools, fully
   governed. Now the linked agent earns + spends. E2E in Claude Code.
3. **Slice 3 — Agent-first bootstrap:** magic-link / bootstrap page + `claim_connection` + the published
   bootstrap prompt. The agent can drive its own onboarding after a one-time human bootstrap.
4. **Slice 4 — Snippet breadth + docs:** Cursor / Codex / OpenClaw / Gemini / generic snippets + per-agent
   docs; Claude Code demo recorded.

## 12. v2 — Model B (self-sovereign "bring your own key") — documented, not built

For **crypto-native agents that already self-custody** (Coinbase AgentKit, ElizaOS, and other Bucket-2
frameworks), offer custody Model B: the agent brings **its own wallet**, bound to its on-chain identity via
**ERC-8004 `setAgentWallet`** (EIP-712 proof from the agent's key), and it **signs its own** operator
actions. Custody sits with the agent (or its human owner), not a managed vault.

**What v2 adds on top of Model A:**
- A `custody: "self"` onboarding branch (skip Turnkey provisioning; take the agent's own address as
  operator + agentWallet). The `custody` field already exists in spec/entity/DB.
- **Self-signed identity binding** — an MCP round-trip: return the `setAgentWallet` typed data → the agent
  signs → we submit.
- **External / remote-signer path** in the runners — a viem "remote-signer account" whose signing calls
  back to the agent over MCP; introduces async signing (offline/timeout/retry) into today's synchronous
  flows. This is the main new engineering (~1–2 weeks) and warrants its own design.
- **Native plugins** for non-MCP frameworks (an AgentKit action, an ElizaOS plugin) so Bucket-2 agents can
  bind + operate in their own ecosystem.
- **Identity/KYA:** integrate verifiable agent identity (Skyfire-style "Know Your Agent") / **x401** on top
  — the controller-KYC bookend that sharpens the legal-body moat.

**Positioning:** none of AgentKit / Circle / Mastercard / Skyfire give an agent a **legal body** — the LLC
+ governed treasury is our unique layer. Model A serves the now-universal MCP market (Bucket 1); Model B
serves the crypto-native self-custody niche (Bucket 2).

## 13. Self-review checklist (for the author)

- Custody: v1 keeps the user as custodian (Turnkey root + on-chain guardian); no platform custody, no
  governance bypass. ✓
- Every operate path is gated by the existing Payment Authority + on-chain limits. ✓
- Reuses existing surfaces (runner, api-keys, passkey, job saga, Payment Authority, Turnkey operator);
  net-new is additive. ✓
- Model B preserved as a concrete v2 section per the decision to reference it. ✓
- Security: audited 2026-07-01; the chosen hybrid spending posture + all findings folded into §14. ✓

---

## 14. Security — from the 2026-07-01 architecture audit

Three adversarial threat-models (custody/governance, app attack-surface, cryptographic alternatives)
reviewed this design against the real code. **Verdict: the core model is sound** — the agent holds no key,
every spend funnels through the Payment Authority + on-chain caps/guardian, and the `AgentTreasury` contract
is well-built. No finding breaks the model against a *malicious linked agent*. The requirements below close
the gaps the audit did find — concentrated at (a) funds that *leave* governance (the pocket/Gateway float),
(b) the backend's trust concentration, and (c) the two new BYOA seams (a bearer key that can now *spend* + a
human bootstrap driven by an untrusted agent) — plus one latent pre-existing gap (the WebAuthn attestation
is never verified).

### 14.1 Default spending posture — CHOSEN: hybrid (option c)
- **Micro-payments (≤ a configurable threshold — ~90% of x402 traffic): allowlist NOT required.** The agent
  pays *any* payee/service, bounded by tight **per-tx** and **per-period** caps. Preserves "pay any x402
  service autonomously."
- **Payments > the threshold: an allowlisted payee is REQUIRED.**
- Caps + `perTxCap` ship **tight by default**; the threshold + caps are guardian-set policy. Allowlist-
  always-on was rejected because it breaks "pay any service."

### 14.2 v1 security requirements (intrinsic to BYOA — build *with* the feature)
- **Magic-link binding (audit-Critical):** the bootstrap token's tenant is derived from the **SIWE login**,
  never the agent-supplied link; the completion page shows an explicit **human-readable authorization
  confirmation** before minting; tokens are high-entropy, single-use (atomic consume), short-TTL, kept out
  of query-strings/logs; `claim_connection` returns a **binding confirmation, not the key**; the connection
  page is `no-store`/`no-referrer` and the key is copy-once.
- **API key = spend authority (audit-High):** keys are **scoped to a single `entityId`** (not just tenant),
  carry a **capability scope** (read / earn / spend), have a **TTL**, are one-click revocable, and every
  `pay`/`fund` emits an **audit event** (+ guardian notification, §14.3). Ship with the tight default leash
  (§14.1). Docs warn: treat the key like a treasury password.
- **`pay` SSRF hardening (audit-High):** enforce the §4.2 URL guard (https; block private/link-local/
  metadata; no redirects to them; timeout; optional resource-domain allowlist) and re-assert the returned
  payee against §14.1.
- **Tenant isolation in every new tool (audit-Medium):** `pay`/`run_job`/`get_job`/`list_jobs`/
  `treasury_status` MUST re-check `ownerTenantId === tenantId` (mirroring `get_entity`) and return a uniform
  "not found" — with explicit cross-tenant IDOR tests. The Turnkey operator is derived from the tenant-owned
  entity, never from an `id` arg.
- **Payment idempotency (audit-Medium):** `pay`/`fund` take a client-supplied per-payment idempotency key; a
  repeat returns the original receipt, never a second settlement.
- **Input validation (audit-Medium):** reject non-positive `amount`/`amountUsdc` at every new tool boundary.
- **Chokepoint assertion:** a test proves the *only* path from an MCP tool to the Turnkey operator's signer
  is via `authorizePayment` — no shortcut.
- **Signed evaluator seam (cheap crypto win):** the ERC-8183 evaluator interface carries a **signature
  field now** (evaluator signs `{jobId, deliverableHash, score}`), even though v1's platform evaluator makes
  it trivial — so decentralizing evaluators (§4.1) needs no rework and gains non-repudiation.

### 14.3 Security prerequisites (cross-cutting — harden the substrate BYOA leans on harder)
⛔ = hard-blocker before shipping *spend-capable* BYOA; ⚠ = hardening fast-follow.
- ⛔ **WebAuthn verification (#4):** the guardian passkey is the **root of custody** but is currently stored
  without verifying the registration. Verify it server-side (challenge-binding + attestation signature +
  origin/rpId) — or confirm+document that Turnkey re-verifies — before any body roots spend authority on it.
- ⛔ **Per-agent, minimal, just-in-time float (#1):** replace the single **global shared pocket key** with a
  per-agent float, topped up just-in-time and swept on idle, so the un-governed pocket/Gateway exposure at
  any instant is small and never commingles tenants (keep the operator EOA balance ~zero).
- ⚠ **Guardian alerting + auto-pause (#7):** a service watching `PolicyUpdateScheduled`/`Spent`/
  `OperatorFunded`/`OperatorRotated` that notifies the guardian (email/push/webhook) + auto-pauses on
  anomaly — "the user holds the leash" is only real once they're *told* to pull it. Raise the default
  `policyDelay` for **loosening** changes (48–72h; tightening/pause stay instant).
- ⚠ **Payload-scoped Turnkey policy (#8):** tighten the operator delegate from "SIGN anything on this wallet"
  to the treasury contract + specific selectors/destinations, so a compromised backend can't drain the
  operator EOA via a raw transfer. (The 2-of-2 policy-cosigner in §14.4 is the crypto-enforced version.)
- ⚠ **Manager / operator-delegate key separation (#3):** the backend currently holds both the manager
  (policy) key and the operator sign-delegate; a single compromise collapses 2 of 3 roles. Separate them
  (HSM / distinct service). Make `payoutAddress` changes require guardian **consent**, not just veto.

### 14.4 Cryptographic posture (honest cost/benefit)
Security rests on **on-chain economic bounds, not key secrecy**, so most crypto is overkill here.
- **Adopt (cheap signatures, real value):** the **signed evaluator attestation** seam (§14.2) and a **signed
  policy-decision log** (the Payment Authority signs each decision — strengthens the legal body's
  auditability/dispute posture; on-chain Merkle-anchor later).
- **v2 / consider:** verifiable **KYC / agent-identity credentials** (x401 / "Know Your Agent" — *consume
  from an issuer, don't build*; selective disclosure); a **targeted 2-of-2 policy-cosigner** (makes "must
  pass policy" a cryptographic invariant vs. code convention); **capability/macaroon keys** for finer
  least-privilege.
- **Evaluated and rejected as overkill here:** zk proofs for policy-compliance / action-authorization /
  private reputation (they re-prove what the public contract already enforces, and fight the transparency
  the product sells); MPC / m-of-n on the operator delegate (the on-chain cap already bounds a compromised
  delegate to a small, revocable loss); hardware attestation of the agent runtime (the agent holds no key).
