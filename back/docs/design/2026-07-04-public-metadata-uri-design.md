# Public Metadata URI — Design Spec

**Date:** 2026-07-04
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

- **HTTPS endpoint** served by our backend (not IPFS) — simplest; IPFS is a future upgrade for
  decentralization/permanence (HTTPS depends on our server staying up).
- **Opaque public ID** as the URL identifier — a random per-agent slug, not the entity key or agentId.
- **Forward-only** — all NEW agents get public URLs; the 2 existing demo agents (842839 TestAgentMB_1, TestMB2)
  keep their `file://` on-chain (they're throwaway test agents). Backfill is out of scope.

## Architecture & flow

At the onboarding *translating* step (before `createEntity`), mint a random `publicId` and set
`metadataURI = ${METADATA_BASE_URL}/metadata/${publicId}`. That public URL is baked on-chain by `createEntity`.
A new public, unauthenticated route resolves `publicId → entity` via the DB and serves the agent's metadata
JSON.

**Why keyed on a pre-create id:** `createEntity` takes `metadataURI` as an INPUT and returns `agentId` as an
OUTPUT, so the baked URL cannot contain `agentId`. `publicId` is minted in the translating step (known before
create), like `oaHash`/`metadataURI` already are.

**Resolve path:** third party reads on-chain `metadataURI` → `GET https://project-alpha-pi.vercel.app/backend/
metadata/<publicId>` → Vercel `/backend/*` proxy → VPS → `findByPublicId` → returns the metadata JSON.

## Components

### 1. Config — `METADATA_BASE_URL` (`src/config/env.ts`)
- New env var: `METADATA_BASE_URL: z.string().default("http://localhost:8789")`. Prod =
  `https://project-alpha-pi.vercel.app/backend`. Exposed on the config object as `metadataBaseUrl` and threaded
  to onboarding + the route.
- **Prod fail-closed guard:** in production, refuse to boot if `METADATA_BASE_URL` contains `localhost` or
  `127.0.0.1` (mirrors the existing prod guards for `AUTH_JWT_SECRET`/`WEB_ORIGIN`). Rationale: this value is
  baked **permanently on-chain** at every registration — a wrong value brands every agent with a dead link that
  can't be fixed later (stricter than `MCP_PUBLIC_URL`, which only affects re-issuable snippets).

### 2. Schema — `public_id` (`src/persistence/db.ts` + `entityRepository.ts` + `src/types.ts`)
- Add `public_id TEXT` to the `entities` CREATE TABLE + an additive `ALTER TABLE entities ADD COLUMN public_id
  TEXT` guarded by a `PRAGMA table_info` check (matching the existing sibling migration blocks).
- Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_public_id ON entities(public_id)` (partial/whereable not
  needed; `public_id` is null for the 2 legacy agents — a unique index tolerates multiple NULLs in SQLite).
- `EntityRecord` gains `publicId: string | null`; `entityRepository` maps it (read + upsert) and adds
  `findByPublicId(publicId: string): EntityRecord | undefined` (mirrors `findByAgentId`, `entityRepository.ts:
  208`).

### 3. Onboard — mint id + public URI (`src/workflow/onboarding.ts`, translating step ~149-184)
- Mint `publicId = rec?.publicId ?? randomUUID()` (from `node:crypto`) — computed **once** and preserved across
  a translating-resume, exactly like `createTxHash` (`onboarding.ts:173`), so a resumed saga keeps the same id
  and never rebakes a different URL.
- Set `metadataURI = \`${d.metadataBaseUrl}/metadata/${publicId}\`` (replaces `metaPut.uri`).
- Still `docStore.put(\`meta-${key}.json\`, ...)` — the file is what the route serves; only the stored
  `metadataURI` changes from `file://` to the public URL.
- Persist `publicId` on the record. `createEntity` (line 200) then bakes the public URL on-chain unchanged.
- Thread `metadataBaseUrl` into the onboarding saga deps (wherever `docStore`/config is passed).

### 4. Public route — `GET /metadata/:publicId` (new `src/api/routes/metadata.ts`, mounted in `app.ts`)
- Mounted **before/outside** the `requireAuth` middleware (public — like `mountSchemaRoutes`/`/healthz`).
- Validate `:publicId` matches a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`);
  fail → uniform 404.
- `const ent = deps.repo.findByPublicId(publicId)`; if none → 404 `{error:{code:"not_found"}}`.
- Read the stored metadata: `deps.docStore.get(\`meta-${ent.idempotencyKey}.json\`)` — the filename is built
  from the **DB record's** key (canonical), never from raw URL input, so there is no path-traversal surface.
  Return it verbatim with headers: `Content-Type: application/json`, `Cache-Control: public, max-age=300`,
  `Access-Control-Allow-Origin: *` (public data, any origin/tool may fetch). Missing file → 404.
  - **CORS note:** the app's global `cors({ origin: webOrigin })` is origin-restricted in prod, which would
    block cross-origin browser fetches of this public resource. The metadata route must set
    `Access-Control-Allow-Origin: *` on its own response *after* the global middleware (a `c.header(...)`
    override in the handler is sufficient in Hono; server-to-server resolvers ignore CORS entirely, so this
    only matters for browser-based consumers).
- Wire `docStore` into `ApiDeps` (currently the doc store is only used inside the onboarding runner — the route
  needs read access; inject the same `FileDocumentStore` instance from `main.ts`).

## Data flow

```
onboard (translating): publicId = randomUUID()
                       metadataURI = METADATA_BASE_URL + "/metadata/" + publicId
                       persist {publicId, metadataURI}; write meta-<key>.json
onboard (create):      createEntity(..., metadataURI, ...)  → URL baked on-chain, agentId returned
resolve (anyone):      GET /backend/metadata/<publicId>
                       → findByPublicId → docStore.get(meta-<key>.json) → 200 application/json
```

## Security & error handling
- **No secrets in the JSON** — verified: `renderMetadata` emits only name/description/agent_type/capabilities/
  version/legalBody{jurisdiction,ein,formationDate,oaHash}. The operator address is deliberately excluded even
  from the OA. Nothing sensitive is exposed.
- **No path traversal** — `publicId` (user input) only ever reaches a DB lookup; the served filename derives
  from the DB record's `idempotencyKey`, not the URL.
- **No existence oracle** — malformed and unknown ids both return a plain 404.
- **Read-only + unauthenticated by design** — that's the point (public verifiability); the route exposes no
  mutation and no per-tenant data beyond the already-public profile.
- **Prod guard** — the on-chain-permanence of the URL makes a bad base URL unrecoverable, hence fail-closed.

## Testing (vitest, `back/backend/test/`)
- **Onboard**: with `metadataBaseUrl` set, an onboarded record's `metadataURI` equals
  `${base}/metadata/${publicId}` (a UUID), **not** a `file://` URI, and `publicId` is persisted; a
  translating-resume keeps the same `publicId`.
- **On-chain arg**: a mock/fake `arcAdapter` capturing `broadcastCreateEntity` sees the public URL as
  `metadataURI`.
- **Route**: `GET /metadata/:id` returns the metadata JSON **without** an Authorization header (proves it's
  public), with `content-type: application/json`; returns 404 for an unknown UUID and for a malformed id; the
  served body parses as JSON and contains the agent's `name`/`legalBody`.
- **Repo**: `findByPublicId` returns the right record and `undefined` for a miss.
- **Config**: prod + `METADATA_BASE_URL=http://localhost:...` fails to build; a real https value builds.

## Deploy
- VPS: additive migration auto-applies on boot (public_id column); set `METADATA_BASE_URL=https://
  project-alpha-pi.vercel.app/backend` in `.env`; restart. The route is reachable immediately through the
  existing `/backend/*` proxy (a plain GET, no auth).
- Verify: `curl -s https://project-alpha-pi.vercel.app/backend/metadata/<uuid>` (once a new agent exists) → 200
  JSON; a bogus uuid → 404.

## Out of scope (tracked)
- **Backfill existing agents** (842839, TestMB2) — needs an `arcAdapter.setMetadata` method + an on-chain tx +
  first verifying the registry lets the register-time URI be updated (a contract check). Forward-only for now.
- **IPFS** metadata (HTTPS chosen; IPFS is the future decentralization upgrade).
- **Enriching the JSON** with on-chain addresses (agentId/treasury/proxy) — impossible pre-create anyway, and a
  resolver already holds the agentId; serve the profile as-is.
- **Regeneration fallback** if the metadata file is lost — v1 serves the stored file (doc store is backed up);
  regenerating from the record is a later robustness upgrade.
