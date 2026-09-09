# B1 merge gate — the live settle probe (2026-09-09, Arc testnet)

The gate design §6.9 asks for: **a real signed EIP-3009 authorization, settled on-chain to a test
revenue address, through the product's own functions.** B1 touches no doola, so it needs its own
live proof — the house six-probes precedent applied to money.

Run with `npx tsx scripts/formation-settle-probe.mts` from `back/backend`. It uses
`readUsdcDomain`, `quoteOf`, `verifyTransferAuthorization`, `submitTransferWithAuthorization` and
`submitCancelAuthorization` — the same functions the settle route and the sweeper call — so a
drift between what it proves and what the product does is not expressible.

## Transcript

```
chain 5042002  usdc 0x3600000000000000000000000000000000000000
guardian (payer)  0x2F0DeEf516dDB1c001a252647515F76A68907DD6
executor (gas)    0xb43CbdA374e3CD2a3d67827683F81462BaCF703b
revenue (test)    0xA9856702f9E376abdea9Daefd769Ef1D12F65e8B
domain pinned: name="USDC" version="2" ✓
quote: 100000 atomic USDC -> 0xA9856702f9E376abdea9Daefd769Ef1D12F65e8B, nonce 0xaf6a4193704d06d412960412342d45a4a3557508233aedd2832c3a583c5d19b2
local verification ✓
settle tx 0x2c5d0648b47cbd176825c51f7dab79f089c6eb5bac79f5865365498d7dad61df — broadcasting…
settled ✓  authorizationState=true
>>> TRANSFER_WITH_AUTHORIZATION gasUsed = 117079 <<<
cancel tx 0x33d591a90f490e7dd93e789ed065f0fd5e4397ccfdc4d3ee945291fd873948ff (nonce 0xbd153984ea3ed01dc361b2c7ce7faf5eb94eb7614cd67ff2f7f3abf1c85b3fab) — broadcasting…
cancelled ✓  authorizationState=true
>>> CANCEL_AUTHORIZATION gasUsed = 71265 <<<
B1 merge gate PASSED.
```

A funding transfer preceded it: `0x1650b642dbfc5cd3…`, 0.30 USDC from the executor to the guardian,
so the guardian had something to authorize.

## What it establishes

1. **⚠ THE DOMAIN IS `name: "USDC"`, NOT `"USD Coin"`.** Every reference implementation, and most
   of the documentation, says the latter. Arc's predeploy says the former. This single line is the
   whole argument for `readUsdcDomain` reading the two strings from the chain and pinning them
   against the token's own `DOMAIN_SEPARATOR()`: a hardcoded pair would have verified against
   itself, passed every test in this repo, and reverted `invalid signature` on-chain — after a
   guardian had approved the wallet prompt, with nothing to tell them why. The shared test fixture
   (`test/helpers/formationPayment.ts`) now carries the measured pair.
2. **The executor path produces a transaction the chain mines** — `encodeFunctionData` +
   `signTransaction` + `sendRawTransaction` with explicit gas, composed fresh at broadcast.
3. **THE GAS.** `TRANSFER_WITH_AUTHORIZATION_GAS = 140_000n` and `CANCEL_AUTHORIZATION_GAS =
   86_000n` in `src/adapters/arc/gas.ts` are the measured figures plus ~20%. Unused gas is
   refunded, so being generous costs nothing; being short is a reverted settle on a signature the
   guardian already gave.
4. **`cancelAuthorization` works**, on a second, never-used nonce — which is the guardian's only
   exit from a stuck payment, and the one path no test can prove because the token is somebody
   else's contract.

## Re-running it

The probe refuses any chain id that is not Arc testnet, and refuses a `PROBE_REVENUE_ADDRESS`
equal to the deployment's configured `FORMATION_REVENUE_ADDRESS` — a probe must not put test
transfers into the real revenue trail.

```
PROBE_GUARDIAN_PRIVATE_KEY=0x…   # a TEST EOA holding a few testnet USDC (it is the payer)
PROBE_REVENUE_ADDRESS=0x…        # a TEST destination, NOT the production Ledger
PROBE_AMOUNT_USDC=0.10           # optional (default 0.10)
# ARC_TESTNET_RPC_URL from .env, as everywhere else
# FORMATION_SETTLE_SUBMITTER_KEY where the box has one; otherwise it falls back to
# PLATFORM_PRIVATE_KEY and says so in the header line.
```

⚠ The run above predates the dedicated submitter (gate A2), which is why its header says
"executor". The submitter is a signing identity only — it composes and pays for the transaction —
so the measured gas is a property of the token's code and not of which key sent it. Re-run it
after `FORMATION_SETTLE_SUBMITTER_KEY` is assigned to confirm that key is funded and can broadcast;
the two `gasUsed` figures will not move.
