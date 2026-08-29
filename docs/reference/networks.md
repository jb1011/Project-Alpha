# Networks and addresses

## Arc testnet

| Field | Value |
| --- | --- |
| Chain ID | `5042002` |
| Explorer | [testnet.arcscan.app](https://testnet.arcscan.app) |
| Native gas | USDC (6 decimals) at `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Faucet | [faucet.circle.com](https://faucet.circle.com) |

### Our contracts (deployed 2026-06-12)

Beacon owner and deployer started as a testnet key. Move beacon and factory ownership to the controller admin before mainnet. Per agent proxies are created by `createEntity`.

| Contract | Address |
| --- | --- |
| `LegalManagerFactory` | [`0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`](https://testnet.arcscan.app/address/0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902) |
| `LegalManager` implementation | [`0xc2e89ABf562f2EB366e4dde42325af16EeF542a6`](https://testnet.arcscan.app/address/0xc2e89ABf562f2EB366e4dde42325af16EeF542a6) |
| Upgrade beacon | [`0xCbE36eC37673805a185a6883f9597613ABB41c97`](https://testnet.arcscan.app/address/0xCbE36eC37673805a185a6883f9597613ABB41c97) |

Machine readable copy: `back/addresses.arc-testnet.json`.

### Reused Arc infrastructure

| Contract | Address |
| --- | --- |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| ERC-8183 Job | `0x0747EEf0706327138c69792bF28Cd525089e4583` |

### Subgraph

[novi-corpus-arc on The Graph Studio](https://api.studio.thegraph.com/query/1756954/novi-corpus-arc/v0.0.1) (walking skeleton).

## Ethereum Sepolia

ENS parent `novicorpus.eth`, wildcard `OffchainResolver`, CCIP-Read gateway on the brain. Coin type for Arc in ENSIP-11 form: `2152525650` (`0x80000000 | 5042002`).

## World Chain

AgentBook registry lookups. RPC and contract addresses are deployment env, not this table.

## App origins

| Surface | URL |
| --- | --- |
| Current web app | [project-alpha-pi.vercel.app](https://project-alpha-pi.vercel.app) |
| Intended docs | `https://docs.novicorpus.com` |
| Intended product | `https://novicorpus.com` (when DNS is attached) |

Until custom domains are live, use the Vercel app and this GitBook space.
