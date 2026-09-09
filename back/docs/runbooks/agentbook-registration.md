# Runbook: AgentBook registration

> Design: `back/docs/design/2026-08-25-agentbook-registration-design.md` (v3). Audit:
> `back/docs/design/2026-09-07-agentbook-registration-audit.md`. Plan:
> `back/docs/plans/2026-09-07-agentbook-registration-plan.md`.
> Code: `src/adapters/worldid/agentBookRegistrar.ts`, `src/api/routes/agentBook.ts`,
> `src/workflow/agentBookReconcile.ts`, `src/persistence/agentBookRepository.ts`,
> `interface/src/components/agents/VouchDialog.tsx`.

AgentBook is World's public registry on **World Chain mainnet** (chain id 480, contract
`0xA23aB2712eA7BBa896930544C7d6636a96b944dA`). A vouch is a permanent, public statement about a
real person. Everything below exists so that no operator action can make that statement by
accident, and so that no surface ever claims one that did not happen.

---

## Two halves: reading needs no key, writing does

| | Needs | What it gives |
|---|---|---|
| **Read** | nothing (`WORLD_CHAIN_RPC` and `WORLD_AGENTBOOK_ADDRESS` both have defaults) | `GET /entities/:id/agentbook`, the dashboard chip, the buyer/seller trust dials |
| **Write** | `WORLDCHAIN_SUBMITTER_PRIVATE_KEY` **and** the existing `WORLD_*` portal block | `POST /entities/:id/agentbook/session` + `…/register`, the "Vouch in AgentBook" button |

> **`WORLD_AGENTBOOK_ADDRESS` moves the BACKEND only.** The browser hard-codes the contract
> address and the worldscan link behind the dashboard chip, so pointing the backend at a different
> AgentBook leaves the chip linking to the canonical one. Overriding it is unsupported for anything
> but a local experiment.

`canRegisterAgentBook(cfg)` (`src/config/env.ts`) is the one definition of the write half: a
submitter key **and** `cfg.world` (the Orb gate reads `WorldStore`). `main.ts` builds the registrar
from that predicate, `GET /config.agentBookRegistrationAvailable` reports exactly
`Boolean(deps.agentBook?.registrar)`, and the two write routes answer **503 `unavailable`**
("AgentBook registration is not configured on this deployment") without it. So:

- **prod today, with no submitter key, is a supported shape.** The chip keeps working, the trust
  dials keep working, and the vouch button renders disabled with "Vouching is not enabled on this
  deployment". Nothing 404s.
- adding the key is the whole feature flag. There is no second switch.

---

## The submitter wallet

> **Production submitter (since 2026-09-09):** `0x35DC45aFD562D67c5cad7FE518F6407224a0d104`, key generated on the box
> and never exported. The box's env file is `/home/novi/Project-Alpha/back/backend/.env` (service
> `legalbody-api`, user `novi`); a backup of the pre-key env sits beside it as `.env.bak-2026-09-09`.

- **Generate a fresh key** (`cast wallet new`). It is `WORLDCHAIN_SUBMITTER_PRIVATE_KEY`. Never
  reuse another key: boot refuses equality with every other configured key material —
  `PLATFORM_PRIVATE_KEY`, `CUSTOMER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `JOB_CLIENT_PRIVATE_KEY`,
  `JOB_EVALUATOR_PRIVATE_KEY`, `X402_PROOF_AGENT_KEY`, `ENS_GATEWAY_SIGNER_KEY` and
  `POCKET_MASTER_SEED` — **in every environment**, not just production.
- **Fund the address with 0.005 ETH on World Chain (chain id 480) only.** Bridge from Ethereum or
  Base with <https://worldchain-mainnet.bridge.alchemy.com> or withdraw from an exchange that
  supports World Chain. Never fund this address on any other chain: an EOA key is valid everywhere.
  At the measured gas (0.0015 gwei, ~300–400k gas, ≈ $0.0015 a registration; design §1.4) 0.005 ETH
  is thousands of vouches — it is a float, not a budget.
- **The address** is printed beside the key by `cast wallet new`; recover it later with
  `cast wallet address --interactive` (which prompts, rather than putting the key in shell history
  or in `ps`). That address is where every registration is sent from and the one to watch on
  worldscan.
- Set `WORLDCHAIN_SUBMITTER_RPC` to a paid endpoint if the public one throttles. It is separate
  from `WORLD_CHAIN_RPC` on purpose: reads (the trust dials, every chip) stay on the shared
  endpoint, writes get their own. Unset, it defaults to `WORLD_CHAIN_RPC`.
- **Balance:** the register route reads the submitter's balance before signing. At **exactly zero**
  it logs `agentbook_submitter_low` and returns **503** ("registrations are paused"); it does not
  pre-empt a low-but-nonzero balance, so watch the number, not the log line.

```bash
cast balance <submitter-address> --rpc-url https://worldchain-mainnet.g.alchemy.com/public
```

- **Log hygiene.** Nothing prints the config today. If a config dump is ever added, `redact()`
  prints `agentBook.rpcUrl` (the WRITE endpoint, which travels with the submitter key) as
  `REDACTED` and `worldChain.rpcUrl` (the READ endpoint) as its ORIGIN alone — an Alchemy URL
  carries its API key in the path, so the host is safe to see and is what tells you which endpoint
  the box resolved to. `opsLog` events never carry either.
- **Boot confirmation.** With the write half configured, boot prints
  `⚠ AgentBook registration ENABLED at /entities/:id/agentbook/session`, then
  `AgentBook reconcile at boot: N checked, M changed`.

---

## Deploy order

**1. Re-check the waiver claim on the live API.** PR #98 is deployed and verified as of
2026-09-09: both waiver agents read `humanVerified:false`. This is no longer a blocker, it is a
pre-deploy re-check — a rollback or a stale build would put the false claim back, and a personhood
claim written to a public chain is permanent.

```bash
curl -s https://api.novicorpus.com/transparency | grep -c '"credential":"waiver"'
# and, precisely — every waiver entity must read humanVerified:false:
curl -s https://api.novicorpus.com/transparency \
  | jq '[.entities[] | select(.credential=="waiver") | .humanVerified] | unique'
