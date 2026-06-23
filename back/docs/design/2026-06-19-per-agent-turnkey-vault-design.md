# Per-Agent Turnkey Vault — Onboarding Provisioning (Design)

> **Status:** approved 2026-06-19 (brainstorm). Core-protocol change (onboarding + persistence + Turnkey
> adapter). Separate workstream from the nanopayment branch — its own branch/plan off `master`.
> **Plan-time TODO:** verify the exact Turnkey API shapes (sub-org create with a passkey root, delegated-access
> policy grammar, wallet/account creation) against current Turnkey docs before writing the implementation plan.

## In one sentence

Move from one shared Turnkey signing key for all agents to a **Turnkey sub-organization + wallet per agent**,
where the human **guardian is the sub-org root (via a passkey)** and the backend is a **policy-bounded
delegated signer** — provisioned by the backend's onboarding saga and persisted on the entity.

## Why

Today the backend signs every agent's operations with a single shared Turnkey key
(`TURNKEY_ORGANIZATION_ID` + `TURNKEY_SIGN_WITH`); `entities.operator` stores the one shared EOA. That is
fine for a single demo agent but is not the real model: it gives every agent the same operator, and it gives
no agent's human controller their own root authority. The non-custodial legal model
(`2026-06-08-wallet-and-treasury-architecture.md`) requires the **human controller to hold the keys, not the
platform** — which, in Turnkey terms, means **one sub-org per agent with the guardian as root**, and the
backend acting only as a delegated, policy-bounded operator. `turnkeySigner.ts:19` already flagged per-agent
sub-org provisioning as "out of band in v1"; this design brings it in-band.

## Scope

**In scope:**
- A backend Turnkey **provisioning adapter** (create sub-org with the guardian's passkey as root → create
  wallet + operator account → attach a delegated-access policy for the backend's signer key).
- A new **onboarding saga step (Step 0)** that provisions the vault before `createEntity`, captures the ids,
  and persists them; the operator address for `createEntity`/bind now comes from the per-agent wallet.
- `entities` **schema additions** (`turnkey_sub_org_id`, `turnkey_wallet_id`; `operator` already exists).
- **Per-agent signer construction** (build the `OperatorSigner` from the entity's stored sub-org id +
  operator address) used by the bind step and the governed funding top-ups.
- The **frontend ↔ backend contract** for the passkey handshake (what the frontend sends; what the backend
  returns) — backend side only; the frontend WebAuthn UI is the frontend dev's work.

**Out of scope (now):**
- The frontend WebAuthn UI implementation.
- Full guardian recovery UX (a backup authenticator is added at creation; the complete lost-device recovery
  flow is a fast-follow).
- Migrating the existing shared-key agent (656785) — it stays as legacy; new columns are nullable.
- Per-payment signing — nanopayments still use the bounded **pocket** hot-key (the tiered model is unchanged;
  Turnkey signs only the rare bind + governed top-ups).

## Decisions (locked during brainstorming)

1. **Per-agent Turnkey sub-org + wallet** (not a shared key).
2. **Backend-orchestrated provisioning** (the saga creates the vault), not frontend-created — for one-action
   UX, a resumable saga, and no orphaned vault↔entity states.
3. **Guardian root credential = a passkey (WebAuthn)** created client-side; its attestation is sent to the
   backend, which makes it the sub-org root. The private key never leaves the guardian's device.
4. **Backend = a non-root delegated signer** scoped by a Turnkey policy to sign the operator's bounded
   operations only — never root actions (recover / export / change-root / change-policy).
5. **Recovery:** add a **second authenticator at creation** (backup passkey or Turnkey email-recovery) so a
   lost device is not fatal; full recovery UX is a fast-follow.
6. **Migration:** legacy shared-key path keeps working; per-agent vaults apply to **new** onboardings only;
   new columns nullable, no backfill.

## Onboarding flow

```
FRONTEND (only client-side step)                  BACKEND onboarding saga (orchestrates the rest)
─────────────────────────────────                 ───────────────────────────────────────────────────
guardian: WebAuthn create (passkey)  ──attestation─▶ Step 0 (NEW) provision vault:
 + agent spec                                          • createSubOrganization(rootUser = guardian passkey,
                                                         + backup authenticator)
                                                       • createWallet + operator account → operator address
                                                       • attach delegated-access policy for the backend key
                                                       • persist sub_org_id, wallet_id, operator on the entity
                                                     Step 1 translate spec → on-chain rules
                                                     Step 2 createEntity(operator)            [on-chain]
                                                     Step 3 bind operator (EIP-712 signWalletSet, per-agent signer)
                                                     Step 4 fund
                                                  ◀── streams progress; resumable; nothing orphaned
```

The passkey private key never leaves the device. The backend holds only the **parent-org API key** (to create
sub-orgs) and a **delegated** key scoped by policy to the operator's payloads.

## Components

| Unit | Responsibility |
|---|---|
| `adapters/turnkey/provisioner.ts` (new) | `provisionAgentVault({ guardianPasskey, backupAuthenticator? }) → { subOrgId, walletId, operator }`: create sub-org (passkey root) → wallet + operator account → delegated-access policy. The only Turnkey **mutation** surface in the backend. |
| `workflow/onboarding.ts` (modify) | New Step 0 calls the provisioner, persists the ids, and supplies the per-agent `operator` to the existing createEntity/bind steps. Idempotent/resumable like the rest of the saga (a `provisioned` status before `created`). |
| `persistence/db.ts` + `entityRepository.ts` (modify) | Add `turnkey_sub_org_id`, `turnkey_wallet_id` columns + `EntityRecord` fields; persist/read them. |
| `adapters/turnkey/operatorSigner.ts` / `turnkeySigner.ts` (modify) | `forEntity(cfg, { subOrgId, operator })`: build the `OperatorSigner`/operator `WalletClient` from the entity's sub-org id (as `organizationId`) + operator address (as `signWith`), instead of the shared `cfg.turnkey.signWith`. The shared-key `forKey` path stays for legacy. |
| `onboarding/server.ts` (new, thin Hono route) | `POST /onboard` — the endpoint the frontend calls with the passkey attestation + spec; drives the saga; returns `{ subOrgId, walletId, operator }` + onboarding status. Separate from the Payment Authority server (`payments/server.ts`); today onboarding is CLI-only, so this is the new HTTP entry the frontend needs. |

## Data model

`entities` gains two **nullable** columns (legacy rows stay null):
- `turnkey_sub_org_id TEXT` — **load-bearing for signing** (the `organizationId` for `@turnkey/viem`).
- `turnkey_wallet_id TEXT` — the wallet container handle (dashboard / key management / export / derive).
- `operator TEXT` (exists) — the operator EOA = `signWith`.

`EntityRecord` gains `turnkeySubOrgId?: string` and `turnkeyWalletId?: string`. A new saga status
`provisioned` precedes `created` (extend the status CHECK + the monotonic order).

## Security model (the legal model, enforced by Turnkey policy — not trust)

- **Guardian = sub-org ROOT** (their passkey): recover / rotate / export / change policy / veto. Full control
  of the agent's vault.
- **Backend = a non-root delegated user** whose API key has a policy allowing only "sign the operator key's
  bounded operations" — no root actions. A fully-compromised backend cannot drain or seize the vault; the
  guardian can revoke the delegated key. This is "human-controller + agent-bounded-operator" made structural.
- This is the same non-custodial rationale that rejected Circle's custodial wallets
  (`2026-06-08-wallet-and-treasury-architecture.md`).

## Frontend ↔ backend contract (backend side)

- **Frontend sends:** the guardian's **passkey attestation** (credential id + public key/attestation object
  from the WebAuthn `create` ceremony) + the agent spec (name, cap, allowlist, guardian address, …).
