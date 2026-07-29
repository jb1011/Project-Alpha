# Bring Your Own Agent (BYOA) — Integration Guide

Link an existing MCP-capable agent (Claude Code, Cursor, Codex, Gemini, …) to a **governed on-chain legal
body**: a Wyoming DAO LLC identity + an `AgentTreasury` on Circle's Arc that holds USDC. Your agent then
**decides and initiates** actions; the backend **Payment Authority** and the on-chain treasury **enforce the
leash** on every spend. The agent holds no key in the default model — the human stays in control (spending
caps + an instant guardian freeze).

Everything an agent does goes through one universal MCP server. Only the *paste-here registration format*
differs per agent; the server and tools are identical.

---

## 1. Two ways to connect

### A. Web-first — "Connect your agent" (you already have a body)

1. Sign in to the dashboard (SIWE) and open the legal body you want to link.
2. Request a **connection package** for it:
   `POST /connection-package { "entityId": "<id>", "capability": "read" | "earn" | "spend" | "provision" }`
   → `{ mcpUrl, apiKey, entityId, capability, snippets }`. The key is **scoped to that one entity** at the
   capability you chose.
3. Paste the snippet for your agent (§3). Done — the agent can now operate that body.

### B. Agent-first — bootstrap (the agent will create the body itself)

For letting an agent onboard *and* operate from a prompt, with one browser step:

1. Sign in (SIWE) and register a **guardian passkey** (`GET /passkey/challenge` → WebAuthn → `POST /passkey`
   → `passkeyId`). The passkey is the root of custody; only you hold it.
2. Request an agent-first bootstrap:
   `POST /bootstrap-connection { "passkeyId": "<id>", "capability": "provision" }`
   → `{ mcpUrl, apiKey, passkeyId, capability: "provision", linkCode, snippets }`. This mints a **tenant-wide**
   operating key and a one-time **link code**. `provision` is required here — the next step calls
   `onboard_agent`, which creates a new legal body from the platform, not just spends from an existing one.
   The response is `no-store` / `no-referrer` and the key is shown once.
3. Paste the snippet into your agent, and give it the **link code**.
4. The agent calls `claim_connection(linkCode)` to confirm it was intentionally linked to your account (a
   binding confirmation, never the key), then `onboard_agent(spec, passkeyId)` to create its legal body, and
   proceeds to operate.

The bootstrap token's tenant is always derived from your SIWE login, never anything the agent supplies; link
codes are single-use, short-lived, and tenant-scoped.

---

## 2. The capability model

Keys carry a **capability** on a ladder — `read < earn < spend < provision` — and an optional **entity
scope**:

| Capability   | Grants |
|--------------|--------|
| `read`       | the read tools only |
| `earn`       | read + `run_job` |
| `spend`      | read + earn + `pay` |
| `provision`  | spend + platform-funded provisioning (`fund_treasury`, `onboard_agent`) |

`provision` is a distinct, opt-in top rung: it moves **platform** USDC (into a treasury, or to create a new
entity), not just funds already inside a treasury the key already controls. Treasury funding via
`fund_treasury` is bounded by `MAX_TREASURY_FUND_USDC` (default 25 USDC per call) and
`MAX_TREASURY_FUNDED_PER_TENANT_USDC` (default 100 USDC lifetime per tenant).

A key scoped to a single `entityId` can operate **only that body**; a tenant-wide key can operate any of your
bodies. Give an agent the least capability it needs.

---

## 3. Paste-here snippets

Same server for all; `buildSnippets({ mcpUrl, apiKey })` returns a ready string per agent. **Claude Code is
the flagship** (first-class, demoed, tested end-to-end):