# expected: []  (no waiver guardians on this box) or [false]. A `true` here blocks the deploy.
```

**2. Backend with the two variables.** `WORLDCHAIN_SUBMITTER_PRIVATE_KEY` (+ optional
`WORLDCHAIN_SUBMITTER_RPC`) into the box's `EnvironmentFile`, restart, then:

```bash
curl -s https://api.novicorpus.com/config | jq .agentBookRegistrationAvailable   # true
journalctl -u legalbody-api -n 50 | grep -i agentbook                            # the ⚠ line
```

In production a submitter key **without** the `WORLD_*` portal block refuses to boot
("a half-configured AgentBook feature is refused in production") — a funded key paying for a
surface that is not mounted is worse than no key at all.

**3. Interface build**, with the `idkit-core-v2` alias installed. It is in `package-lock.json`
(`"idkit-core-v2": "npm:@worldcoin/idkit-core@2.1.0"`), so `npm ci` picks it up; a stale
`node_modules` does not, and the dialog's dynamic `import("idkit-core-v2")` fails at the QR step.

> ⚠ **The Vercel deploy is blocked while the GitHub repo is private** — the Hobby plan refuses
> builds authored by a non-owner on a private repo. Step 3 therefore needs either the repo made
> public, or a manual deploy by the account owner (JB). Plan for it: the backend half can ship
> without the frontend, and simply leaves the button unbuilt.

Order matters in one direction only: **the backend variable before the interface build.** With the
flag false the dialog never renders, and a guardian cannot reach a QR the box cannot broadcast for.

---

## The first live registration (one-off, mainnet)

**Preconditions:** prod backend, `NODE_ENV=production`, the founder's own World ID (**Orb** — a
passport or MNC credential is refused, and a waiver is refused), and a circle agent whose
`pocketAddress` is stored and whose status is `bound` or `funded`. The founder accepts that their
AgentBook pseudonym is **permanently** linked to this agent and to the `/proof` demo key from
Lisbon — the same World ID vouching twice is publicly one backer.

1. Open the agent dashboard, press **"Vouch in AgentBook"**, read the dialog, tick the box.
2. Scan the QR with World App. Note whether the request shows **"AgentKit"** (World's registry app,
   not "AgentBook") and whether **Face Auth** was requested. Both are claims the dialog copy makes.
3. Wait for **"Registration submitted."** and open the transaction on worldscan.org via the
   "View the transaction" link.
4. **Record in the table below:** date, agent id, pocket address, tx hash, the nullifier (from the
   row — see the query under *Day 2*), whether a second proof from the same World ID was accepted,
   and the packed signal (the `signal` field of the session response) as the golden vector for
   `back/backend/test/world/agentBookRegistrar.test.ts`.
5. Reload the dashboard: the chip must read **"Vouched in AgentBook ↗"** within one reconcile.

Independent confirmation, not through our own API:

```bash
cast call 0xA23aB2712eA7BBa896930544C7d6636a96b944dA "lookupHuman(address)(uint256)" <pocket> \
  --rpc-url https://worldchain-mainnet.g.alchemy.com/public
