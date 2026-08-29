# Architecture

Three directories in the monorepo:

| Path | What |
| --- | --- |
| `interface/` | Next.js 16 app. Landing, wizard, dashboard. Thin face. |
| `back/` | Foundry contracts at the root of this folder. |
| `back/backend/` | TypeScript brain. Onboarding saga, policy, payments, MCP, REST. |

Internal engineering notes (specs, plans, runbooks) live in `back/docs/`. They are not this GitBook.

## Faces over one brain

```
  Browser (SIWE JWT) ──► REST /onboard /entities /mcp …
  MCP client (API key) ─► /mcp  (Streamable HTTP)
  CLI                    ► same runner, same SQLite
         │
         ▼
  OnboardingRunner  (idempotent saga, in flight set, resume)
         │
         ├─► policy translator + OA generator
         ├─► Arc adapter (viem)  ─► NoviController relay ─► Factory / registries
         ├─► Circle / Turnkey custody
         ├─► Doola formation (optional)
         └─► Payment Authority ─► pocket ─► x402 / Gateway
```

Adding a third face should call `runner` and `repo`, not copy saga steps.

## Onboarding saga (happy path)

1. Persist spec + passkey handle + optional `partyId`
2. Provision operator (Circle or Turnkey)
3. `createEntity` on the factory (LegalManager proxy + AgentTreasury + ERC-8004 id)
4. Operator signs EIP-712 `AgentWalletSet`; manager submits
5. Metadata URI + ENS reverse bind
6. Guardian allowlist transactions (human)
7. Optional platform `fund`
8. Background: Doola steps + manifest amendments

Every step is resumable. Crashes re-enter without double minting.

## Persistence

SQLite on the brain host, with Litestream in the production story. Entity status is a small state machine. Formation and ENS were layered **beside** it (new tables, no new status values) on purpose. Status checks exist in many files including a SQL CHECK. Do not casually add a status.

## Auth

| Door | Auth |
| --- | --- |
| Wizard REST | SIWE → JWT. Tenant = checksum address. |
| MCP | Bearer API key, hashed at rest, capability + optional entity scope. |
| Doola webhook | HMAC, timing safe, optional previous secret for rotation. |
| ENS gateway | No user auth. Responses are signed by `ENS_GATEWAY_SIGNER_KEY`. |

## Interface proxy

The Next app proxies `/backend/*` to the brain and forwards `mcp-session-id`, `accept`, and `x-payment`. If you add a header the brain requires, add it to the proxy allow list or MCP and x402 will break in the browser.
