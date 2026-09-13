# Runbook — the Hedera demo, five legs (ETHOnline 2026, testnet)

The recorded demo for ETHGlobal ETHOnline 2026's "AI & Agentic Payments on Hedera" track. Five
legs, in order, each one run of one command: a buyer resolves a Novi Corpus company from its
universal agent id and pays for a signed legal-standing attestation, the guardian pauses the
company and the payment is refused before anything is signed, and the guardian rotates the
agent's key out and the next payment dies on the Hedera ledger itself.

**Spends testnet USDC and HBAR only.** Operator-triggered, never automated. Every leg is a
`demo-buyer` or a guardian action against **prod**, `https://www.novicorpus.com/backend` (design
D28). The client refuses to start unless `HEDERA_DEMO_LOCAL=1` is set and refuses outright when
`NODE_ENV=production`, and prints `DEMO ONLY` as its first line.

Design: [2026-09-10-hedera-rail-design.md](../design/2026-09-10-hedera-rail-design.md).
Plan: [2026-09-10-hedera-rail.md](../plans/2026-09-10-hedera-rail.md), task 15.

## Before you start

Two entities, both onboarded on prod:

| Role | Entity | What it is |
|---|---|---|
| Subject | `FormationE2E_1` | The company being checked. Its UAID is what the buyer is handed. |
| Payer | `HederaDemo_1` | The buyer's own legal body: its policy is checked, its float account pays, its ledger records the payment. |

Credentials come from 1Password, vault **Novi Corpus**, through `op run` only. Item titles, never
field values, and nothing below ever prints one:

| Item | Used by |
|---|---|
| `Hedera Testnet Treasury` | The float account's guardian. Funds the account, signs the key-list update and the revocation. |
| `Hedera Spike Agent Key` | The agent key the buyer signs payments with, and the key leg 4 rotates out. |
| `Hedera Demo Guardian Key` | The Arc guardian of `HederaDemo_1`'s treasury. Signs the pause and the unpause. |
| `Novi Corpus Demo API Key` | The MCP credential for `check_policy` and `report_payment`. Field `prod` for the demo. |
| `Hedera Platform Operator` | The identity-registry writes. Not used by the five legs; listed so the demo's key set is complete. |

Client commands run from `back/hedera-client` under `.env.tpl`; the guardian script runs from
`back/backend` under `.env.guardian.tpl`, which maps `DEMO_GUARDIAN_KEY` and nothing else.

**Write the guardian template first.** `back/backend/.env.guardian.tpl` is not in the repo and
cannot be: `back/backend/.gitignore` ignores every `.env.*` and allowlists only `.env.example` and
`.env.sandbox.example`. That is by design, and the file is never committed. Create it by hand
before leg 2, with this single line and nothing else:

```
DEMO_GUARDIAN_KEY=op://Novi Corpus/<guardian key item>/<field>
```

The item is `HederaDemo_1`'s Arc guardian key, named only in 1Password. Legs 2 and 4 fail at their
first line without this file.

**Point the buyer at prod.** `NOVI_API_BASE`, `NOVI_MCP_URL`, `NOVI_ENTITY_ID` and the field
`NOVI_API_KEY` selects are edited in `back/hedera-client/.env.tpl`, not exported in the shell:
`op run --env-file` injects the template's values into the child process, so an exported variable
of the same name does not survive. Task 16 of the plan is what makes that flip on the recording
day. The four values for the demo:

| Variable | Demo value |
|---|---|
| `NOVI_API_BASE` | `https://www.novicorpus.com/backend` |
| `NOVI_MCP_URL` | `https://www.novicorpus.com/backend/mcp` |
| `NOVI_ENTITY_ID` | `HederaDemo_1`'s id, recorded in task 0 |
| `NOVI_API_KEY` | the `prod` field of `Novi Corpus Demo API Key`, not `local` |

## The five legs

Fill `<uaid>` with `FormationE2E_1`'s universal agent id and `<treasury>` with `HederaDemo_1`'s
treasury address, both recorded in the plan's task 0. Run them in this order; a leg that prints
anything but its expected last line stops the recording.

### 1. Resolve and pay

```bash
cd back/hedera-client
HEDERA_DEMO_LOCAL=1 op run --env-file=.env.tpl -- npx tsx src/cli.ts demo-buyer '<uaid>'
```

