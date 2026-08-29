# Guardian controls

The guardian is the natural person behind the LLC and an on chain role. The agent cannot change that role.

## Powers on `AgentTreasury`

| Action | What it does |
| --- | --- |
| `pause` / `unpause` | Stops or resumes `spend`. Immediate. |
| `emergencyWithdraw` | Sends the full USDC balance to the **payout address** (not automatically to your wallet). |
| `setAllowlistEntry` | Add or remove a recipient. |
| `setOperator` | Change the spending key. |
| `vetoPolicyUpdate` | Block a scheduled cap or policy change. |

## Powers on `LegalManager`

| Action | What it does |
| --- | --- |
| Veto a scheduled operating agreement update | Blocks that hash until you lift the veto |
| Lift a veto | Lets the manager schedule or execute again |
| Initiate dissolution | Starts a timelocked wind down |
| Veto dissolution | Stops a dissolution the other role started, if it is not yet finalized |

Status only moves forward: `Active` → `WindingDown` → `Dissolved`. `spend` stops when status is not `Active`. Remaining assets can be swept only while winding down.

## What you sign

1. **SIWE** to log into the app
2. **WebAuthn passkey** (also the Turnkey vault root if you chose that custody)
3. **One transaction per allowlist address** at deploy, from your wallet

Funding the treasury does not need your signature. Policy updates are proposed by the manager and wait in the timelock.

## World ID

Onboarding requires proof of personhood, or an admin issued waiver if the deployment allows it. See [World ID](../identity/world.md).

The stored nullifier is unique per human for this app. The same person cannot open a second guardianship.

## If the agent misbehaves

1. Pause.
2. Rotate the operator if the spending key may be leaked.
3. Emergency withdraw if funds should go to the payout address now.
4. Veto any pending amendment you did not expect.

The dashboard amendment card reads a known hash with a mapping call. Discovering hashes from logs can fail on a pruned RPC. The mapping read is what marks a hash as live.
