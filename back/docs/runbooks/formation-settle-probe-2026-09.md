# B1 merge gate — the live settle probe (Arc testnet)

Two runs: **2026-09-09** through the platform key, and **2026-09-10** through the dedicated
`FORMATION_SETTLE_SUBMITTER_KEY` that gate A2 introduced. Both PASSED, and their gas figures agree
to within twenty units.

## Run 1 (2026-09-09)

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

## Run 2 — dedicated submitter (2026-09-10, head `355d3b5`)

The re-run gate A2 asked for: the same probe, submitting through `FORMATION_SETTLE_SUBMITTER_KEY`
rather than the platform key, against a fresh guardian and a fresh sink.

```
guardian (payer)  0x363BD5d7BE7Ef654F5D6Bddfd37C2D057818AB34
submitter (gas)   0x02d8De0f713278E3BB381AB92DE215DbE62EFc1E
revenue (test)    0x9157c4c14Fc711388e6640a27f0AB0F7561c0c99
funding           0xccee733ff397007c… (0.30 USDC)   0x248751c5516d2b9b… (0.20 USDC)
domain pinned: name="USDC" version="2" ✓
quote: 100000 atomic USDC, nonce 0x8b3c0ccad58d04ded50f02efe1d5bc61ea94f7fae8ac9260d33017436c6ab2e7
settle tx 0xcdef9b04706279821613e50b7a6235ed6328d63c4f82bf039e19fa7de9933c96
settled ✓  authorizationState=true
>>> TRANSFER_WITH_AUTHORIZATION gasUsed = 117059 <<<
cancel tx 0x0d1d8b106ef79dfd423927c8663570acebd406d8401131fb5564b61400286501 (nonce 0xe46c0dc4…)
cancelled ✓  authorizationState=true
>>> CANCEL_AUTHORIZATION gasUsed = 71245 <<<
B1 merge gate PASSED.
```

**What it adds to run 1.** The dedicated submitter is funded, signs, and broadcasts — which is the
half a unit test cannot reach, since the boot invariants only prove the key is SEPARATE and say
nothing about whether anyone can send from it.

**The pinned constants hold for both runs.** 117,059 / 71,245 here against 117,079 / 71,265 there:
twenty gas apart, which is the calldata difference between two addresses, not a difference in the
work. `TRANSFER_WITH_AUTHORIZATION_GAS = 140_000n` and `CANCEL_AUTHORIZATION_GAS = 86_000n` clear
both with the same ~20% headroom, and the gas is a property of the token's code rather than of
which key paid for it — which is exactly what running it from a different submitter demonstrates.

**The domain is `name="USDC"` again**, read from the chain on a second run, on a different day.

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

⚠ Run 1 predates the dedicated submitter (gate A2), which is why its header says "executor". Run 2
above is the re-run from `FORMATION_SETTLE_SUBMITTER_KEY`, and it confirms what the prediction
said it would: the key is funded and can broadcast, and the two `gasUsed` figures did not move.
