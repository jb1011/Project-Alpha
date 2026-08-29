# How it works

Three lookups describe an agent:

```
  Human                  Name                         Money
  ┌───────────────┐      ┌──────────────────────┐     ┌──────────────────┐
  │  World ID     │      │  ENS                 │     │  Arc treasury    │
  │  uniqueness   │      │  <id>.novicorpus.eth │     │  cap, pause,     │
  │  (guardian)   │      │  ⇄ ERC-8004 on Arc   │     │  allowlist       │
  └───────────────┘      └──────────────────────┘     └──────────────────┘
```

1. **World ID** identifies the guardian as a unique human. AgentBook can show whether the paying address is linked to a verified human.
2. **ENS** maps `<id>.novicorpus.eth` to the treasury, legal status, and the Arc identity record.
3. **Treasury** holds USDC and enforces cap, allowlist, and pause on chain. The backend runs extra checks before it signs an x402 payment.

## Components

```
   Guardian                                Agent
   (wallet + passkey + World ID)           (MCP client)
            │                                      │
            ▼                                      ▼
   ┌─────────────────┐                   ┌─────────────────┐
   │  interface/     │                   │  MCP / REST     │
   │  Next.js app    │                   │  scoped key     │
   └────────┬────────┘                   └────────┬────────┘
            │                                     │
            └────────────► backend                 │
                           onboarding, policy,    │
                           payments               │
                                  │
                                  ▼
                     Arc testnet (USDC as gas)
                     Factory → LegalManager + AgentTreasury
                     ERC-8004 identity, ERC-8183 jobs
```

The web app and the MCP server call the same backend. The contracts do not depend on which one you used.

## Creating an entity

1. Sign in with a wallet ([SIWE](https://login.xyz/)) and register a WebAuthn passkey.
2. Prove uniqueness with World ID. The backend stores a **nullifier**, not a name.
3. If formation is enabled, name the natural person for the filing (or a labeled sandbox identity on demo).
4. Choose operator key custody: Circle MPC (default) or a Turnkey vault rooted in the passkey.
5. Set name, purpose, caps, allowlist, timelock. Typed in the wizard or drafted by an MCP agent.
6. The backend writes an operating agreement from those rules. The chain stores the hash.
7. The saga deploys `LegalManager` and `AgentTreasury`, registers ERC-8004 identity, binds the operator, records the guardian.
8. The platform wallet can fund the treasury, up to the configured cap.

If formation is enabled it continues after deploy. Filing does not block the on chain contracts. When EIN or documents change, a new hash is scheduled as a timelocked amendment. The guardian can veto it.

## Roles

| Role | Who | Powers |
| --- | --- | --- |
| Guardian | The human | Pause, unpause, veto policy and operating agreement amendments, set allowlist entries, rotate operator, emergency withdraw to the payout address, initiate or veto dissolution |
| Operator | The agent's spending key | `spend` inside the cap and allowlist. Signs. Does not hold the vault. |
| Manager | The platform (`NoviController` when configured) | `createEntity`, schedule policy and agreement updates, bind identity. Cannot skip the timelock or a guardian veto. |

Guardian, operator, and manager must be different addresses. The contracts revert otherwise.
