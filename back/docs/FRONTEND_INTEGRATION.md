# Frontend and backend integration guide

How the web app (`interface/`) talks to the backend for the full product's onboarding: sign in,
prove you are a person, create a guardian passkey, onboard, poll, fund. First written 2026-06-22,
refreshed 2026-10-21. The bring-your-own legal body flow at `/legal-body` has its own client
(`interface/src/lib/legalBody/`) and is not covered here.

---

## 1. The big picture (read this first)

The backend turns a form submission into an on-chain legal body for an AI agent: it generates the
legal documents, registers an identity on Arc, deploys the contracts and binds the agent's
wallet. That takes time, so **nothing happens instantly**: the frontend submits a request, then
polls for progress until it is done.

Three things to keep in mind:

1. **You log in with a wallet, not a password.** The person who logs in becomes the agent's
   *guardian* (the human who can pause or rescue it on chain). Same wallet, same guardian.
2. **Onboarding is async.** You POST the form, get back an `id`, then poll that `id` until the
   status reaches a finished state.
3. **The form fields come from the backend**, not hard-coded. Fetch the schema and build the form
   from it, so the form stays in step when the backend changes.

**Where it runs:** the backend is a plain HTTP server (`npm run api`, then
`http://localhost:8789`); the hosted one is `https://api.novicorpus.com`. The web app reaches it
through its own proxy route, `interface/src/app/backend/[[...path]]/route.ts`, at `/backend/...`;
the deployment's capabilities come from `GET /config`.

---

## 2. The happy path, step by step

```
1. Connect wallet
2. Log in (SIWE)          -> get a token
3. Prove you are a person -> World ID (the guardian gate)
4. Create a passkey       -> get a guardianPasskey object
5. (where formation is on) create the company
6. Fetch the form schema
7. Submit onboarding      -> get an { id }
8. Poll the id            -> watch the status climb to "bound"
9. (optional) Fund it     -> poll again until "funded"
```

### Steps 1-2: log in with the wallet (SIWE)

"SIWE" is Sign-In with Ethereum: instead of an email and a password, the user signs a message with
their wallet to prove who they are.

1. `GET /auth/nonce` returns `{ nonce }` (a one-time random string).
2. Build a standard sign-in message containing that nonce and ask the wallet to sign it (`viem`'s
   `createSiweMessage`).
3. `POST /auth/verify` with `{ message, signature }` returns `{ token, address, expiresAt }`.
4. Keep the `token` and send it as `Authorization: Bearer <token>` on every protected call. When
   `expiresAt` passes (or a call answers `401`), log in again.

> The wallet they log in with **becomes the guardian** of every agent they create. Say so in the
> UI: it is a lasting role, not a throwaway login.

### Step 3: prove you are a person (World ID)

A legal body needs a natural person in control, so onboarding checks the guardian with World ID where
`WORLD_REQUIRE_GUARDIAN` is on (Orb grade or a government-document credential; device and selfie tiers are refused). The routes
are under `/world-id/` (`GET /world-id/context`, `POST /world-id/request`, `POST /world-id/verify`,
`GET /world-id/status/:requestId`, `GET /world-id/me`); the interface's `GuardianStep` runs the
sequence, so copy it rather than rebuilding it. `GET /world-id/me` tells you where the guardian
stands. Where World ID has no path, an operator can issue a waiver, which is published as
unverified.

### Step 4: create the guardian passkey

The guardian creates a passkey (Face ID, fingerprint or a security key) in the browser: a standard
WebAuthn registration.

1. `GET /passkey/challenge` (Bearer token required) returns `{ challenge, rpId }`.
2. Run `navigator.credentials.create()` in the browser with that challenge.
3. Reshape the browser's result into the `guardianPasskey` object (see [§4](#4-the-guardianpasskey-shape)).
   You attach it to the onboarding request in step 7.

> A working example of this ceremony is in `backend/tools/passkey-capture/`.

### Step 5: the company (where formation is on)

Where `/config` says formation is available, an agent is attached to a company. Create the
responsible party (`POST /formation-party`) and the company (`POST /companies`); where the
deployment charges, settle the company's payment (`GET /companies/:companyId/payment`, then
`POST .../payment/settle`). Keep the `companyId` for step 7.

### Step 6: build the form from the schema

`GET /schema/agent-spec.json` returns a JSON Schema describing every field of the onboarding form
(agent name, treasury spending cap, payout address, and so on). Generate the form from it.

### Step 7: submit onboarding

`POST /onboard` (Bearer token) with:

```jsonc
{
  "spec": { /* the filled-in form, matching agent-spec.json */ },
  "guardianPasskey": { /* the object from step 4 */ },
  "custody": "circle",            // optional: "circle" or "turnkey"; omitted = the deployment's default
  "companyId": "<from step 5>",   // required where formation is on
  "idempotencyKey": "a-stable-id-for-this-submission"  // optional but recommended
}
```

Returns `202 { id, status }` **at once**; the `id` is your handle for polling. You don't set the
guardian: the backend sets it to the logged-in wallet.

### Step 8: poll until done

`GET /entities/:id` every 2 to 3 seconds. The `status` climbs through:

```
pending -> provisioned -> translating -> created -> bound -> funded
                                                      (or "failed": read .error)
```

