# Novi Corpus — web interface (`interface/`)

The Next.js app for [Novi Corpus](../README.md): the landing page, the SIWE-authenticated
onboarding wizard, and the agent dashboard. It is a **thin face** — all real logic lives in
the backend "brain" ([`back/backend`](../back/backend/README.md)); this app only renders
state and calls its API. Live-demo link: see the [root README](../README.md).

## Stack

Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · wagmi + viem (wallet / SIWE) ·
TanStack Query · Turnkey (passkey signing).

## Getting started

```bash
npm install
npm run dev     # http://localhost:3000
```

The landing page and wizard UI run standalone, but onboarding/dashboard flows need a
reachable backend. API calls go to the same-origin `/backend/*` route, which proxies to
the backend (`src/app/backend/[[...path]]/route.ts`) — by default the team's hosted
instance, which may be down. To run against your own, start the brain locally (see
[`back/backend`](../back/backend/README.md)) and set `API_PROXY_TARGET`
(server-side, e.g. `http://localhost:8789`), or bypass the proxy entirely with
`NEXT_PUBLIC_API_URL`.

Other env vars (all optional, sensible testnet defaults in `src/lib/chain.ts` and
`src/lib/api/config.ts`): `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_ARC_RPC_URL`,
`NEXT_PUBLIC_ARC_EXPLORER`, `NEXT_PUBLIC_SIWE_DOMAIN`, `NEXT_PUBLIC_MANAGER_ADDRESS`.

## Layout

```
src/app/            routes: landing (/), /onboarding, /agents (+ [id], account, connect),
                    /backend/* (API proxy to the brain)
src/components/     landing, onboarding wizard steps, agent dashboard, providers
src/lib/            chain config, API client + SIWE session, onboarding + treasury helpers
```

The proxy route forwards the MCP (`mcp-session-id`, `accept`) and x402 (`x-payment`)
headers end-to-end — the backend 406s / re-challenges without them. Keep that list in
sync if the backend grows new header requirements.
