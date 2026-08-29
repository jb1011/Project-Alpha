# Formation

Formation is how the legal body stops being a draft and becomes a filed Wyoming LLC. The provider is [doola](https://www.doola.com/)'s Partner API.

## When it runs

On deployments with Doola credentials, formation is **started at onboard** and is **mandatory** in the sense that the door refuses to mint if quotas are exhausted. It is **not blocking**: the on chain saga continues while filing proceeds.

On deployments without credentials, onboard still works. The EIN stays `STUB-NOT-FILED`. That is an honest stub, not a hidden filing.

## Environments

| Environment | What you get | How the UI must speak |
| --- | --- | --- |
| Sandbox | Free. Real shaped documents with a DEMO watermark. Synthetic identity allowed (and real personal data refused when that flag is on). | Amber "Demo formation (sandbox)". Never green. |
| Production | Paid pack ($100 to $150 per company). Real Articles, registered agent, EIN path. Real personal data required. | Ordinary legal copy. |

A mainnet Arc deployment is not allowed to point at Doola sandbox. The backend refuses to boot that combination.

Each entity **pins** the environment it was claimed in. A later flip of the box to production cannot silently refile a sandbox company at `api.doola.com`.

## What we collect

Wyoming filing needs a named responsible party. World ID is deliberately zero PII. Formation is the first place personal data enters the system.

The wizard and MCP expose a dedicated step / tool (`create_formation_party`). Personal data lives there only. It is **never** copied into the agent spec, the metadata JSON, or the MCP transcript result. You get back an opaque `partyId`.

On sandbox with synthetic PII enabled, pass `synthetic: true` and nothing else. Real names on that deployment are refused so demo data cannot leak into a "real" looking file.

## Pipeline

1. `create_provider`. Open the company with doola.
2. `await_filing`. Articles submitted.
3. `fetch_documents`. Download and hash the PDF pack.
4. `await_ein`. IRS employer identification number.

Progress arrives two ways:

* **Webhook.** HMAC verified. Treated as a wake up only. Never as a source of facts.
* **Sweeper.** The API process polls doola on a timer and writes state from the provider's API.

## Anchoring

Every material legal change produces a new **OA bundle manifest**: canonical JSON over the terms document, every legal file hash, EIN, formation date, filing number, and the on chain identity (`chainId`, proxy, `agentId`).

The manifest hash is the `operatingAgreementHash` from birth (version 1 at `createEntity`). Later versions schedule through `LegalManager`'s existing amendment path, relayed by `NoviController`.

Rules that close double spend of the timelock:

* Versions are **strictly monotonic**
* At most **one pending** version at a time

You get a scheduled amendment notification and a veto card. The card reads chain from **your** wallet RPC.

## Quotas

Formation costs real money in production. The door checks, before mint:

* Per tenant lifetime formation quota (default 3)
* Rolling 24 hour ceiling across the deployment (default 10)
* Pack balance when the provider exposes it

A refused door means no half created entity with a dead mandatory filing.