- **Backend returns:** `{ subOrgId, walletId, operator }` and the onboarding progress/status (the saga is
  resumable, so re-calling with the same idempotency key resumes rather than re-provisions).
- The frontend implements **only** the WebAuthn ceremony + this call — no Turnkey sub-org/wallet/policy logic.

## Error handling & idempotency

- **Provision-before-mint ordering:** Step 0 must complete (vault exists, operator known) before
  `createEntity`; the saga records `provisioned` (with `sub_org_id`/`wallet_id`) so a crash after sub-org
  creation but before on-chain mint **resumes** rather than re-provisioning (avoid orphan sub-orgs — same
  class as the existing create→persist window in `V2_HARDENING_BACKLOG.md`; reuse the stored sub_org_id on
  resume).
- **Partial-failure:** if `createEntity` fails after provisioning, the entity is left at `provisioned` with
  its vault ids stored; a resume continues from there (no second vault).
- A failed/duplicate passkey or a Turnkey policy error surfaces as a clear onboarding error before any
  on-chain spend.

## Testing

- **Deterministic (default):** a **fake provisioning adapter** returns canned `{subOrgId, walletId, operator}`;
  tests exercise the new saga step, persistence of the two columns, the `provisioned→created` status order,
  and per-agent signer construction (`forEntity` builds a signer from stored ids) — all offline, no Turnkey.
- **Opt-in live (gated, like the existing `turnkeySigner.live.test.ts`):** one test that actually creates a
  throwaway sub-org + wallet against Turnkey and asserts the returned ids + a signature recovers — behind an
  env flag, skipped in CI (Turnkey free-tier is metered).
- Quality gate per task: `tsc` + `biome` clean; non-live suite green.

## Open items to verify at plan time

- Exact Turnkey API: `createSubOrganization` with a **passkey** root user (attestation shape), the
  **delegated-access** policy grammar (what scopes the backend key to operator-signing-only), and
  `createWallet`/`createWalletAccounts` for the operator account. Verify against current Turnkey docs
  (Context7 / official docs) before writing the plan.
- Whether the backend's delegated key is one shared platform key with per-sub-org policies, or a per-sub-org
  delegated key — pick the simplest that satisfies "backend cannot do root actions."
