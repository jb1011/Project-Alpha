# Public Metadata URI — Design Spec (v2, audit-revised)

**Date:** 2026-07-04 · **Revised:** 2026-07-04 after the spec audit
(`back/docs/audit/2026-07-04-public-metadata-uri-spec-audit.md`).
**Feature:** Make an agent's on-chain ERC-8004 `metadataURI` a **publicly resolvable HTTPS URL** instead of a
local `file://` path, so the agent's legal identity is fetchable and verifiable by anyone off our server.

## Problem

At onboarding, the agent's metadata JSON is written to the local doc store and its `file://` URI
(`file:///root/Project-Alpha/.../meta-<key>.json`) is baked **on-chain** via `createEntity(..., metadataURI,
...)` (`onboarding.ts:164` → `:200` → `arcAdapter.broadcastCreateEntity`). A `file://` path only resolves on
our one VPS box, so any third party — another agent, a counterparty, an agent directory, a block explorer —
that reads the agent's on-chain identity (e.g. agentId 842839) and follows the metadata link hits a dead end.
Nothing in the operate loop breaks (read/earn/spend are independent of this), but the "**publicly verifiable
legal body**" promise doesn't hold: the identity exists on-chain, but its details are unfetchable.

## Goal

Every agent registration bakes a public HTTPS `metadataURI` (served by our backend) into the on-chain record,
pointing at the agent's metadata JSON, resolvable by anyone. Dynamic: every onboard produces such a URL.

## Decisions (locked with the user)

- **HTTPS endpoint** served by our backend (not IPFS) — simplest; IPFS is a future decentralization upgrade.
- **Opaque public ID** as the URL identifier — a random per-agent slug, not the entity key or agentId.
- **Forward-only** — new agents get public URLs; the 2 existing demo agents keep `file://` (backfill out of scope).
- **Drop `ein` from the served JSON** (audit S2) — the tax ID stays inside the OA document behind the on-chain
  `oaHash` (legal identity remains verifiable via the OA), but is NOT broadcast on the public, crawlable endpoint.

## Architecture & flow

At the onboarding *translating* step (before `createEntity`), mint a random `publicId` and set
`metadataURI = ${METADATA_BASE_URL}/metadata/${publicId}`. That public URL is baked on-chain by `createEntity`.
A new public, unauthenticated route resolves `publicId → entity` via the DB and serves the agent's metadata JSON.

**Why keyed on a pre-create id:** `createEntity` takes `metadataURI` as INPUT and returns `agentId` as OUTPUT,
so the baked URL cannot contain `agentId`. `publicId` is minted in the translating step (known before create),
like `oaHash`/`metadataURI` already are, and preserved across a translating-resume (audit-confirmed: behaves
exactly like the proven `createTxHash: rec?.createTxHash ?? null` preservation at `onboarding.ts:173`).

**Resolve path:** third party reads on-chain `metadataURI` → `GET https://project-alpha-pi.vercel.app/backend/
metadata/<publicId>` → Vercel `/backend/*` proxy → VPS → `findByPublicId` → returns the metadata JSON.

## Components

### 1. Config — `METADATA_BASE_URL` (`src/config/env.ts`)
- New env var: **`METADATA_BASE_URL: z.string().url()`** (`.url()`, matching sibling URL vars like
  `TURNKEY_BASE_URL`/`ARC_TESTNET_RPC_URL`; NOT a bare `z.string()` — rejects empty/garbage). Dev default
  `http://localhost:8789`; prod = `https://project-alpha-pi.vercel.app/backend`. Exposed as `metadataBaseUrl`.
- **Prod fail-closed guard** (in the existing `NODE_ENV === "production"` block, `env.ts:167-175`): parse the
  URL and refuse to boot if the scheme is not `https:` **or** the hostname is loopback/private
  (`localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`). Parse the URL — do NOT substring-match (audit S4: substring
  misses `0.0.0.0`/IPv6/non-TLS). Rationale: this value is baked **permanently on-chain** at every registration;
  a wrong value brands every agent with a dead link that can't be fixed.
- **Thread `metadataBaseUrl` into BOTH onboard call sites** (audit M4): the API saga in `src/api/main.ts`
  (`runSaga`) **and** the CLI path `src/cli/index.ts:35-44` (`runOnboarding`). `CliContext.cfg` already carries
  the full config, so it's one line each — but missing the CLI site bakes a localhost URL via `create-entity`.

