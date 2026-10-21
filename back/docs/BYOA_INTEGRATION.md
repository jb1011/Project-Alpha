# Bring your own agent (BYOA): integration guide

Link an agent you already run, any MCP-capable one (Claude Code, Cursor, Codex, Gemini, …), to a
**legal body**: a Wyoming LLC bound to the agent's ERC-8004 identity on Circle's Arc, with an
`AgentTreasury` that holds its USDC. Your agent **decides and initiates**; the backend's Payment
Authority and the on-chain treasury **enforce the limits** on every spend, and a verified human
guardian keeps the controls that matter (spending caps, an instant freeze).

Everything goes through one MCP server, `https://api.novicorpus.com/mcp`, listed in the official
MCP Registry as `com.novicorpus/legal-body`. Only the paste-here registration format differs per
agent; the server and the tools are the same. Arc testnet only for now.

Some tools exist only where the deployment turns the feature on: company formation, the Hedera
rail and the legal body on an identity you own. Your MCP client's tool list shows what your
deployment offers.

---

## 1. Three ways to connect

### A. Web first: "Connect your agent" (you already have a legal body)

1. Sign in to the dashboard (SIWE) and open the legal body you want to link.
2. Request a **connection package** for it:
   `POST /connection-package { "entityId": "<id>", "capability": "read" | "earn" | "spend" | "provision" }`
   returns `{ mcpUrl, apiKey, entityId, capability, snippets }`. The key is **scoped to that one
   entity** at the capability you chose.
3. Paste the snippet for your agent (§3). The agent can now operate that body.

### B. Agent first: bootstrap (the agent creates the legal body itself)

For letting an agent onboard *and* operate from a prompt, with one browser step:

1. Sign in (SIWE) and register a **guardian passkey** (`GET /passkey/challenge`, WebAuthn,
   `POST /passkey`, which returns `{ id }`, the `passkeyId` used below). The passkey identifies you as the guardian; with
   the Turnkey custody option it is also the root of the agent's key vault.
2. Request an agent-first bootstrap:
   `POST /bootstrap-connection { "passkeyId": "<id>", "capability": "provision" }` returns
   `{ mcpUrl, apiKey, passkeyId, capability: "provision", linkCode, snippets }`. This mints a
   **tenant-wide** key and a one-time **link code**. `provision` is required because the next
   step calls `onboard_agent`, which creates a new legal body with platform funds. The response
   is `no-store` / `no-referrer` and the key is shown once.
3. Paste the snippet into your agent, and give it the **link code**.
4. The agent calls `claim_connection(linkCode)` to confirm it was linked to your account on
   purpose (a confirmation, never the key), then `onboard_agent(spec, passkeyId)` to create its
   legal body, and starts operating.

The key's tenant always comes from your SIWE sign-in, never from anything the agent supplies;
link codes are single-use, short-lived and tenant-scoped.

### C. Your agent already owns its identity (a legal body on your own identity)

