# Mainnet readiness — key authority, custody, and the remaining gates

**Created:** 2026-08-11
**Owner:** platform
**Hard deadline:** Arc mainnet launches **2026-09-16** (BlackRock / Visa / DTCC / Mastercard validators).
**Posture:** guarded beta at launch — not open signup.

This document tracks what must be true before Novi Corpus operates on **mainnet**, where the money is
real and mistakes are not redeployable. It is the successor to the conversational roadmap and sits
alongside [`2026-08-07-infra-migration.md`](./2026-08-07-infra-migration.md) (server + public-domain
migration, deferred until after hackathon judging).

Status legend: ✅ done · 🟠 in progress · 🔴 blocking for mainnet · ⚪ decision pending

---

## 1. Key authority separation (security item **S4**)

### The problem

A single private key — `0xb43CbdA374e3CD2a3d67827683F81462BaCF703b`, held in
`PLATFORM_PRIVATE_KEY` — accumulated **every** privileged role in the system:

| Role | What it can do |
|---|---|
| Beacon owner | Rewrite the implementation behind **every agent at once** |
| Factory owner | `createEntity` is `onlyOwner` — mint new legal bodies |
| Per-agent `manager` | Governs each agent's treasury (immutable once set) |
| Funding wallet | Holds and moves operating USDC |
| Env fallback | Default for `JOB_CLIENT_PRIVATE_KEY`, `CUSTOMER_PRIVATE_KEY`, `X402_DEMO_PAYTO` |

The key lives in a `.env` on an application server. **Server compromise therefore equals total
protocol compromise** — an attacker who reads that file can rewrite the rules of every agent holding
customer funds. On testnet this is a recoverable embarrassment; on mainnet it is the whole company.

The fix is not one change but a sequence: pull each role onto a key with a security posture matched to
its blast radius, highest-blast-radius first.

### ✅ Done — beacon ownership moved off the platform key (2026-08-11)

The largest blast radius went first. `UpgradeableBeacon`
`0xCbE36eC37673805a185a6883f9597613ABB41c97` on Arc testnet:

```
tx           0xfe76ad466a858a0c615946d8a67be339bf754c737f60a3f4ada7ee4b1ba53338  (block 56423566)
from         0xb43CbdA374e3CD2a3d67827683F81462BaCF703b   (platform key, .env on the VPS)
to           0x48191Ac42649274C4b3cbeBd16a76B8178e6F6e0   (MetaMask account, off-server)
verified     old key upgradeTo → REJECTED ✓ · new owner upgradeTo → ALLOWED ✓
```

Rehearsed first against a forked mainnet-state anvil, then executed **from the VPS** so the platform
key never left the machine it already lives on.

Notes for whoever operates this next:

- `UpgradeableBeacon` (OZ 5.1.0) is **one-step** `Ownable` — there is no `acceptOwnership`. A transfer
  to a wrong or uncontrolled address is immediate and permanent.
- **Nothing in the backend reads or calls the beacon** — only `back/script/Deploy.s.sol` does, via the
  `BEACON_OWNER` env var (`vm.envOr("BEACON_OWNER", vm.addr(pk))`). The default-to-deployer is exactly
  why the roles collided at deploy time. **Set `BEACON_OWNER` explicitly for every future deploy.**
- Operational impact of this transfer: **zero**. No runtime path touches beacon ownership.

### 🔴 MAINNET REQUIREMENT — the beacon owner must be a hardware wallet

The testnet owner above is a **MetaMask account**. That is deliberate and appropriate for testnet, and
it is **not acceptable for mainnet**.

A MetaMask account is derived from a browser-extension recovery phrase. It is a real improvement over a
key sitting in a server `.env`, but it trades server-compromise risk for phishing and
extension-compromise risk — and every account derived from that phrase shares one blast radius. The key
that can rewrite the rules of every agent holding real customer money must not be reachable from a
browser at all.

**Before mainnet launch:**

1. **Provision a hardware wallet** (Ledger or Trezor) used for nothing else. Seed written on paper,
   stored offline in ≥2 physical locations. Never typed into a computer.
2. **Prove control before transferring.** Send at least one transaction from the destination address on
   the target chain and confirm it on-chain. *This gate was NOT satisfied on testnet — the destination
   had nonce 0 at transfer time, and we relied on EIP-55 checksum validity plus the recoverability of
   testnet. On mainnet the control proof is mandatory, no exceptions.*
3. **Set `BEACON_OWNER`** to the hardware address in the mainnet deploy, so the roles are never
   collapsed on mainnet even briefly.