### 2. Schema — `public_id` (`src/persistence/db.ts` + `entityRepository.ts` + `src/types.ts`)
- `entities` CREATE TABLE gains `public_id TEXT`.
- **Additive migration ordering (audit M1):** add `if (!cols.includes("public_id")) db.exec("ALTER TABLE
  entities ADD COLUMN public_id TEXT")` in the additive block, and place `CREATE UNIQUE INDEX IF NOT EXISTS
  idx_entities_public_id ON entities(public_id)` **AFTER that ALTER** (mirror the `payments_ledger.entity_key`
  block at `db.ts:209-216`, NOT the `idx_entities_agent_id` inline placement). Indexing the column before the
  ALTER runs would throw `no such column: public_id` on the existing prod DB → boot crash.
- `EntityRecord` gains `publicId: string | null` (`src/types.ts`); `entityRepository` maps it (row read + upsert
  INSERT column list) and adds `findByPublicId(publicId): EntityRecord | undefined` (mirrors `findByAgentId`,
  `entityRepository.ts:208`).
- **Add `publicId: null` to the 2 other full-literal record sites (audit M2):** `onboarding.ts:88-116` (Step-0
  provisioned row) and `runner.ts:36-59` (initial pending record) — both build a complete `EntityRecord` literal
  and won't compile once the field is required.
- A SQLite UNIQUE index tolerates multiple NULL rows, so the 2 legacy agents (null `public_id`) are fine.

### 3. Onboard — mint id, public URI, drop `ein` (`src/workflow/onboarding.ts` translating step; `src/oa/generator.ts`)
- Mint `publicId = rec?.publicId ?? randomUUID()` (from `node:crypto`) — **once**, preserved across a
  translating-resume (like `createTxHash`), so a resumed saga never rebakes a different URL.
- Set `metadataURI = \`${d.metadataBaseUrl}/metadata/${publicId}\`` (replaces `metaPut.uri`). Persist `publicId`.
- Still `docStore.put(\`meta-${key}.json\`, ...)` — the file is what the route serves; only the stored
  `metadataURI` changes from `file://` to the public URL. `createEntity` (line 200) bakes the public URL
  on-chain unchanged.
- **Drop `ein` from the metadata JSON (audit S2):** remove `ein` from `AgentMetadata.legalBody` and
  `renderMetadata` (`generator.ts:75-89`); the served `legalBody` becomes `{ jurisdiction, formationDate,
  oaHash }`. The EIN remains in the OA document (`renderOperatingAgreement`, hashed into `oaHash`) and in the
  on-chain `createEntity` calldata — verifiability is preserved without publishing it on the crawlable endpoint.

### 4. Public route — `GET /metadata/:publicId` (new `src/api/routes/metadata.ts`, mounted in `app.ts`)
- Mounted **before/outside** the `requireAuth` middleware (public — like `mountSchemaRoutes`/`/healthz`).
  `/metadata` is not covered by any existing auth `app.use` path (audit-confirmed), so this is automatic.