Drive a progress stepper from it. Stop polling at `bound` (or `funded`, or `failed`).

### Step 9 (optional): fund the treasury

`POST /entities/:id/fund` with `{ amount }` in **atomic USDC** (6 decimals): `25.00 USDC` is
`25000000`. Returns `202`; poll again until `funded`.

---

## 3. Endpoint reference

Base URL: `http://localhost:8789` locally (set with `PORT`). "Auth: yes" means the Bearer token.

| Method | Path | Auth | What it is for |
|---|---|---|---|
| GET | `/healthz` | no | Is the server up? `{ ok: true }` |
| GET | `/config` | no | What this deployment offers (formation, legal bodies, payment, chain) |
| GET | `/schema/agent-spec.json` | no | The form schema |
| GET | `/auth/nonce` | no | Start login: `{ nonce }` |
| POST | `/auth/verify` | no | Finish login: `{ token, address, expiresAt }` |
| GET, POST | `/world-id/...` | yes | The guardian's World ID check (step 3) |
| GET | `/passkey/challenge` | yes | Start passkey creation: `{ challenge, rpId }` |
| POST | `/formation-party`, `/companies` | yes | The responsible party and the company (step 5) |
| POST | `/onboard` | yes | Create an agent: `202 { id, status }` |
| GET | `/entities` | yes | This user's agents: `EntityView[]` |
| GET | `/entities/:id` | yes | One agent's status and detail (poll this): `EntityView` |
| POST | `/entities/:id/fund` | yes | Add USDC to the treasury: `202 { id, status }` |

Other groups the app uses, each in `back/backend/src/api/routes/`: `/companies/...` (documents,
compliance, payment), `/legal-body-orders/...` and `/companies/customer` (the bring-your-own
flow), `/api-keys`, `/connection-package` and `/bootstrap-connection` (connecting an agent),
`/jobs`, and the public reads `/legal-bodies/...`, `/transparency` and `/metadata/...`.

### What `EntityView` contains

| Field | Meaning |
|---|---|
| `id` | Your handle (the idempotency key) |
| `name` | Agent name |
| `status` | Where it is in the lifecycle (step 8) |
| `error` | Set only when `status === "failed"` |
| `agentId` | On-chain ERC-8004 agent id (null until `created`) |
| `proxy`, `treasury`, `operator` | On-chain contract and wallet addresses (null until `created`) |
| `manager`, `guardian` | The platform's manager and the guardian wallet |
| `oaHash`, `metadataURI` | Operating-agreement hash and metadata pointer |
| `createTxHash`, `bindTxHash`, `fundTxHash` | One transaction per step, for explorer links |
| `walletProvider`, `rootPasskeyId` | The operating wallet's custody (`circle` or `turnkey`) and its passkey |
| `formation`, `oaAnchor` | Company formation progress, and the operating agreement's anchoring |
| `perTxCap`, `trustPolicy` | The agent's per-transaction cap and trust policy |

### Errors

Authenticated routes answer errors in one shape:

```jsonc
{ "error": { "code": "validation_error", "message": "invalid request", "details": [...] } }
```

For form validation (HTTP 400, `code: "validation_error"`), `details` is a list of
`{ path, message }`: map each `path` onto its form field. The public legal-body lookup
(`/legal-bodies/:address`) uses a flat
`{ "error": "rate_limited" | "unavailable" | "validation_error", "message": ... }` instead;
`/metadata/...` answers in the nested shape.

---

## 4. The `guardianPasskey` shape

Reshape the WebAuthn browser result into exactly this before sending it to `/onboard`:

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
- [ ] **Token handling**: send the Bearer token everywhere; log in again on expiry or `401`.
- [ ] **World ID** before onboarding; show a waiver as unverified, never as verified.
- [ ] **Passkey ceremony** (after login) producing a correctly shaped `guardianPasskey`.
- [ ] **Company first** where formation is on, then `companyId` in `/onboard`.
- [ ] **Form built from `/schema/agent-spec.json`**, with these rules surfaced:
  - the spending period must be `> 0` and `<= 365 days`
  - the amendment delay must be `>= 1 hour`
  - USDC amounts: at most 6 decimals, not negative
  - the role addresses must all differ
- [ ] **Async UX**: submit, poll `/entities/:id`, drive the stepper from the status.
- [ ] **`idempotencyKey`** on submit, so a refresh or retry doesn't create a duplicate.
- [ ] **Funding** converts USDC to atomic units (x 1,000,000) before sending.
- [ ] **Errors** handled in both shapes; `validation_error` details mapped to fields.
- [ ] **Backend origin and CORS**: confirm `WEB_ORIGIN` includes your origins (production refuses
      `*`).

---

## 6. What changed since the first version (2026-06-22)

- The MCP server and the ERC-8183 jobs shipped; agents use them directly (see
  [BYOA_INTEGRATION.md](./BYOA_INTEGRATION.md)).
- Onboarding requires a World ID verified guardian where `WORLD_REQUIRE_GUARDIAN` is on, and the
  passkey challenge requires login.
- Company formation runs through doola (sandbox), and an agent is attached to a company.
- The agent's operating wallet can be a Circle developer-controlled smart account or a Turnkey
  vault (`custody`).
- A legal body on an identity the customer already owns has its own flow at `/legal-body`.
