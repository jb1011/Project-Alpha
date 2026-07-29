# SPEC — The Graph Integration: subgraph + governed pay-per-query (Build 2 of 3)

Status: READY FOR IMPLEMENTATION.
Authoritative detail source: [reference-thegraph.md](./reference-thegraph.md) — this spec defines *what to build and in what order*; the reference defines *exactly how* (final manifest/schema drafts live there in §3, AssemblyScript traps in §4). Where they disagree, the reference wins.
Executor note: implement task by task, commit per task, run each checkpoint before moving on. **G1 must be deployed as early in the event as possible** — sync time is calendar time, not work time.

## Goal

1. A subgraph on `arc-testnet` indexing our factory + per-agent treasuries/legal managers (spends, top-ups, pauses, policy lifecycle, dissolution) — the on-chain **governance plane**.
2. A guardian alert watcher polling it (observability gap S5 closed).
3. **Governed x402 pay-per-query**: agents buy arbitrary Graph data through our policy engine (x402 **v2** wire), exposed as MCP tools + packaged as a Claude SKILL/plugin.

**Non-goals:** indexing USDC transfers (74.8M txs — never); per-x402-payment indexing (no events; frame honestly); Substreams/Token API (no Arc support); contract redeploys (v2-factory `Funded` event idea is OUT unless everything else lands); Composable-track work (ask booth first).

## Architecture (decided — do not re-litigate)

- Subgraph project at **`back/subgraph/`** (own package.json; graph-cli 0.98.1 / graph-ts 0.38.2; NOT part of the backend build). Network `arc-testnet`, factory `0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`, startBlock `46739165`, templates for `AgentTreasury` + `LegalManager` (context: agentId). ABIs extracted from Foundry `out/`.
- Schema + manifest: use the **final drafts in reference §3 verbatim** (AgentEntity / Treasury / SpendEvent / PolicyProposal / Incident / SpendPoint timeseries / SpendStats hour+day aggregation). SpendPoint emitted from BOTH `Spent` and `OperatorFunded`. `PolicyUpdated` → recompute policyId (keccak snippet in reference §4). Constructor config via `try_` eth_calls, nullable, never load-bearing.
- Deploy: Subgraph Studio (`novi-corpus-arc`), Studio dev endpoint for all reads (3k q/day fine). **Publish to the network (small Arbitrum One tx) only when starting G5** — the x402 gateway serves published subgraphs. Fallback if arc-testnet indexing misbehaves: self-hosted graph-node docker (reference §5), same deploy artifacts, only query URLs change.
- Watcher: `back/backend/src/services/graphWatcher.ts` — optional dep (boots without config), 15s cursor poll (`timestamp_gt`) over `incidents` + `policyProposals(status: SCHEDULED)`; writes a `guardian_alerts` SQLite table + structured log; new REST route `GET /alerts` (tenant-scoped, same auth as treasury route) for the dashboard.
- x402 v2 client: **new small module `back/backend/src/payments/x402v2.ts`** — do NOT touch `buyWithX402`/v1. Parses `PAYMENT-REQUIRED` header challenge, signs EIP-3009 for **Base Sepolia** (chainId 84532; USDC domain per challenge `extra` — name `"USDC"`), retries with `PAYMENT-SIGNATURE` header. Called only from a new `payments/graphQuery.ts` service that mirrors `entityPayment.ts`: idempotency claim → `evaluatePolicy` (amount from the live challenge, NOT hardcoded) → pending ledger → pay → settle/refund ledger. Payer = dedicated hot key `GRAPH_X402_PRIVATE_KEY`, funded from the Circle faucet (Base Sepolia USDC). Gateway called **direct from the backend** (never via the Vercel proxy — `PAYMENT-*` headers must not be stripped).
- MCP tools in `mcp/server.ts` (existing idiom: zod raw-shape, capability + entityInScope gates, JSON-in-text, optional deps in `McpToolDeps`):
  - `treasury_history` (read capability): kind ∈ spends|incidents|policy|hourly → queries OUR subgraph for the entity's treasury.
  - `query_subgraph_x402` (spend capability): {id, subgraphId, query, variables?, idempotencyKey} → `graphQuery` service. Refusals surface the `policy-denied:*` reason strings.
- SKILL/plugin at repo root **`skills/governed-graph-query/`**: SKILL.md (Anthropic frontmatter) + `references/` (schema.graphql copy + query cookbook) + `.claude-plugin/manifest.json` — skeletons in reference §8. README gets the 3-line `claude mcp add` install.

## Tasks (in order)

