# Stack

| Piece | Role |
| --- | --- |
| [Arc](https://www.circle.com/arc) | Circle L1. USDC native gas. Sub second finality. Identity, treasury, jobs. |
| Circle Agent Stack | Gateway nanopayments, x402, agent wallets / MPC |
| [World](https://world.org/) | World ID 4.0 personhood, AgentBook, AgentKit |
| [ENS](https://docs.ens.domains/) | ENSIP-10 wildcard, EIP-3668 CCIP-Read, ENSIP-25 agent registration |
| ERC-8004 / ERC-8183 | Identity, reputation, jobs on Arc |
| [The Graph](https://thegraph.com/) | Arc testnet subgraph (minimal today) |
| [Turnkey](https://www.turnkey.com/) | Passkey rooted, non custodial operator keys |
| [Circle](https://www.circle.com/) | USDC, Gateway, optional MPC smart accounts |
| [doola](https://www.doola.com/) | Wyoming company formation API |
| Next.js 16 | `interface/` |
| Hono + SQLite | Brain HTTP + persistence |
| Foundry | Contracts |
| MCP | Agent face (`@modelcontextprotocol/sdk`) |

## Repo map

```text
interface/     Next.js web app
back/          Foundry project (contracts, tests, scripts)
back/backend/  TypeScript brain
back/subgraph/ The Graph subgraph
back/docs/     Internal specs (not published here)
docs/          This GitBook
```

## Local run

Frontend:

```bash
cd interface
npm install
npm run dev
```

Brain (see `back/backend/README.md`):

```bash
cd back/backend
cp ../.env.example .env
npm install
npm run gen:abis
npm test
npm run api
```

Point the app at a local brain with `API_PROXY_TARGET=http://localhost:8789` or `NEXT_PUBLIC_API_URL`.

Contracts:

```bash
cd back
forge build && forge test
```

Do not change `evm_version` in `foundry.toml`. Arc needs `paris`.
