# Frontend ⇄ Backend Integration Guide

A guide for connecting the web wizard frontend to the onboarding backend ("the brain").
Written for the frontend dev. Last updated 2026-06-22.

---

## 1. The big picture (read this first)

The backend turns a form submission into a real on-chain "legal body" for an AI agent:
it generates legal docs, registers an identity on Arc, deploys the contracts, and binds the
agent's wallet. That takes time, so **nothing happens instantly** — the frontend submits a
request, then polls for progress until it's done.

Three things to internalize:

1. **You log in with a wallet, not a password.** The person who logs in becomes the agent's
   *guardian* (the human who can pause or rescue it on-chain). Same wallet = same guardian.
2. **Onboarding is async.** You POST the form, get back an `id`, then poll that `id` until the
   status reaches a finished state. Think "submit job → watch progress bar."
3. **The form fields come from the backend**, not hard-coded. Fetch a schema and build the form
   from it, so the form stays in sync when the backend changes.

**Where it runs:** the backend is a plain HTTP server (`npm run api` → `http://localhost:8789`).
Not Next.js, not Vercel — just REST you call with `fetch`.

---

## 2. The happy path, step by step

This is the whole flow in order. Everything else in this doc is reference detail.

```
1. Connect wallet
2. Log in (SIWE)        → get a token
3. Create passkey       → get a guardianPasskey object
4. Fetch the form schema
5. Submit onboarding    → get an { id }
6. Poll the id          → watch status climb to "bound"
7. (optional) Fund it   → poll again until "funded"
```

### Step 1–2: Log in with the wallet (SIWE)

"SIWE" = Sign-In-With-Ethereum. Instead of email+password, the user signs a message with their
wallet to prove who they are.

1. `GET /auth/nonce` → `{ nonce }`  *(a one-time random string)*
2. Build a standard sign-in message containing that nonce and ask the wallet to sign it.
   Use `viem`'s `createSiweMessage` helper on the frontend.
3. `POST /auth/verify` with `{ message, signature }` → `{ token, address, expiresAt }`
4. Save the `token`. Send it as `Authorization: Bearer <token>` on every protected call.
   When `expiresAt` passes (or you get a `401`), repeat from step 1.

> ⚠️ The wallet they log in with **becomes the guardian** of every agent they create. Make this
> clear in the UI — it's a meaningful, permanent role, not a throwaway login.

### Step 3: Create the guardian passkey

Before onboarding, the guardian creates a passkey (Face ID / fingerprint / security key) in the
browser. This is a standard WebAuthn "registration" ceremony.

1. `GET /passkey/challenge` → `{ challenge, rpId }`
2. Run `navigator.credentials.create()` in the browser using that challenge.
3. Reshape the browser's result into the `guardianPasskey` object (see [§4](#guardianpasskey-shape)).
   You'll attach this to the onboarding request in step 5.

> There's a working example of this ceremony in `backend/tools/passkey-capture/` — copy its logic.

### Step 4: Build the form from the schema

`GET /schema/agent-spec.json` returns a JSON Schema describing every field the onboarding form
needs (agent name, treasury spending cap, payout address, etc.). Generate the form from this
instead of hard-coding fields, so the form never drifts from the backend.

### Step 5: Submit onboarding

`POST /onboard` (needs the Bearer token) with:

```jsonc
{
  "spec": { /* the filled-in form, matching agent-spec.json */ },
  "guardianPasskey": { /* the object from step 3 */ },
  "idempotencyKey": "a-stable-id-for-this-submission"  // optional but recommended
}
```

Returns `202 { id, status }` **immediately**. The `id` is your handle for polling.
You don't set the guardian — the backend forces it to the logged-in wallet automatically.

### Step 6: Poll until done

`GET /entities/:id` every ~2–3 seconds. The `status` field climbs through these stages:

```
pending → provisioned → translating → created → bound → funded
                                                            └─ or "failed" (read .error)
```

Drive a progress stepper off this. Stop polling at `bound` (or `funded`, or `failed`).

### Step 7 (optional): Fund the treasury

`POST /entities/:id/fund` with `{ amount }`, where amount is **atomic USDC** (6 decimals):
`25.00 USDC` → send `25000000`. Returns `202`, then poll again until `funded`.

---

## 3. Endpoint reference

Base URL: `http://localhost:8789` (set via `PORT`). "Auth: yes" = needs the Bearer token.

