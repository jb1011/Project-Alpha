# Runbook — NoviController monitoring

Watcher process: `back/backend/src/monitor` · run with `npm run monitor` · unit file
`docs/runbooks/legalbody-monitor.service`.

Why it exists: `grantRole` on the controller is instant, and the 24h admin delay only gates admin
HANDOVER. The controller's delay and the treasury's policy timelock are **reaction windows, not
defenses** — they help only if a human notices inside them. This process is the noticing.
(Design: `docs/design/2026-08-13-novi-controller-design.md` §8.)

The monitor is read-only. It holds no keys, sends no transactions, opens `legalbody.db`
**read-only** and writes only its own `${DATA_DIR}/monitor.db`.

---

## Install on the box

```bash
# 1. unit
sudo cp back/docs/runbooks/legalbody-monitor.service /etc/systemd/system/
sudo systemctl cat legalbody-api          # copy User=, WorkingDirectory=, EnvironmentFile= across
sudoedit /etc/systemd/system/legalbody-monitor.service

# 2. env (all optional; the monitor refuses to start without CONTROLLER_ADDRESS, which the API
#    already sets in controller mode). Legacy pair on this box:
#      MONITOR_WATCH_FACTORIES=0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902
#      MONITOR_WATCH_BEACONS=0xCbE36eC37673805a185a6883f9597613ABB41c97
#      ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...
sudoedit /root/Project-Alpha/back/backend/.env

# 3. start
sudo systemctl daemon-reload
sudo systemctl enable --now legalbody-monitor
journalctl -u legalbody-monitor -f
```

Healthy start looks like:

```
{"opslog":"monitor_start", ... "controller":"0x9526…","factories":[…],"webhook":"configured"}
{"opslog":"monitor_beacon_resolved", ...}
{"opslog":"monitor_scanned","from":"…","to":"…","watched":16,"agents":14}
```

### Discord / Slack webhook

Discord: server → **Edit Channel → Integrations → Webhooks → New Webhook → Copy URL**.
Slack: **Incoming Webhooks** app → **Add New Webhook to Workspace** → copy URL.
Put it in `ALERT_WEBHOOK_URL` and restart. The POST body carries `severity/rule/subject/detail/ts`
plus `content` (Discord) and `text` (Slack), so one URL works for either.

**The webhook URL is a bearer credential** — anyone holding it can post to the channel. It is
redacted from `redact()` and never logged. `chmod 600 .env`.

Only `WARN` and `CRITICAL` are posted. `INFO` is recorded and logged only.

### Config

| Var | Default | Notes |
|---|---|---|
| `CONTROLLER_ADDRESS` | — | **Required.** Refuses to start without it. |
| `ALERT_WEBHOOK_URL` | none | Discord/Slack. Secret. |
| `MONITOR_POLL_SEC` | 30 | Poll interval. |
| `MONITOR_GRANT_TTL_MIN` | 15 | How long a break-glass grant may stand before paging. |
| `MONITOR_LOOKBACK_BLOCKS` | 5000 | Cold-start window only (never genesis). |
| `MONITOR_WATCH_FACTORIES` | none | Extra factories. Configured `FACTORY_ADDRESS` is watched anyway. |
| `MONITOR_WATCH_BEACONS` | none | Extra beacons. The configured factory's `beacon()` is read at startup. |

---

## Rules

Severity: **INFO** = recorded, never paged · **WARN** = look today · **CRITICAL** = look now.

| Rule | Severity | Fires on |
|---|---|---|
| `controller_role_granted` | WARN, **CRITICAL** if WILDCARD or a role outside the 7 standing selectors | controller `RoleGranted` |
| `controller_grant_ttl_exceeded` | CRITICAL, re-pages every TTL | a grant still open after `MONITOR_GRANT_TTL_MIN` |
| `controller_role_revoked` | INFO | controller `RoleRevoked` (closes the TTL row) |
| `controller_admin_transfer_scheduled` | CRITICAL | `DefaultAdminTransferScheduled` |
| `controller_admin_transfer_canceled` | CRITICAL | `DefaultAdminTransferCanceled` |
| `controller_admin_delay_change_scheduled` | CRITICAL | `DefaultAdminDelayChangeScheduled` |
| `controller_admin_delay_change_canceled` | CRITICAL | `DefaultAdminDelayChangeCanceled` |
| `controller_default_admin_granted` | CRITICAL | `DEFAULT_ADMIN_ROLE` granted = handover COMPLETED |
| `controller_bound_target_set` | CRITICAL | `BoundTargetSet` (an M5 registry pin changed/unpinned) |
| `controller_relayed` | INFO | `Relayed` — audit trail only, never paged |
| `beacon_upgraded` | CRITICAL | `Upgraded` on any watched beacon |
| `factory_ownership_transfer_started` | CRITICAL | `OwnershipTransferStarted` on any watched factory |
| `factory_ownership_transferred` | CRITICAL | `OwnershipTransferred` on any watched factory |
| `registry_agent_wallet_set` | INFO on match, **CRITICAL** on rebind or clear | registry wallet bind for one of our agents |
| `registry_identity_transfer` | INFO if it lands on the recorded manager, else **CRITICAL** | identity NFT moved (mints ignored) |
| `treasury_policy_update_scheduled` | WARN, **CRITICAL** if the payout address changes | `PolicyUpdateScheduled` on any of our treasuries |
| `treasury_guardian_notification` | same as above | the guardian-facing copy — subject is the ENTITY |
| `treasury_policy_update_vetoed` / `treasury_policy_updated` | INFO | veto / settle |

