# Custody

**Custody** here means who holds the agent's **operator key** (the key that calls `spend`). It does not mean who holds the USDC. USDC sits in `AgentTreasury`. The guardian wallet keeps pause, veto, and emergency withdraw on both options.

## Options

| Option | Operator key | Gas | Root of the operator key |
| --- | --- | --- | --- |
| Circle MPC (default in the wizard) | Circle MPC smart account | Agent does not pay gas | Platform |
| Turnkey | Turnkey enclave key | Platform sends the bind transaction | Your WebAuthn passkey |

The **pocket** used for x402 is platform managed on both options. Only the operator key changes.

## Circle MPC

The platform takes part in operator signing. It can sign spends as the operator. It cannot skip guardian pause, veto, or withdraw to the payout address. It cannot spend as operator if you chose Turnkey instead.

## Turnkey

The operator key is in a Turnkey vault whose root is your passkey. The platform still sends some transactions (bind, funding) from the manager role. It does not hold that operator key.

## Passkeys

A passkey is always registered. On Circle MPC it is used for human approval where the flow needs it. On Turnkey it is also the root of the operator vault. An MCP agent cannot complete WebAuthn, so agent first onboard still starts in the browser.

## Manager vs guardian

**Manager** is the platform (`NoviController` when `CONTROLLER_ADDRESS` is set). It creates entities and schedules amendments. It cannot `spend` as operator and cannot skip your veto window.

**Guardian** is the wallet you used at onboard. If you lose it and have no recovery, you lose pause and withdraw.