4. **Longer term:** move beacon ownership behind a **multisig + timelock**, so a single compromised
   hardware wallet still cannot push a silent fleet-wide upgrade. A timelock also gives agent operators
   a window to observe a pending upgrade and exit. Target this before open signup, not before launch.

### 🟠 Remaining S4 work, in blast-radius order

| # | Role still on the platform key | Fix | Gate |
|---|---|---|---|
| 1 | **Factory owner** (`createEntity` is `onlyOwner`) | Transfer to the same cold key as the beacon, or a dedicated minter role | Mainnet |
| 2 | **Per-agent `manager`** | `manager` is `immutable` in `AgentTreasury` and has no setter in `LegalManager` — **existing agents cannot be repointed**. Requires a contract change (add a `minter`/governance role) and applies to new agents only | Mainnet |
| 3 | **Env fallbacks** (`JOB_CLIENT_PRIVATE_KEY`, `CUSTOMER_PRIVATE_KEY`, `X402_DEMO_PAYTO`) | Split into distinct keys; remove the silent default-to-platform-key fallback so a missing var fails loudly instead of quietly escalating privilege | Mainnet |
| 4 | **Funding wallet** | Separate operational wallet, funded per-period, never the governance key | Mainnet |
| 5 | **Timelock + multisig** over 1 and 2 | Governance contract | Before open signup |

Item 2 is the one with a schedule risk: it is a **contract change**, so it needs to land before the
mainnet deploy or every mainnet agent inherits the same collapsed-role problem permanently.

---

## 2. Pocket master seed (security item **S3**) — ⚪ decision pending

One `POCKET_MASTER_SEED` derives the per-agent pocket EOAs for `turnkey`-custody agents. Compromise of
the seed compromises every pocket derived from it. Balances are individually small, but the aggregate
is not, and the seed sits in the same `.env` as everything else.

**Strategic option that closes S3 by construction:** do not offer `turnkey` custody on mainnet at
launch. Since Tier-0 P4 (2026-08-07) `circle` is already the platform default and the wizard's
recommended path — Circle-managed operator keys have no shared-seed derivation, so a mainnet that only
offers `circle` custody has no S3 exposure at all.

This is a **product decision, not just a security one** — it removes the passkey-rooted
self-custody story from the mainnet launch. Decide explicitly rather than by default. If `turnkey`
stays, S3 needs a real fix (per-agent key material, no shared root) before launch.

---

## 3. Other mainnet gates

| Item | Status | Note |
|---|---|---|
| **Arc mainnet registry addresses** | 🔴 Priority 0 | Are the ERC-8004 / ERC-8183 registries deployed on Arc mainnet, at what addresses, with what ABI? Everything on-chain depends on the answer. **Ask Circle — outstanding in the Vivienne email.** |
| **Turnkey signature quota** | 🔴 ops blocker | Plan is metered at **25 signatures/month** plus per-signature charges. Not survivable for production volume. Either negotiate a production plan or resolve via the S3 decision above (no turnkey custody → no quota dependency). |
| **Infra migration WS1** (dedicated VPS, TLS, backups) | 🟠 deferred ~2wks | Currently a shared host with a plaintext HTTP hop and no TLS. See [infra-migration](./2026-08-07-infra-migration.md). Blocked on hackathon judging (submitted URL must not change). |
| **Infra migration WS2** (public domain) | 🟠 deferred ~2wks | Cost grows per agent — passkeys are RP-ID-bound and `metadataURI` is on-chain forever. Do ASAP after judging. Prerequisite: **buy a domain** (none owned). |
| **PostgreSQL 5432 exposed** on the shared host | 🟠 | Not ours — relay to the VPS owner. Resolved by WS1 regardless. |
| **Entity formation** | 🟠 | Delaware C-Corp topco + French SAS subsidiary; doola outreach for the operating entity. Not a code gate but a prerequisite for taking real customer money. |
| **Prod wizard end-to-end** | 🟠 | One agent onboarded through the real production wizard UI — the last untested Tier-0 path. |

---

## 4. Operating rules that carry to mainnet

- **Never trust `$?` after a pipe.** `gh pr checks --watch | tail` masked a red CI once and
  `npm run lint | tail` masked 6 lint errors once — both merged red. Redirect to a file and check the
  exit code explicitly.
- **Validate from the target environment first.** Tier-0 P4 was proven from the VPS before the default
  was flipped; the beacon transfer was rehearsed on a fork before it was executed. Keep doing this.
- **Private keys never enter a chat, a transcript, or a repo.** Keys that must be used are used *where
  they already live*.
- **The Circle entity secret is unrecoverable without its recovery file.** Store that file offline in
  ≥2 locations. Never on the VPS, never in the repo.