### G1 — Walking skeleton (DEPLOY FIRST, ~1–2h)
`back/subgraph/` scaffold; manifest with **factory dataSource only** + minimal AgentEntity schema + `handleEntityCreated`/`handleTreasuryCreated` (no templates yet). codegen/build/auth/deploy `v0.0.1` to Studio.
**Checkpoint:** Studio shows syncing; within ~1h the dev endpoint returns the ~22 known entities. If sync stalls >2h → escalate to self-hosted fallback (reference §5) NOW, before building more.

### G2 — Full subgraph (`v0.0.2+`)
Add templates, full schema, all handlers per reference §3–4 (policyId recompute, Incident writes for Paused/EmergencyWithdrawn/OperatorRotated/vetoes/dissolution, SpendPoint emission, try_ config snapshots). Iterate versions freely (grafting unnecessary at 45 logs).
**Checkpoint:** dev-endpoint queries return real spends/top-ups for treasury `0x4c2E…c540` (known: 2 OperatorFunded); pause an entity on testnet → Incident row appears; `spendStats(interval:"hour")` returns buckets (timestamps are **microseconds**).

### G3 — Watcher + alerts route
`graphWatcher.ts` + `guardian_alerts` table + `GET /alerts`. Config: `GRAPH_SUBGRAPH_URL` (optional-with-warning).
**Checkpoint:** live pause → alert row + log within 30s; `/alerts` returns it with tenant auth; backend boots cleanly with config absent.

### G4 — x402 v2 client + graphQuery service
`x402v2.ts` + `graphQuery.ts` per architecture above; env `GRAPH_X402_PRIVATE_KEY`, `GRAPH_X402_GATEWAY_URL=https://gateway.testnet.thegraph.com/api/x402/subgraphs/id`. Unit-test challenge parsing against the captured real challenge in reference §7. Fund payer from faucet.
**Checkpoint (two-stage):** (a) vitest green incl. policy-refusal path (paused entity → `policy-denied:paused`, nothing signed); (b) ONE live paid query against a **known published subgraph id** (reference §7 lists one) returns data + ledger row settles.

### G5 — Publish ours + wire the tools
Publish `novi-corpus-arc` to the network (Arbitrum One tx). Register `treasury_history` + `query_subgraph_x402` MCP tools (+ optional deps `graphIndex`/`graphPayments` in `McpToolDeps`, mirroring `payments?` pattern).
**Checkpoint:** from a live Claude session: `treasury_history` returns the spend timeline; `query_subgraph_x402` against OUR published id pays and returns data; suspended entity is refused pre-signature.

### G6 — SKILL/plugin packaging
`skills/governed-graph-query/` per reference §8 skeletons; cookbook queries = the ones from G2/G3 checkpoints; document `policy-denied:*` failure modes.
**Checkpoint:** plugin loads in a fresh Claude Code session; SKILL walkthrough executes both tools successfully.

### G7 — Tests + demo assets
Vitest: x402v2 parsing/signing (mock fetch), graphQuery policy gating + idempotency, watcher cursor logic (mock subgraph). Demo: `scripts/graph-demo.ts` — resolve entity (ENS tie-in if Build 1 landed) → show spend history → pause → alert fires → paid query refused for the paused entity → unpause → paid query succeeds. **Record the 2–4 min video** (hard judging requirement) once stable.
**Checkpoint:** suite green; demo script runs end-to-end against prod backend + Studio.

## Acceptance criteria
1. Subgraph live on arc-testnet with all our real entities + a demonstrably fresh event indexed during the demo (no mocked data — track DQ rule).
2. Guardian pause → alert visible via `/alerts` within 30s.
3. An agent pays for a Graph query through `evaluatePolicy`; a paused/suspended/over-cap entity is refused BEFORE any signature.
4. Both MCP tools callable from a live Claude session; SKILL/plugin installable from the public repo.
5. Backend boots with all Graph config absent (warnings only); existing tests pass.

## Env summary (VPS .env additions)
`GRAPH_SUBGRAPH_URL` (Studio dev endpoint) · `GRAPH_X402_GATEWAY_URL` · `GRAPH_X402_PRIVATE_KEY` (dedicated hot key, faucet-funded, small balance only) · (scripts only: Studio deploy key — never on the server)

## Estimates & risks
G1 1–2h · G2 4–5h · G3 2h · G4 3–4h · G5 1–2h · G6 2h · G7 2–3h ≈ **15–19h**.
Top risks + fallbacks: reference §10 (arc-testnet upgrade-indexer → self-host; one aborting handler fatals the subgraph → try_/null discipline; Studio-only ids may 402-but-not-resolve on the paid gateway → publish or demo against a published id; PAYMENT-* headers via proxy → backend-direct calls only).