If your agent already has an ERC-8004 identity and a wallet, you keep both: Novi Corpus binds a
legal body to that identity, with no treasury and no key held by us. You (the guardian) declare
your company and place the order in the browser at
[www.novicorpus.com/legal-body](https://www.novicorpus.com/legal-body). If the identity is owned
by a key your agent holds, the agent can sign its part with a tenant-wide key:
`get_link_message`, then `submit_link`, then `get_binding` (§4). These tools only act on an order
your guardian placed in the browser; none of them places an order.

---

## 2. The capability model

Keys carry a **capability** on a ladder, `read < earn < spend < provision`, and an optional
**entity scope**:

| Capability | Grants |
|---|---|
| `read` | the read tools |
| `earn` | read + `run_job`, `refund_job` |
| `spend` | read + earn + `pay`, `fund_pocket`, and the Hedera tools (`link_hedera_account`, `check_policy`, `report_payment`) |
| `provision` | spend + the tools that use platform funds or create something: `fund_treasury`, `onboard_agent`, the formation tools, `submit_link` |

`provision` is a distinct, opt-in top rung: it moves **platform** USDC or creates new things, not
just funds already inside a treasury the key controls. `fund_treasury` is bounded by
`MAX_TREASURY_FUND_USDC` (default 25 USDC per call) and `MAX_TREASURY_FUNDED_PER_TENANT_USDC`
(default 100 USDC per tenant, lifetime).

A key scoped to one `entityId` can operate **only that body**; a tenant-wide key can operate all
of yours. `onboard_agent`, the formation tools and the three legal-body link tools need a
**tenant-wide** key. Give an agent the least capability it needs.

---

## 3. Paste-here snippets

Same server for all; `buildSnippets({ mcpUrl, apiKey })` returns a ready string per agent. **Claude
Code is the flagship** (first class, demoed, tested end to end):

- **Claude Code** (CLI): `claude mcp add legalbody --transport http <mcpUrl> --header "Authorization: Bearer <apiKey>"`
- **Cursor**: `~/.cursor/mcp.json` (`mcpServers` with `url` + `Authorization` header)
- **Codex**, **OpenClaw**, **Gemini CLI**: the same `mcpServers` JSON entry in their config
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`
- **Cline**: `cline_mcp_settings.json`
- **Hermes**: the same `mcpServers` JSON entry (assumed standard, not verified)
- **VS Code**: `.vscode/mcp.json`, which uses `servers` (not `mcpServers`) with an explicit `"type": "http"`
- **Claude Desktop**: its config file speaks stdio, so reach the remote server through the
  `mcp-remote` bridge (`npx -y mcp-remote <mcpUrl> --header "Authorization: Bearer <apiKey>"`), or
  Settings > Connectors > Add custom connector
- **Generic**: the raw `{ url, headers: { Authorization } }` any MCP client accepts

> MCP client config formats keep changing. The **Claude Code CLI** and the **generic** form are the
> most stable; check the client-specific snippets against each tool's current docs. Adding an
> agent is one more template in `src/mcp/snippets.ts`.

---

## 4. The tools (MCP)

Every tool is scoped to the caller's key (tenant, entity and capability come from the API key,
never from a tool argument) and answers a uniform "not found" on any ownership or scope miss.

**Read** (any valid key):
- `whoami`: your authenticated tenant address.
- `list_entities`, `get_entity(id)`: your legal bodies.
- `treasury_status(id)`: available balance, cap, paused state, allowlist status.
- `get_job(jobKey)`, `list_jobs(id)`: job progress.
- `resolve_agent(name)`: resolve and verify an agent by its ENS name.
- `list_companies`, `get_company`: your companies. `get_company_payment`: a company's formation
  payment (where formation payments are configured).

**Earn** (`earn` and up):
- `run_job(id, budgetUsdc?)`: the agent earns USDC and reputation by running an ERC-8183 job
  (self-contained v1: the platform stands in for the client and the evaluator). Returns
  `{ jobKey, status }`; poll `get_job`.
- `refund_job(jobKey)`: recover the escrow of a job of yours that funded and then failed. The
  saga already tries this by itself and every API boot retries the jobs still owed one; this is
  for the case neither has covered yet. It reads the chain first and sends nothing when there is
  nothing to recover, so calling it twice is safe; the outcome names what it found (`refunded`,
  `released`, `waiting-expiry`, `nothing-escrowed`).

**Spend** (`spend` and up):
- `pay(id, to, amountUsdc, idempotencyKey)`: pay an **x402 resource URL** in USDC, within the
  treasury's limits. Checked by the Payment Authority (per-transaction and per-period caps, the
  allowlist) and signed by the agent's pocket; idempotent by `idempotencyKey`.
- `fund_pocket(id, amountUsdc)`: top up the agent's spending float (treasury to operator to pocket to
  Gateway), within the same rules.
- `link_hedera_account`, `check_policy`, `report_payment`: the Hedera rail (where it is on).

**Provision** (`provision`):
- `fund_treasury(id, amount)`: move USDC into a bound body's treasury from the **platform**
  wallet, within the limits in §2.
- `onboard_agent(spec, passkeyId, custody?, companyId?, idempotencyKey?)`: create a legal body
  (the guardian is your tenant). `spec` must match the `schema://agent-spec` resource. `custody`
  picks the agent's operating wallet: `circle` (a Circle developer-controlled smart account run by
  Novi Corpus, gasless) or `turnkey` (a key vault rooted in your guardian passkey); omitted, the
  deployment's default applies. Where formation is on, `companyId` is required. Returns `pending`
  at once; poll `get_entity` until `bound`. Tenant-wide key only.
- Formation (tenant-wide key only): `create_formation_party`, `update_company_party`,
  `create_company` (where formation is on); `submit_company_payment`, `requote_company_payment`,
  `cancel_company_payment` (only where the deployment charges for formation). Formation runs
  through doola; never put personal data in an agent spec.

**Legal body on your own identity** (where it is on, tenant-wide key only):
- `get_link_message(orderId, agentId, ttlSeconds?)` (read): the EIP-712 message the identity's
  owner signs; writes nothing.
- `submit_link(orderId, message, signature)` (provision): submit the owner's signature; Novi
  Corpus creates the legal body once.
- `get_binding(orderId)` (read): the binding's state, and the pointer the identity's owner writes
  on chain, as data (never calldata).

**Bootstrap** (agent first):
- `claim_connection(linkCode)`: confirm the agent was linked to your account on purpose. Returns
  your tenant and entities (a confirmation, never a key).

---

## 5. What keeps it safe

- **Governed spend, two layers.** Every `pay` is checked off chain by the Payment Authority and
  again on chain by the `AgentTreasury` before it settles. Caps and the allowlist bound the damage.
- **Autonomous within limits, not approve-each-transaction.** The agent decides and initiates
  without a human approving each spend; your control is upfront (the rules) plus an **instant
  guardian freeze**.
- **The agent holds no key.** Its operating wallet (Circle or Turnkey) is run by the platform and
  can only spend what the treasury contract allows; the funds sit in the on-chain treasury you
  govern.
- **Least privilege.** Scope keys to one entity and the lowest capability; keys are revocable; the
  raw key is shown once and served `no-store`.

---

## 6. Custody and identity options

- **Operating wallet:** Circle developer-controlled smart accounts (`circle`) and Turnkey key
  vaults (`turnkey`) both ship; each deployment picks its default.
- **Your own identity and wallet:** the legal body on an identity you own (§1 C) runs on Arc
  testnet: the agent keeps its key, its identity and its money, and Novi Corpus holds none of them.
- **Circle Agent Wallets:** attaching a Circle Agent Wallet you already run, as the agent's wallet
  next to a legal body on your own identity, is designed but not switched on.

The per-slice implementation history is in the `back/docs/plans/2026-07-*-byoa-*` plans.
