# Turnkey Org Switch — Runbook

Consolidate onto **one Turnkey organization** (the frontend dev's org) and point the backend at it.
Written 2026-06-22. Testnet only — recoverable, but follow the order.

---

## TL;DR

Change **4 env vars** (org ID + root API key pair + a sign-with address), **keep** the delegated
keypair and base URL, **reset** the local DB, and **re-onboard a fresh demo agent** under his org.
The only thing that can't carry over verbatim is the existing live agent's operator key — that's
inherent to consolidating into one org, not a config detail.

**Do not delete the old org until the new one is verified working.** It's dormant and free, and it
preserves the old agent's key as a fallback. Deletion is irreversible and not required for the switch.

---

## Background: how the backend uses Turnkey (so the steps make sense)

- **New agents (via the API) use a per-agent sub-org.** Every `/onboard` triggers Step 0 of the saga
  (`backend/src/workflow/onboarding.ts`): it provisions a **fresh sub-org + operator wallet per agent**
  under the root org, using the **delegated keypair**, and binds with that per-agent signer.
  → You do **not** pre-create per-agent sub-orgs; they're made automatically at onboard time.
- **But the server still needs the root-org block to boot.** `main.ts` builds a global operator signer
  via `TurnkeySigner.forKey(cfg.turnkey, cfg.turnkey.signWith)`, and `cfg.turnkey` only exists when
  **all four** root vars are present (`TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`,
  `TURNKEY_ORGANIZATION_ID`, `TURNKEY_SIGN_WITH`) **plus** the delegated pair. So `TURNKEY_SIGN_WITH`
  must point at a real wallet in the org or the server won't start — even though new onboarding
  doesn't actually use it.
- **The delegated keypair is org-agnostic.** It's just a P-256 keypair you hold; its public key is
  embedded into each new sub-org at creation. The same keypair works under any org → **reuse it**.

---

## Part A — His side (in the new Turnkey org)

He creates three things and sends you the values:

- [ ] **Org ID** — copy it from the Turnkey dashboard → for `TURNKEY_ORGANIZATION_ID`.
- [ ] **A root/parent API key** for the backend (create an API key user in the org) →
      gives `TURNKEY_API_PUBLIC_KEY` + `TURNKEY_API_PRIVATE_KEY`.
      This key must be allowed to **create sub-organizations** (root user / default permissions).
- [ ] **One Ethereum wallet** in the root org (any name) → copy its **address** for `TURNKEY_SIGN_WITH`.
      This wallet is only there to satisfy boot; new agents get their own per-agent wallets.

> Send the API **private** key over a secure channel (not Slack/email plaintext). It's a credential.

---

## Part B — Your side (the backend)

### B1. Update `.env`

```diff
- TURNKEY_ORGANIZATION_ID=<old org>
+ TURNKEY_ORGANIZATION_ID=<his org id>
- TURNKEY_API_PUBLIC_KEY=<old root pubkey>
+ TURNKEY_API_PUBLIC_KEY=<his root api pubkey>
- TURNKEY_API_PRIVATE_KEY=<old root privkey>
+ TURNKEY_API_PRIVATE_KEY=<his root api privkey>
- TURNKEY_SIGN_WITH=0x46DE...        # wallet in the OLD org
+ TURNKEY_SIGN_WITH=<address of the new wallet in his org>

  # UNCHANGED — keep exactly as-is:
  TURNKEY_BASE_URL=https://api.turnkey.com
  TURNKEY_DELEGATED_API_PUBLIC_KEY=...     # org-agnostic keypair — reuse it
  TURNKEY_DELEGATED_API_PRIVATE_KEY=...
```

Checklist:
- [ ] `TURNKEY_ORGANIZATION_ID` → his org id
- [ ] `TURNKEY_API_PUBLIC_KEY` → his root API public key
- [ ] `TURNKEY_API_PRIVATE_KEY` → his root API private key
- [ ] `TURNKEY_SIGN_WITH` → address of the new wallet in his org
- [ ] `TURNKEY_BASE_URL` → leave as `https://api.turnkey.com`
- [ ] `TURNKEY_DELEGATED_API_PUBLIC_KEY` / `_PRIVATE_KEY` → **leave unchanged**

### B2. Reset local state

The local DB still references the old org. For a clean slate:

- [ ] Stop the API server.
- [ ] Delete the SQLite files: `rm backend/data/legalbody.db backend/data/legalbody.db-shm backend/data/legalbody.db-wal`
- [ ] (Optional) clear generated docs: `rm -rf backend/data/documents/*`

> Keeping the DB is harmless, but its one record (`e2e-turnkey-1` / agent 656785) points at the old
> org and its operator key won't be reachable from the new org — so a fresh DB is cleaner.

### B3. Re-onboard a fresh demo agent

- [ ] Boot: `npm run api` (should start without errors — proves the root block + sign-with are valid).
- [ ] Run one full onboarding (via the API, or `npm run cli -- create-entity ...`).
- [ ] Confirm it reaches status `bound`.
- [ ] Confirm the new **sub-org appears in HIS dashboard** (this is the real proof the switch worked).

---

## The one real wrinkle: the existing live agent (656785)

Agent **656785**'s operator key (`0x46DE…BF0`) lives in the **old** org. Once the backend points at
the new org, **the backend can no longer sign for 656785** — its key isn't in the new org. Pick one:

- **Recommended (demo):** ignore it. Re-onboard a fresh agent under the new org (B3) — you get an
  identical, fully operational setup. Treat 656785 as a historical testnet artifact.
- **Only if you must keep 656785 itself:** re-bind it with `setAgentWallet` to a new operator
  provisioned in the new org (operator signs the EIP-712 `AgentWalletSet`, manager sends the tx).

This is inherent to consolidating into one org — there's no config that carries an enclave key across
organizations.

---

## Cleanup (only after B3 passes)

- [ ] Confirm new onboarding works end-to-end under his org.
- [ ] Decide on the old org: **leave it dormant** (recommended — free, keeps 656785's key as a
      fallback) or delete it. If deleting, do it deliberately — it destroys `0x46DE` and is
      irreversible. You don't need to delete it to use his org.

---

## Quick reference — what changes vs. stays

| Item | Action |
|---|---|
| `TURNKEY_ORGANIZATION_ID` | **change** → his org |
| `TURNKEY_API_PUBLIC_KEY` / `_PRIVATE_KEY` | **change** → new root API key in his org |
| `TURNKEY_SIGN_WITH` | **change** → new wallet address in his org |
| `TURNKEY_DELEGATED_API_PUBLIC_KEY` / `_PRIVATE_KEY` | **keep** (org-agnostic) |
| `TURNKEY_BASE_URL` | **keep** |
| Per-agent sub-orgs | auto-created at onboard time — nothing to do |
| Local SQLite DB | **reset** |
| Agent 656785 | re-onboard fresh, or re-bind via `setAgentWallet` |
| Old org | leave dormant (don't delete until verified) |
</content>