The whole run, in the order it prints. Two hops narrate as `→ GET …`, then the profile the second
one carried, then the paid hop, then `report_payment`, then four summary lines drawn from the
attestation and the settlement. The body itself is never printed:

```
DEMO ONLY
→ GET https://www.novicorpus.com/backend/legal-bodies/<treasury>
→ GET https://www.novicorpus.com/backend/metadata/<publicId>
profile: https://www.novicorpus.com/backend/metadata/<publicId>/profile
→ GET https://www.novicorpus.com/backend/verify/<publicId>
report_payment -> settled
HTTP 200
standing: active
humanVerified: true
attestor: 0x<attestor address>
signature valid: true
settlement: OK https://hashscan.io/testnet/transaction/<transaction id>
```

The signature is checked offline, against the `attestor` the body itself names. Compare that
address by eye with the `hedera.attestor` the metadata document publishes: that is the half a
forged body cannot restate.

`signature valid: false` exits 1 and stops the recording, even though the payment settled and the
settlement line still prints. It means the served body and the signature on it disagree, which is
either a drifted attestation key or a document nobody should act on.

### 2. Guardian pauses the payer

```bash
cd back/backend
op run --env-file=.env.guardian.tpl -- npx tsx scripts/guardian-pause.mts pause --treasury <treasury>
```

Last line: `paused: true`. Use `--entity HederaDemo_1` instead only on a box whose local database
holds that row; under D28 the demo entities live on prod, so `--treasury` is the demo's form.

### 3. Buy again, and be refused before signing

The same command as leg 1. Last line:

```
policy denied: paused
```

Exit code 2, and **no HashScan link** — `check_policy` ran inside the payment hook and aborted
before the agent key was asked for anything, so there is no transaction to link to (design D2).

### 4. Unpause, then rotate the agent key out

```bash
cd back/backend
op run --env-file=.env.guardian.tpl -- npx tsx scripts/guardian-pause.mts unpause --treasury <treasury>
cd ../hedera-client
op run --env-file=.env.tpl -- npx tsx src/cli.ts revoke
```

The unpause's last line is `paused: false`. The revocation prints
`rotate agent key out (guardian only): SUCCESS <hashscan link>` and ends on
`after: key ECDSA_SECP256K1` — one key left on the account, the guardian's.

### 5. Buy again, and die on the ledger

The same command as leg 1. Last lines:

```
HTTP 402
PAYMENT-RESPONSE transaction_failed https://hashscan.io/testnet/transaction/<transaction id>
```

Exit code 1. This refusal is not a server saying no: the facilitator signed and submitted the
transfer, and HashScan shows `CRYPTOTRANSFER INVALID_SIGNATURE` under the facilitator's account.

## Recorded run

Filled by the controller at the recording, from the terminal and HashScan. Leave a row empty
rather than guessing at it.

| Leg | Command | Transaction id | Result |
|---|---|---|---|
| 1 | `demo-buyer <uaid>` | | |
| 2 | `guardian-pause.mts pause` | | |
| 3 | `demo-buyer <uaid>` | | |
| 4 | `guardian-pause.mts unpause`, then `revoke` | | |
| 5 | `demo-buyer <uaid>` | | |

Screen capture for each leg, plus the HashScan page for legs 1, 4 and 5.

## Which resolvers follow the profile memo

The float account's Hedera memo is `hcs-11:https://www.novicorpus.com/backend/metadata/<publicId>/profile`.
HTTPS is a listed HCS-11 reference type, so a browser or any HTTP client follows it and reads the
profile. The standards SDK's own resolver branches on `hcs://`, `ipfs://` and `ar://` only, so it
does **not** follow an HTTPS memo; an SDK-based agent uses the three hops of leg 1 instead. An
HCS-1 copy on the consensus log is what would make the profile SDK-resolvable, and it is a later
upgrade (design D11).

## If the deploy slips

The demo targets prod because every hop after the first lands on the deployment that holds the
entity's row (D28). If the Hedera pull requests are not on the box by **Sunday 2026-09-14**, run
all five legs against a local backend instead: onboard both demo entities locally, start the
backend on `http://127.0.0.1:8787` with `HEDERA_ENABLED=1`, point `NOVI_API_BASE` and
`NOVI_MCP_URL` at it, and expose it through a tunnel so the metadata base on chain is reachable.
The legs and their expected lines are unchanged. Say in the video that the backend is local: it is
weaker for judges than a deployed box, and claiming otherwise is the one thing that would make it
worse.