# 0 = no entry. Anything else is the humanId, and must equal our stored nullifier as a NUMBER
# (we store World's zero-padded spelling; the contract returns the minimal one).
```

### Expected failure modes and what they mean

| Response | Meaning | What to do |
|---|---|---|
| **403 `not_eligible`** | the guardian's stored credential is not Orb-grade (`orb` / `proof_of_human`); `details.credential` names what it is | nothing to fix on our side. AgentBook accepts nothing else, and we do not fake it |
| **409 `not_ready`** | `no-pocket-yet` (no payment address stored), `entity-is-<status>` (below `bound`), `no-agent-id-yet` | wait for the agent to finish binding. Only `no-pocket-yet` disables the button (it is the one reason the status route emits); the other two are raised by `POST …/session` and surface in the dialog as a message |
| **409 `conflict`** | no open session / session expired (5 min) / nonce mismatch / "the registry moved" (someone else vouched between session and submit) / a registration already in flight / session already used | start again; the dialog offers the retry and carries the notice |
| **429 `limit_exceeded`** | **per entity, lifetime:** 3 rows that reached the chain (`submitted`, `confirmed`, `disputed` — an `expired` or `failed` session costs nothing); **per tenant:** 5 sessions an hour | deliberate (design D13). Not raisable from the runbook — the caps are constants in `main.ts` |
| **503 `unavailable`** | no submitter key ("not configured on this deployment"); **zero balance** ("registrations are paused", logged `agentbook_submitter_low`); RPC budget exhausted ("AgentBook is busy"); World Chain unreachable ("could not read AgentBook" / "could not submit the registration") | check `/config`, then the balance, then the RPC. Nothing was written in any of these |
| **400 `proof_rejected`** + `details.errorName` | the contract rejected the proof at simulate **or** at sign — deterministic either way. Wrong constants (app id, action, signal packing) or a reused proof | **nothing was written.** Compare the constants in `agentBookRegistrar.ts` with World's CLI at commit `434407c` before retrying |
| Chip stuck on **"Vouch submitted, checking the registry"** > ~10 min | the transaction has not been seen at `safe` yet, or was dropped from the mempool | the reconciler re-broadcasts the stored raw tx after `STALE_AFTER_MS` (10 min) and only calls it `replaced` when the submitter's **mined** nonce has passed ours *and* a re-read receipt still is not a success. Check worldscan for the submitter address's transactions |

Two client-side refusals never reach the API, and both mean *stop*, not *retry*: the dialog
recomputes the 52-byte signal locally and refuses a session whose signal differs (D8), and it pins
the pocket address per agent on first sight and refuses when it changes.

---

## Day 2

**The reconciler has no timer yet** (design §9, deliberately deferred). It runs at **boot** and on
every **`GET /entities/:id/agentbook`** for a row that is `pending` or `submitted` — which the
vouch dialog drives every 5 s while a flow is in flight, and any dashboard open does once. A row
that goes stale with nobody looking stays stale until someone opens the page or the API restarts.
Restarting the API is therefore a legitimate way to force a sweep.

Reconcile-on-read needs the **write** half: a read-only deployment serves the row as stored and
never re-broadcasts.

Ops events, one JSON line each (`journalctl -u legalbody-api | grep opslog`):

`agentbook_submitted` · `agentbook_confirmed` · `agentbook_disputed` · `agentbook_failed`
(`reason: reverted|replaced`) · `agentbook_rebroadcast` · `agentbook_awaiting_safe` ·
`agentbook_submitter_low` · `agentbook_proof_rejected` (`stage`, `errorName`) ·
`agentbook_write_unavailable` · `agentbook_session_unavailable` · `agentbook_broadcast_unavailable`
· `agentbook_txhash_unrecorded` · `agentbook_reconcile_unavailable`. Tenants appear as a 10-char
prefix and never a nullifier: a *failed* attempt's nullifier is not public and must not be logged.

The rows:

```bash
sqlite3 "$DATA_DIR/legalbody.db" \
  "SELECT id, entity_key, status, nullifier, tx_hash, submitter_nonce, attempt, error_code,
          created_at, updated_at
     FROM agentbook_registrations ORDER BY id DESC LIMIT 20;"
```

Budgets (process-wide, `main.ts`): status reads `TokenBucket(60, 2)`, writes `TokenBucket(30, 0.5)`
— separate on purpose, so a dashboard refresh storm cannot starve a vouch and a vouch storm cannot
blind the chip. The status route also caches lookups **10 minutes positive / 60 seconds negative**,
so a foreign registration can take up to a minute to show as `disputed`; a reconcile that ran in
the same request always outranks the cache.

`errorCode` is a last-attempt diagnostic. It is meaningful on a `failed` or `disputed` row only,
and confirming a row clears it.

---

## Records

| Date | Agent | Pocket | Tx | Notes |
|---|---|---|---|---|
| 2026-09-09 22:33Z | 843704 (TestMB2, Arc testnet) | `0xeE85Fd00521d1Aa4c510BDdAb78F375830119354` | [`0x31f50a24…3ac545`](https://worldscan.org/tx/0x31f50a24ace9323d9aeb6a35aa3984724b32ef0b2989ede31101d224313ac545) | First live vouch, founder's Orb World ID. Block 34828792, success, `register(agent, root, nonce=0, nullifierHash=2314105170434189941199883173669244081948291750651867211658387977125002465844, proof)`; `lookupHuman(pocket)` returns that exact nullifier. Gas 315,564 at 0.0015 gwei + L1 fee ≈ 0.00000048 ETH (design §1.4 estimate held). Constants correct on the first run (no `proof_rejected`). Row went `submitted` → awaiting `safe` (safe lagged ~100 blocks). Session `signal` not captured; derive with `buildSignal(pocket, 0)`. World App showed the request as AgentKit ("you can use AgentKit now" on approval) and did NOT ask for Face Auth; the dialog's "may ask for Face Auth" stands as hedged. Chip read "Vouched in AgentBook ↗" on the next dashboard load after `safe` passed the block (~3 min). |
