# Onboarding

The wizard at `/onboarding` is the human path. MCP `onboard_agent` is the agent path. Both run the same saga on the backend. You can close the tab. The saga resumes.

## Phases (human wizard)

The step numbers depend on whether this deployment forms companies. If formation is off, the legal identity step is hidden and the remaining steps renumber.

| Phase | What you do |
| --- | --- |
| Wallet and passkey | SIWE with your wallet. Create a WebAuthn passkey (Face ID, Touch ID, or a security key). |
| Accountable human | World ID proof. Orb, passport, or another accepted document tier. Device only proofs are rejected. |
| Legal identity | Only if formation is available. Name the responsible natural person, or accept the labeled sandbox identity on demo. |
| Key custody | Novi managed Circle MPC (default) or Turnkey vault rooted in your passkey. |
| Define agent | Name, purpose, per transaction cap, period cap, allowlist, timelock. Manual form or MCP draft. |
| Operating agreement | Review the generated agreement. The hash is what will be stored on chain. |
| Deploy on chain | Saga: provision operator key, `createEntity`, bind wallet, write metadata, ENS reverse bind. |
| Fund treasury | Amount in USDC. Platform wallet sends. Capped. |
| Live | Dashboard for this entity. |

## Agent first

If the agent should create the body from a prompt:

1. You still sign in and register a passkey in the browser. An LLM cannot complete WebAuthn.
2. Open `/agents/connect` and request a **bootstrap** package at capability `provision`.
3. You get an MCP URL, an API key shown **once**, and a short lived **link code**.
4. Paste the snippet into the agent. Give it the link code.
5. The agent calls `claim_connection`, then `create_formation_party` if needed, then `onboard_agent`.
6. Poll `get_entity` until status is `bound`.

The bootstrap token's tenant is always your SIWE address. The agent never supplies the owner.

## Idempotency

`POST /onboard` and `onboard_agent` take an idempotency key. Retrying the same key does not mint a second LLC. The runner keeps an in flight set so two doors cannot race the same mint.

## What "bound" means

The entity has:

* A `LegalManager` proxy and an `AgentTreasury`
* An ERC-8004 `agentId`
* An operator key bound as `agentWallet`
* You as `guardian`
* A public id used in ENS and metadata URLs

Formation may still be in progress. Bound is the on chain body, not "the Secretary of State is done."