- Validate `:publicId` is a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`); fail →
  uniform 404.
- `const ent = deps.repo.findByPublicId(publicId)`; if none → 404 `{error:{code:"not_found"}}`.
- Read the stored metadata: **`try { body = deps.docStore.get(\`meta-${ent.idempotencyKey}.json\`) } catch
  { throw new ApiError("not_found", 404, "metadata not found") }`** (audit M3: `docStore.get` does
  `readFileSync` and *throws* `ENOENT` on a missing file, which otherwise falls through to a generic 500).
  The filename is built from the **DB record's** key, never raw URL input.
- Return the JSON with `Content-Type: application/json`, `Cache-Control: public, max-age=300`.
- **CORS (audit S3 — replaces the v1 `c.header` approach):** the global `app.use("*", cors({origin: webOrigin}))`
  short-circuits `OPTIONS` *before* the handler, so a handler-set ACAO can't help a preflight. Fix: change the
  global cors `origin` to a **callback** — `origin: (origin, c) => c.req.path.startsWith("/metadata/") ? "*" :
  webOrigin` — so the single middleware answers preflight + GET with `*` for metadata and `webOrigin` elsewhere
  (Hono supports the `origin` callback form; context7-verified). `metadataBaseUrl`/`docStore` are added to
  `ApiDeps` and injected from `main.ts` (the doc store already exists there).

### 5. Doc-store path containment (audit S1 — `src/persistence/documentStore.ts`)
The entity key embeds a caller-supplied `name`/`idempotencyKey` (unrestricted strings, `agentSpec.ts:48`/
`onboard.ts:33`) and flows into `meta-${key}.json` → `FileDocumentStore` does a raw `join(root, id)` with no
containment. Before the new **public** route serves these files, close the traversal **at the sink**: in
`FileDocumentStore.get` and `.put`, compute `const p = resolve(join(this.root, id))` and throw if
`!p.startsWith(resolve(this.root) + sep)` (path escapes the doc root). This protects every doc-store caller
(OA + metadata + job files), regardless of key provenance, so a crafted name can neither write outside the root
nor be read back through the public route.

## Data flow

```
onboard (translating): publicId = rec?.publicId ?? randomUUID()
                       metadataURI = METADATA_BASE_URL + "/metadata/" + publicId
                       persist {publicId, metadataURI}; write meta-<key>.json (containment-checked)
onboard (create):      createEntity(..., metadataURI, ...)  → URL baked on-chain, agentId returned
resolve (anyone):      GET /backend/metadata/<publicId>
                       → findByPublicId → docStore.get(meta-<key>.json) → 200 application/json
```

## Security & error handling
- **No secrets, and `ein` dropped** — served JSON is name/description/agent_type/capabilities/version/
  legalBody{jurisdiction, formationDate, oaHash}. No keys; the operator address is excluded even from the OA.
- **Path traversal closed at the doc store** (§5) — containment check on `get`/`put`; user input can neither
  escape the doc root on write nor be read back via the public route.
- **No existence oracle** — malformed and unknown ids both return a plain 404.
- **CORS** — callback origin returns `*` for `/metadata/*` incl. preflight; other routes keep `webOrigin`.
- **Prod guard** — `.url()` + https + non-loopback (parsed), because the URL is on-chain-permanent.
- **DoS note (audit S5, roadmap):** this is the first fully-public route doing synchronous SQLite +
  `readFileSync`; a flood could stall the event loop. `Cache-Control: max-age=300` only helps behind a CDN.
  Acceptable for v1 (small payloads, UUID-gated); track an edge-cache/rate-limit follow-up.

## Testing (vitest, `back/backend/test/`)
- **Onboard**: with `metadataBaseUrl` set, an onboarded record's `metadataURI` equals
  `${base}/metadata/${publicId}` (a UUID), NOT `file://`, and `publicId` is persisted; a translating-resume
  keeps the same `publicId`; the served/rendered metadata JSON has **no `ein`** field.
- **On-chain arg**: a mock `arcAdapter` capturing `broadcastCreateEntity` sees the public URL as `metadataURI`.
- **Route**: `GET /metadata/:id` returns the JSON with NO Authorization header (public), `content-type:
  application/json`; unknown UUID → 404; malformed id → 404; a record whose file is missing → 404 (not 500);
  a cross-origin `OPTIONS` preflight to `/metadata/:id` returns `Access-Control-Allow-Origin: *`.
- **Doc store**: `get`/`put` with an `id` containing `../` throws (containment), and a normal id still works.
- **Repo**: `findByPublicId` returns the record and `undefined` for a miss.
- **Config**: prod + non-https or loopback `METADATA_BASE_URL` fails to build; a real https value builds.
- **Migration**: `migrate()` runs clean on a DB that predates `public_id` (ALTER-then-index order).

## Deploy
- VPS: additive migration auto-applies on boot; set `METADATA_BASE_URL=https://project-alpha-pi.vercel.app/
  backend` in `.env`; restart. Reachable immediately through the `/backend/*` proxy (a plain GET, no auth).
- Verify: `curl -s https://project-alpha-pi.vercel.app/backend/metadata/<uuid>` (once a new agent exists) → 200
  JSON with no `ein`; a bogus uuid → 404.

## Out of scope (tracked)
- **Backfill existing agents** (842839, TestMB2) — needs `arcAdapter.setMetadata` + an on-chain tx + a contract
  check on whether the register-time URI is updatable.
- **IPFS** metadata; **enriching** the JSON with on-chain addresses (impossible pre-create; resolver has agentId);
  **regeneration fallback** if the file is lost (v1 serves the stored file); **edge-cache/rate-limit** for the
  public route (audit S5).

## Changelog
- **v2 (2026-07-04):** applied the spec audit. Dropped `ein` from the served JSON (S2); closed the doc-store
  path traversal at the sink (S1); fixed CORS for preflight via an `origin` callback (S3); stricter prod guard
  via `.url()` + parsed loopback/https check (S4); migration index-after-ALTER (M1); `publicId: null` at the 2
  extra record literals (M2); route try/catch → 404 on missing file (M3); thread the base URL into the CLI
  onboard path (M4); added a DoS/edge-cache roadmap note (S5).
