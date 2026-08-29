# MCP tools

Remote MCP, Streamable HTTP, same process as the REST API. Auth is `Authorization: Bearer <apiKey>`. Tenant, entity scope, and capability are closed over from the key. They are **never** taken from a tool argument.

A scope miss returns a uniform "not found" / "not authorized". That is intentional. Do not probe for other tenants' ids.

## Read (any valid key)

| Tool | Purpose |
| --- | --- |
| `whoami` | Authenticated tenant address |
| `list_entities` | Your legal bodies (entity scoped keys see only theirs) |
| `get_entity(id)` | One body. Poll this after `onboard_agent`. |
| `treasury_status(id)` | Available balance, cap, paused, allowlist |
| `get_job(jobKey)` / `list_jobs(id)` | Job progress |
| `resolve_agent(name)` | Public ENS + ENSIP-25 verdict for **any** Novi Corpus agent. No capability gate. |

## Earn (`earn` and above)

| Tool | Purpose |
| --- | --- |
| `run_job(id, budgetUsdc?)` | Run an ERC-8183 job. Default budget `1.00` USDC. Returns `{ jobKey, status }`. Poll `get_job`. |

Platform funded. Capped by `maxJobBudget` and `maxInflightJobsPerTenant` so a loop cannot drain the job wallet.

## Spend (`spend` and above)

| Tool | Purpose |
| --- | --- |
| `pay(id, to, amountUsdc, idempotencyKey)` | Pay an **x402 resource URL**. `amountUsdc` is **atomic** USDC (6 decimals, integer string). |
| `fund_pocket(id, amountUsdc)` | Top up the Gateway float from the treasury. Explicit only. Atomic USDC. |

`pay` never auto funds the pocket. If the float is empty, fund it, then pay.

## Provision (`provision`, tenant wide key)

| Tool | Purpose |
| --- | --- |
| `fund_treasury(id, amount)` | Platform wallet → treasury. Atomic USDC. Deployment caps apply. |
| `create_formation_party(...)` | Only if this deployment forms companies. Returns `{ partyId }` and nothing else. |
| `onboard_agent(spec, passkeyId, ...)` | Create a body. Guardian is your tenant. Manager is the platform. Poll `get_entity`. |

## Bootstrap

| Tool | Purpose |
| --- | --- |
| `claim_connection(linkCode)` | Bind this client to the browser session that minted the code. |

## Resources

`schema://agent-spec` is the JSON Schema for `onboard_agent`'s `spec`. Fetch it rather than guessing fields.

`custody` on `onboard_agent` is `'circle'` or `'turnkey'`. Omit it to use the platform default. `partyId` is the handle from `create_formation_party`. Never put personal data in `spec`.
