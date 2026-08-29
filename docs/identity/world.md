# World ID

Wyoming DAO LLCs need a natural person. A passkey proves control of a device. World ID proves the guardian is a **unique human**.

The explainer in the app is `/personhood`. `/proof` redirects there.

## What is stored

Verification returns a **nullifier**:

* The same human, proving to this app, always produces the same nullifier.
* A different app sees a different number.
* Name, iris, document, and face are not received.

A second guardianship with the same human hits the same nullifier and is refused.

## What is accepted

The request offers **Orb** and **passport / MNC** document tiers. Device only credentials are rejected. Production entity creation uses Orb or NFC passport grade.

Deployments may allow an **admin issued waiver** when the human has no World ID path. That is logged and optional.

## AgentBook

[AgentBook](https://docs.world.org/) is World's registry on World Chain. A lookup asks whether a paying address is linked to a verified human.

* Look up the address that **signed** the payment. That is the **pocket** EOA, not the operator smart account. The operator address will read as unregistered.
* AgentBook has no unregister.
* Registration is a separate flow from the guardian gate. Until that flow ships, do not register the operator address. That bind cannot be undone.

## Trust policy

If a seller sets `X402_TRUST_POLICY=accountable-only`, a buyer with no human backing gets HTTP `403` and a remediation body, not a `402` payment challenge. No payment is taken.

Rate limits that are per human apply across all agents that share that human.

## Split of duties

World ID does not pause the treasury, withdraw funds, or file an LLC. Those are guardian powers and formation. See [Guardian controls](../product/guardian.md) and [Formation](../product/formation.md).