---

## Response by alert

### `controller_role_granted` (CRITICAL) / `controller_grant_ttl_exceeded`

**Meaning.** Someone gave an address the right to relay a selector through the controller.
CRITICAL means it was WILDCARD (relay ANY selector at ANY target) or a role outside the seven the
deploy granted. The TTL variant means the grant is still standing — a `BreakGlassOneShot` ceremony
grants, acts and renounces in ONE transaction, so a standing grant is either a broken ceremony or
not ours.

**Do.**
1. Is a ceremony in progress? Ask the admin key holder directly. Do not assume.
2. If yes — confirm the helper spent itself: the ceremony tx should also contain `RoleRevoked`.
   `BreakGlassOneShot.execute` returns `(ok, data)`; **read `ok`** — a failed action needs a fresh
   grant and a fresh helper, and the roles are renounced either way.
3. If no ceremony: the admin **revokes the role now**
   (`controller.revokeRole(role, account)`), then rotate the executor key
   (`PLATFORM_PRIVATE_KEY`) and re-grant the seven selectors to the new address. Restart the API —
   `bootVerify` will refuse to boot until all seven grants and both pins are correct on-chain.
4. Check `controller_relayed` INFO rows around the same block for what the grant was used for.

### `controller_admin_transfer_scheduled` / `_canceled`, `controller_default_admin_granted`

**Meaning.** The controller's DEFAULT_ADMIN is being handed over (or the handover completed).
`detail.acceptableAt` is when it can be accepted; `detail.renounce: true` means the new admin is
`address(0)` — **that permanently freezes governance** (manager is immutable, no one can ever
rotate a role again).

**Do.** If this is not a ceremony you are running, the current admin calls
`cancelDefaultAdminTransfer()` **before `acceptableAt`**. That window is the entire defense. If
`controller_default_admin_granted` already fired, the handover is done: verify `defaultAdmin()`
on-chain and treat an unrecognised address as a full compromise of platform authority.

### `controller_admin_delay_change_scheduled` / `_canceled`

**Meaning.** Someone is changing the length of the reaction window itself. A shortened delay is a
precursor move.

**Do.** Confirm with the admin holder. If unplanned, `rollbackDefaultAdminDelay()`.

### `controller_bound_target_set`

**Meaning.** An M5 pin changed. Pins are what stop a registry selector being relayed at an
arbitrary contract. `detail.unpinned: true` means the pin was removed entirely.

**Do.** Unless you just migrated the registry, re-pin from the admin
(`setBoundTarget(selector, IDENTITY_REGISTRY)`) and treat the admin key as suspect. Restarting the
API re-verifies both pins and refuses to boot if they are wrong.

### `beacon_upgraded`

**Meaning.** The implementation behind a beacon changed — **every agent behind it now runs
different logic**, with no per-agent consent and no timelock. Highest blast radius on the chain.

**Do.** If unplanned: this is an incident. Compare `detail.implementation` against the known-good
impl (`0xc2e89ABf562f2EB366e4dde42325af16EeF542a6` on testnet). The beacon owner (the controller,
or `0x4819…F6e0` for the legacy beacon) must upgrade back. Pause treasuries
(`AgentTreasury.pause()`, guardian or manager) while you assess.

### `factory_ownership_transfer_started` / `_transferred`

**Meaning.** Ownable2Step on a factory. `Started` is the OFFER, and it is the last cancellable
moment; `Transferred` is done. The factory owner controls `createEntity` and is the beacon owner's
counterpart in the deploy.

**Do.** If unplanned, the current owner re-calls `transferOwnership(currentOwner)` to void the
pending offer before it is accepted. After `Transferred`, verify `factory.owner()` — if it is not
the controller, no new entity can be created correctly and the API's `bootVerify` will refuse to
start.

### `registry_agent_wallet_set` (CRITICAL)

**Meaning.** `outcome: "unexpected_rebind"` — the agent's wallet was bound to something other than
the operator we recorded. This is the **one granted operation with no timelock and no guardian
veto**. `outcome: "cleared"` — the binding was removed (the registry does this on every transfer,
and on `unsetAgentWallet`).

**Do.**
1. Compare `detail.newWallet` with `detail.recordedOperator`. If the new wallet is an operator we
   rotated to and simply did not record, fix the DB row; otherwise treat as compromise.
2. Until resolved, the agent resolves to a wallet we do not control — **stop paying it**. Pause the
   treasury.
