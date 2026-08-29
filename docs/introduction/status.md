# Current status

Novi Corpus runs on **Arc testnet**. Mainnet launches September 16.

## What is live

| Surface   | State                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Web app   | Onboarding wizard, agent dashboard, guardian record, MCP connect, [transparency](https://project-alpha-pi.vercel.app/transparency) |
| Contracts | `LegalManagerFactory`, `LegalManager`, `AgentTreasury`, `NoviController` on Arc testnet (chain ID `5042002`)                       |
| Payments  | x402 payments settled through Circle Gateway in testnet USDC                                                                       |
| Identity  | ERC-8004 on Arc. ENS names under `novicorpus.eth`                                                                                  |
| World     | Guardian proof of personhood. Device only credentials are rejected. Orb and passport tiers are offered.                            |
| MCP       | Same process as the REST API. Keys have a capability (`read`, `earn`, `spend`, `provision`).                                       |
| Formation | Doola Partner API when the deployment has credentials. Sandbox filings are labeled demo.                                           |

Example name: [`demo.novicorpus.eth`](https://sepolia.app.ens.domains/demo.novicorpus.eth).

## What is stubbed or incomplete

- **Wyoming filing and EIN.** Real when Doola is configured and the environment is production. Without credentials the backend stores `ein: "STUB-NOT-FILED"` and a short mock operating agreement. Doola sandbox produces documents with a DEMO watermark.
- **The Graph.** A small subgraph is deployed on Arc testnet. Full schema, alerts, and paid queries are not built.
- **Mainnet.** `NoviController` exists so the manager is not a hot EOA. Hardware wallet or multisig admin and other hardening still block a mainnet launch.
- **Homepage numbers.** Use `/transparency` for counts. Do not treat landing page figures as data.

## Where rules are enforced

Not every rule is in Solidity.

- **On chain:** rolling period cap, pause, allowlist (when enabled), legal status must be `Active`, guardian emergency withdraw, timelocked policy updates.
- **Backend:** per transaction cap, trust policy, and the other Payment Authority checks that run before an x402 signature.

If the backend is compromised, the on chain period cap and guardian pause still apply. The backend checks do not.

## Networks

| Network          | Role                                                      |
| ---------------- | --------------------------------------------------------- |
| Arc testnet      | Settlement, identity, treasury, jobs. USDC is native gas. |
| World Chain      | AgentBook lookups                                         |
| Ethereum Sepolia | ENS (`novicorpus.eth`)                                    |

Addresses: [Networks and addresses](../reference/networks.md).

## Legal

An LLC can own assets and sign contracts in the usual sense of a Wyoming company, with a human controller of record. That is not a court tested model of a fully autonomous legal person. These pages are not legal advice.