- **Claude Code** (CLI): `claude mcp add legalbody --transport http <mcpUrl> --header "Authorization: Bearer <apiKey>"`
- **Cursor** — `~/.cursor/mcp.json` (`mcpServers` with `url` + `Authorization` header)
- **Codex**, **OpenClaw**, **Gemini CLI** — the same `mcpServers` JSON entry in their config
- **Windsurf** — `~/.codeium/windsurf/mcp_config.json`
- **Cline** — `cline_mcp_settings.json`
- **Hermes** — the same `mcpServers` JSON entry (standard format)
- **VS Code** — `.vscode/mcp.json`, which uses `servers` (not `mcpServers`) with an explicit `"type": "http"`
- **Claude Desktop** — its config file speaks stdio, so reach the remote server through the `mcp-remote`
  bridge (`npx -y mcp-remote <mcpUrl> --header "Authorization: Bearer <apiKey>"`), or Settings > Connectors >
  Add custom connector
- **Generic** — the raw `{ url, headers: { Authorization } }` any MCP client accepts

> MCP client config formats are young and still shifting. The **Claude Code CLI** and the **generic** form
> are the most stable; verify the client-specific snippets against each tool's current docs. Adding an agent
> is one more template in `src/mcp/snippets.ts`.

---

## 4. The operate tools (MCP)

All tools are scoped to the caller's key (tenant + entity + capability, closed over from the API key — never
a tool argument) and return a uniform "not found" on any ownership/scope miss.

**Read** (any valid key):
- `whoami` — your authenticated tenant address.
- `list_entities` — your legal bodies.
- `get_entity(id)` — one body by its id.
- `get_job(jobKey)` / `list_jobs(id)` — job progress.
- `treasury_status(id)` — available balance, cap, paused state, allowlist status.

**Earn** (`earn`+):
- `run_job(id, budgetUsdc?)` — the agent earns USDC + reputation by running an ERC-8183 job (self-contained
  v1: the platform stands in for the client + evaluator). Returns `{ jobKey, status }`; poll `get_job`.

**Spend** (`spend`):
- `pay(id, to, amountUsdc, idempotencyKey)` — pay an **x402 resource URL** with USDC, within the treasury's
  leash. Flows through the Payment Authority (per-tx + per-period caps, hybrid allowlist) and is signed by the
  per-agent pocket; idempotent by `idempotencyKey`.

**Provision** (`provision`):
- `fund_treasury(id, amount)` — move USDC into a bound body's treasury, from the **platform** wallet. Bounded
  by `MAX_TREASURY_FUND_USDC` (default 25 USDC/call) and `MAX_TREASURY_FUNDED_PER_TENANT_USDC` (default 100
  USDC lifetime per tenant).
- `onboard_agent(spec, passkeyId, idempotencyKey?)` — create a legal body (guardian = your tenant). `spec`
  must match the `schema://agent-spec` resource. Returns immediately with `pending`; poll `get_entity`.

**Bootstrap** (agent-first):
- `claim_connection(linkCode)` — confirm the agent was intentionally linked to your account. Returns your
  tenant + entities (a confirmation, never a key).

---

## 5. What keeps it safe

- **Governed spend, two layers.** Every `pay` is checked off-chain by the Payment Authority *and* re-checked
  on-chain by the `AgentTreasury` contract before it settles. Caps and the allowlist bound the blast radius.
- **Autonomous within guardrails, not approve-each-transaction.** The agent decides + initiates without a
  human approving each spend; your control is upfront (the rules) plus an **instant guardian freeze**.
- **Non-custodial.** Funds live in the on-chain treasury you govern; the platform can't seize them, and in
  the default model the agent holds no signing key (a bounded operator signs within the on-chain caps).
- **Least privilege.** Scope keys to a single entity + the minimum capability; keys are revocable; the raw
  key is shown once and served `no-store`.

---

## 6. Roadmap notes

- **Model B (self-sovereign).** A future mode where the agent holds its own signing key (bound to the
  on-chain identity via ERC-8004) for full autonomy — a user-choosable alternative to the default.
- **Custody options.** Evaluating Circle Developer-Controlled Wallets as a Circle-native signer for the
  default model, and Circle Agent Wallets for the self-sovereign mode.

See `docs/design/2026-07-01-bring-your-own-agent-model-a-design.md` for the full design + security model, and
the `back/docs/plans/2026-07-*-byoa-*` plans for the per-slice implementation detail.
