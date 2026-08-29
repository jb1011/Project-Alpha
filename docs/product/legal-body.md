# The legal body

Each agent is associated with a **Wyoming DAO LLC**. The spending rules you set become the operating agreement. A hash of that agreement is stored on chain in `LegalManager`.

## What the LLC is for

An address that only holds USDC cannot, by itself:

* Own off chain assets (bank account, trademark, domain, equipment) in its own name
* Be a party to a contract a court will enforce
* Limit the human operator's personal liability
* Receive an EIN or pass business KYC
* Keep a legal identity when keys rotate

A filed LLC can do those things. Until filing is complete, the on chain treasury still works. The EIN may still be `STUB-NOT-FILED`. See [Formation](formation.md) and [Current status](../introduction/status.md).

## Why Wyoming

The jurisdiction is Wyoming because of the [DAO LLC statute](https://wyoleg.gov/statutes/compress/title17.pdf) (W.S. 17-31-101 et seq., 2021):

* Articles can name a **managing smart contract**. That is the per agent `LegalManager` address.
* The operating agreement can describe algorithmic management.
* Governing smart contracts must be upgradeable. `LegalManager` is a beacon proxy.
* No state corporate income tax. Annual report minimum is $60.
* A Wyoming registered agent is required.

The operating agreement is private. Only the Articles are public. The chain stores a hash, not the document text.

## Human required

A company with no natural person is not the model used here. A natural person is required by:

1. **Wyoming DAO LLC statute** (W.S. 17-31-114): an entity not under the control of at least one natural person dissolves.
2. **FinCEN customer due diligence:** control attaches to a human.
3. **Circle's terms:** a named person at the identity perimeter.

That person is the on chain **guardian**. The agent is the operator and can only spend inside the treasury rules.

## How rules become the agreement

You set:

* A per transaction cap
* A rolling period cap and period length
* An optional recipient allowlist
* A timelock (hours before an amendment can execute)

The backend turns those values into operating agreement text and into constructor arguments for `AgentTreasury` and `LegalManager`. `LegalManager.meta.operatingAgreementHash` is the SHA-256 of the agreement, stored as `bytes32`.

When formation later adds an EIN, filing number, or document set, the backend builds a **bundle manifest** (JSON over terms, document hashes, legal facts, and on chain identity). The manifest hash becomes the new on chain hash, using the same timelocked amendment path. The guardian can veto it.