| Method | Path | Auth | What it's for |
|---|---|---|---|
| GET | `/healthz` | no | Is the server up? → `{ ok: true }` |
| GET | `/schema/agent-spec.json` | no | The form schema (build the onboard form from this) |
| GET | `/auth/nonce` | no | Start login → `{ nonce }` |
| POST | `/auth/verify` | no | Finish login → `{ token, address, expiresAt }` |
| GET | `/passkey/challenge` | no | Start passkey creation → `{ challenge, rpId }` |
| POST | `/onboard` | yes | Create an agent → `202 { id, status }` |
| GET | `/entities` | yes | List this user's agents → `EntityView[]` |
| GET | `/entities/:id` | yes | One agent's status/detail (poll this) → `EntityView` |
| POST | `/entities/:id/fund` | yes | Add USDC to the treasury → `202 { id, status }` |

### What `EntityView` contains

The object you get back from `/entities` and `/entities/:id`:

| Field | Meaning |
|---|---|
| `id` | Your handle (the idempotency key) |
| `name` | Agent name |
| `status` | Where it is in the lifecycle (see step 6) |
| `error` | Set only when `status === "failed"` |
| `agentId` | On-chain ERC-8004 agent ID (null until `created`) |
| `proxy`, `treasury`, `operator` | On-chain contract/wallet addresses (null until `created`) |
| `manager`, `guardian` | The platform key and the guardian wallet |
| `oaHash`, `metadataURI` | Operating-agreement hash + metadata pointer |
| `createTxHash`, `bindTxHash`, `fundTxHash` | Arc explorer links for each step |

### Errors — one consistent shape

Every error looks like:

```jsonc
{ "error": { "code": "validation_error", "message": "invalid request", "details": [...] } }
```

For form validation (HTTP 400, `code: "validation_error"`), `details` is a list of
`{ path, message }` — map each `path` onto the matching form field to show the error inline.

---

## 4. The `guardianPasskey` shape

Reshape the WebAuthn browser result into exactly this before sending it in `/onboard`:

```jsonc
{
  "authenticatorName": "My Guardian Key",   // optional label
  "challenge": "<the challenge from GET /passkey/challenge>",
  "attestation": {
    "credentialId": "...",
    "clientDataJson": "...",
    "attestationObject": "...",
    "transports": ["internal", "hybrid"]
  }
}
```

---

## 5. Things the frontend must get right (checklist)

- [ ] **Wallet login** wired to `/auth/nonce` + `/auth/verify` with a real wallet (`viem`/`wagmi`).
- [ ] **Tell the user** the login wallet becomes the agent's guardian.
- [ ] **Token handling**: attach the Bearer token everywhere; re-login on expiry or `401`.
- [ ] **Passkey ceremony** → correctly shaped `guardianPasskey`.
- [ ] **Form built from `/schema/agent-spec.json`**, with these validation rules surfaced:
  - spending period must be `> 0` and `≤ 365 days`
  - amendment delay must be `≥ 1 hour`
  - USDC amounts: max 6 decimals, non-negative
  - the role addresses must all be different
- [ ] **Async UX**: submit → poll `/entities/:id` → progress stepper off the status enum.
- [ ] **`idempotencyKey`** on submit so a refresh/retry doesn't create a duplicate.
- [ ] **Funding** converts USDC to atomic units (×1,000,000) before sending.
- [ ] **Error envelope** handled uniformly; `validation_error` details mapped to fields.
- [ ] **Backend origin + CORS**: point at the real backend URL and confirm `WEB_ORIGIN` includes
      your dev + prod origins (production refuses `*`).

---

## 6. What's still left to build

> The backend wizard API (everything above) is **done, tested, and merged**. The items below are
> not blockers for connecting the frontend.

**Backend (remaining):**
- **MCP server** — an agent-facing version of the same API (for Claude/Cursor). Not started.
- **ERC-8183 proof-of-life** — the agent autonomously accepting and settling a job on-chain. Not started.
- **Production hardening** — rate limiting, nonce hardening, a funding-status field
  (see `docs/V2_HARDENING_BACKLOG.md`). None block the demo.
- Before any shared/public deploy: set real `AUTH_JWT_SECRET`, `WEB_ORIGIN`, `SIWE_DOMAIN`, and
  rotate the Turnkey key.

**Frontend (integration work — confirm against actual progress):**
- Real SIWE login (not mocked).
- Passkey ceremony → `guardianPasskey`.
- Live `/onboard` + polling instead of mock data.
- Token storage + auto re-auth.
- Funding screen with USDC conversion.
- Entities list/detail with tx-hash links to the Arc explorer.
- Point at the real backend origin; confirm CORS.
</content>
</invoke>
