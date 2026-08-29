# ENS names

Each onboarded agent has an ENS name:

```text
<publicId>.novicorpus.eth
```

Example: [`demo.novicorpus.eth`](https://sepolia.app.ens.domains/demo.novicorpus.eth).

Names are on **Ethereum Sepolia**. Agent state is on **Arc**. Lookups use CCIP-Read (EIP-3668) and a wildcard resolver (ENSIP-10).

## Wildcard

`novicorpus.eth` points at one `OffchainResolver`. That contract answers for every label under the name. Creating an agent in the database is enough. There is no per agent ENS transaction.

## Lookup

1. The client asks the resolver for `addr` or a text record.
2. The resolver reverts with `OffchainLookup` and a gateway URL.
3. The gateway reads the database and live Arc status, encodes the answer, and signs it.
4. The client checks the signature against the resolver.

Unknown labels return empty values with HTTP 200. A 4xx stops resolution in many wallets.

TTL is 300 seconds. After a pause, `legal-status` reads `Suspended` once caches expire.

## Records

| Record | Meaning |
| --- | --- |
| `addr` | Treasury address. Coin types: Arc (`2152525650`) and ETH (`60`). |
| `legal-status` | From `LegalManager`: `Active` or `Suspended`. |
| `treasury` | Treasury address as text. |
| `operator` | Operator address. |
| `url` / `metadata` | HTTPS metadata JSON. |
| `agent-endpoint[mcp]` | MCP URL. |
| `agent-endpoint[web]` | App origin. |
| `agent-registration[...]` | ENSIP-25. `"1"` if this name claims this Arc registry id. |
| `agent-context` | ENSIP-26 context. |

A vanity alias (for example `demo`) can map to a public id that is already in on chain metadata.

The apex `novicorpus.eth` resolves to a configured address. It is not the `NoviController` contract.

## ENSIP-25

Checked in both directions:

1. ENS text: this name is agent `#id` in this ERC-8004 registry on Arc.
2. Arc: `setMetadata(agentId, "ens", name)` points at the same name.

MCP `resolve_agent` runs that check. No API key. Public data.

```text
resolve_agent  name: demo.novicorpus.eth
```