3. Re-bind through the normal path once ownership is confirmed (the bind needs an EIP-712
   `AgentWalletSet` signature from the new wallet AND the NFT owner as caller).

### `registry_identity_transfer` (CRITICAL)

**Meaning.** The agent's identity NFT moved to an address that is not the manager we recorded.
Note the registry **clears the `agentWallet` binding on transfer**, so the agent cannot be resolved
to a wallet until re-bound.

**Do.** Verify `ownerOf(agentId)`. If the NFT left our control, the identity is gone (ERC-721; we
cannot pull it back). Mark the entity, stop routing payments to it, and treat the executor/admin
keys as suspect — only the NFT owner could have moved it.

### `treasury_policy_update_scheduled` + `treasury_guardian_notification`

**Meaning.** A new spend policy is scheduled on one of our treasuries. **CRITICAL means the PAYOUT
ADDRESS is changing** — that is exactly the shape a backend breach takes: point the money
elsewhere, wait out the timelock, drain. The guardian row carries `guardian` and `vetoDeadline`.

**Do.**
1. Did we schedule it? Check for a matching `controller_relayed` INFO row and a wizard/API action.
2. **Notify the guardian immediately** — the guardian is the user's own wallet and is the ONLY
   party outside the backend domain. Their veto is the designed line of defense.
   `AgentTreasury.vetoPolicyUpdate(policyId)` before `detail.vetoDeadline`.
3. If the backend is suspect, also `pause()` the treasury.

`currentPayoutAddress: "unreadable"` means the on-chain read failed — the alert stayed WARN, but
**it is not evidence the payout is unchanged**. Read `payoutAddress()` manually.

### `controller_relayed`, `treasury_policy_updated`, `treasury_policy_update_vetoed` (INFO)

Never paged. These are the trail you read to answer "was this us?" during any of the above.

---

## Querying the trail

```bash
# live pages
journalctl -u legalbody-monitor -f | grep monitor_alert

# everything critical today
journalctl -u legalbody-monitor --since today | grep '"severity":"CRITICAL"'

# the audit log itself (INFO included)
sqlite3 -header data/monitor.db \
  "SELECT datetime(ts/1000,'unixepoch') AS t, severity, rule, subject FROM alerts ORDER BY id DESC LIMIT 40;"

# grants the monitor believes are still open
sqlite3 -header data/monitor.db "SELECT * FROM open_grants;"

# where the scan is
sqlite3 data/monitor.db "SELECT last_scanned_block FROM cursor;"
```

## Operating notes

- **Re-scanning is safe.** Every alert carries a dedup key derived from `(rule, txHash, logIndex)`,
  so a re-read chunk or a restart never double-pages. To force a re-scan of recent history:
  `sqlite3 data/monitor.db "UPDATE cursor SET last_scanned_block = <block>;"` and restart.
- **Deleting `monitor.db` is a cold start**, not a disaster: the monitor resumes from
  `latest - MONITOR_LOOKBACK_BLOCKS`. It will re-alert on anything in that window, and it forgets
  which grants were open.
- **`getLogs` block-range caps differ per endpoint.** The box's token'd RPC accepts 100,000; the
  public `rpc.testnet.arc.network` rejects 90,000 and 50,000 but serves 5,000 (measured
  2026-08-18). The monitor starts at 90,000 and **halves on every `requested range too large`**
  down to a 1,000-block floor, logging `monitor_range_reduced`. It needs one tick per halving, so
  after a switch to a stricter endpoint expect a few minutes of `monitor_range_reduced` before
  `monitor_scanned` resumes — that is the monitor tuning itself, not an outage. The cursor advances
  per chunk, so a failed chunk is simply re-read.
- `monitor_range_floor_reached` means shrinking did not help: the endpoint is refusing even a
  1,000-block window. Check the RPC, do not wait it out.
- **What is NOT tracked for TTL:** `DEFAULT_ADMIN_ROLE` (permanent by design — never renounce) and
  the seven standing selector roles **held by the executor address** (the exact pairing
  `bootVerify` asserts at every API boot). Anything else is treated as a ceremony grant.
- **Silence is not proof.** If `monitor_scanned` stops appearing, the watcher is not watching:
  `systemctl status legalbody-monitor`. Persistent `monitor_scan_failed` /
  `monitor_head_read_failed` lines mean the RPC is the problem, not the chain.

## Known gaps

- No dead-man's switch: nothing pages when the MONITOR itself stops. Until one exists, treat the
  absence of `monitor_scanned` as an alert and check the unit after any box restart.
- No alerting on `AgentTreasury` `Paused`/`OperatorRotated`/`EmergencyWithdrawn`, or on
  `LegalManager` dissolution events. Add if the §8 set proves too narrow in practice.
- The wallet-bind rule keys off the registry's `MetadataSet(agentId, "agentWallet", …)` event —
  the live ERC-8004 registry has **no** `AgentWalletSet` event (verified 2026-08-18 against the
  verified implementation `0x7274e874ca62410a93bd8bf61c69d8045e399c02`). If the registry proxy is
  ever upgraded, re-confirm that event before trusting this rule.
