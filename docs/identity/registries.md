# On chain identity

Identity uses Arc's existing registries. There is no separate Novi Corpus identity chain.

## ERC-8004

`createEntity` registers in Arc's **IdentityRegistry** and deploys that agent's `LegalManager` and `AgentTreasury` in the same transaction.

| Registry | Address (Arc testnet) | Role |
| --- | --- | --- |
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Agent id, `agentWallet`, metadata URI |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Feedback after jobs |
| Validation | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | Validation hooks |

The **manager** (platform / `NoviController`) owns the identity NFT, so it can call `setAgentWallet` and `setMetadata` during onboard. Transferring the NFT clears the wallet binding. That is how the live registry behaves.

`agentWallet` is the operator key. The operator signs EIP-712 `AgentWalletSet`. The manager submits the transaction. The operator does not pay gas for bind.

Metadata is an HTTPS URI. Fetch `/metadata/<publicId>`.

## ERC-8183 jobs

Job contract on Arc testnet: `0x0747EEf0706327138c69792bF28Cd525089e4583`. In v1 the platform is both client and evaluator. See [Jobs and reputation](../agents/jobs.md).

## LegalManager

Wyoming Articles name a managing smart contract. That is the per agent `LegalManager` proxy:

* EIN, formation date, operating agreement hash, `agentId`
* Status: `Active`, `WindingDown`, `Dissolved`
* Timelocked amendments with guardian veto
* Dissolution with the same delay

Upgradeable through a **beacon** (one implementation, many agents). Beacon ownership should be the controller admin, not a server key, before mainnet.

## NoviController

`NoviController` is the intended `manager` of new bodies, owner of the factory, and owner of the beacon. A cold admin grants roles. The backend executor may call only the granted selectors.

The vaults already have a timelock and guardian veto. The controller does not add another delay. `AgentTreasury.manager` is immutable, so a hot EOA as manager on mainnet cannot be rotated per vault.
