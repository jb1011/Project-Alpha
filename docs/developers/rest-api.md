# REST API

The brain listens on port `8789` by default (`npm run api` in `back/backend`). The Next app proxies same origin `/backend/*`.

Tenant for wizard routes is the SIWE address. Unless noted, routes below sit behind `requireAuth`.

This is a map, not an OpenAPI dump. Field level schemas live in the backend and in `GET /schema/agent-spec.json`.

## Session

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/nonce` | SIWE nonce |
| `POST` | `/auth/verify` | Exchange signature for JWT |
| `GET` | `/config` | Chain, formation flags, custody availability, public URLs |

`GET /config` is how the wizard knows whether to show legal identity and which custody options exist.

## Passkeys and keys

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/passkey/challenge` | WebAuthn challenge |
| `POST` | `/passkey` | Store attestation, return `passkeyId` |
| `POST` / `GET` / `DELETE` | `/api-keys` | Self service MCP keys |

## Onboard and entities

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/onboard` | Start saga |
| `GET` | `/entities` | List yours |
| `GET` | `/entities/:id` | Poll until `bound` |
| `POST` | `/entities/:id/fund` | Platform fund (provision class) |
| `GET` | `/entities/:id/reputation` | ERC-8004 reputation view |
| `GET` | `/entities/:id/agentbook` | Human backing lookup (**pocket** address) |

## Policy, treasury, trust

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/entities/:id/policy` | Manager schedules an on chain policy update |
| `GET` / `POST` | `/entities/:id/per-tx-cap` | Software per transaction cap |
| `GET` / `POST` | trust policy routes | Seller / buyer dials where exposed |
| treasury routes | status, pause related reads | Dashboard |

## Connection (MCP paste)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/connection-package` | Entity scoped key + snippets |
| `POST` | `/bootstrap-connection` | Tenant wide provision key + link code |

## World, formation, documents

| Method | Path | Purpose |
| --- | --- | --- |
| World ID routes | verify proof | Guardian gate |
| `POST` | `/formation-party` | PII intake, returns `partyId` |
| Doola webhook | inbound HMAC | Wake up only |
| document routes | list / download | Hashed legal files |

## Public (little or no auth)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/metadata/:publicId` | Agent metadata JSON |
| ENS gateway | CCIP-Read | Wildcard resolution |
| transparency | stats + registry | `/transparency` in the app |
| x402 demo | 402 challenge + resource | Personhood demo |

## Errors

JSON envelope. MCP tools stringify their own result or `"not found"`. Do not parse HTML. Idempotency keys on onboard and pay are required for safe retries.
