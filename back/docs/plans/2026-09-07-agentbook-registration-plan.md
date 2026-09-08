# AgentBook Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guardian with an Orb-grade World ID can press "Vouch for this agent in AgentBook" on an agent's dashboard, approve in World App, and have Novi Corpus write the registration to World's AgentBook contract on World Chain, with honest states, caps, and reconciliation.

**Architecture:** Backend: a viem-based registrar for the AgentBook contract, a SQLite table with compare-and-swap moves, three routes under `/entities/:id/agentbook`, and a reconciler. Interface: a vouch dialog that drives World's v2 bridge (pinned `idkit-core@2.1.0` under an npm alias), recomputes the signal locally, and renders QR + deeplink. The AgentKit signer moves to `eip155:480` so a registered agent passes third-party sellers.

**Tech Stack:** TypeScript, Hono, better-sqlite3, viem 2.53 (`worldchain` chain), zod, vitest, biome (backend); Next.js 16, React 19, React Query 5, `qrcode`, `idkit-core-v2` alias (interface).

**Spec:** `back/docs/design/2026-08-25-agentbook-registration-design.md` (v3) and its audit `back/docs/design/2026-09-07-agentbook-registration-audit.md`. Read §2 (decisions), §3 (flow), §4 (backend), §5 (copy), §6 (reconciliation rules), §9 (scope) before starting.

## Global Constraints

- Contract: World Chain (chain id 480), AgentBook `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`. World's app id `app_a7c3e2b6b83927251a0db5345bd7146a`, action `agentbook-registration`. Signal = `abi.encodePacked(address, uint256)` (52 bytes), never the padded 64-byte form.
- Register the **pocket address** (`rec.pocketAddress`, a stored fact). Never derive it at read time. Null → reason `no-pocket-yet`.
- Orb only: stored credential must be `orb` or `proof_of_human`. Every other tier gets the §5.3 message.
- Caps (D13): per-entity lifetime 3 rows in `submitted|confirmed|disputed`; per-tenant 5 session creations per rolling hour; process-wide token bucket on World Chain calls from these routes, consumed **before** any RPC read.
- Never log or return `String(e)` / `e.message` for simulate or submit errors. Ops log fields: `{ entity, tenantPrefix, errorName ?? code }`.
- Claims ceiling (D9): chip labels are "Vouched in AgentBook ↗", "Not in AgentBook", "Could not check", "Disputed in AgentBook". Never "human-backed", never green.
- Copy in §5.1 and §5.3 of the design is verbatim.
- Submitter key: `WORLDCHAIN_SUBMITTER_PRIVATE_KEY`, no fallback, refuses boot if equal to any other configured key, redacted, holds World Chain ETH only.
- All World Chain writes under `withKeyedLock("worldchain-submitter")`. Reconciliation reads at `blockTag: "safe"`.
- Backend: `npm run lint` (biome, line width 100), `npm run typecheck`, `npm test` (vitest). Interface: `npm run lint`, `npx tsc --noEmit`, `npm test`.
- Branch `hackathon/ethonline-2026`; small commits; never merge (audit, mark ready, Martin merges). Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Working directories: backend commands run in `back/backend`, interface commands in `interface`.

---

## File structure

**Backend (`back/backend`)**
- Modify `src/config/env.ts`: `WORLDCHAIN_SUBMITTER_PRIVATE_KEY`, `WORLDCHAIN_SUBMITTER_RPC`, `Config.agentBook`, `canRegisterAgentBook`, invariants, `redact`.
- Modify `.env.example`: the two variables.
- Modify `src/payments/agentBookReader.ts`: export `AGENT_BOOK_CHAIN_ID`, `AGENT_BOOK_ABI` (adds `getNextNonce`, `register`, event), keep `createAgentBookReader`.
- Create `src/adapters/worldid/agentBookRegistrar.ts`: `buildSignal`, `hashSignal`, `createAgentBookRegistrar`.
- Modify `src/persistence/db.ts`: table + indexes in `migrate`.
- Create `src/persistence/agentBookRepository.ts`: `AgentBookRepository`, `SqliteAgentBookRepository`.
- Create `src/workflow/agentBookReconcile.ts`: `reconcileRow`, `reconcileAgentBook`.
- Create `src/api/routes/agentBook.ts`: `AgentBookDeps`, `mountAgentBookRoutes`, `TokenBucket`.
- Modify `src/api/routes/worldId.ts`: delete the old GET (lines 415-455).
- Modify `src/api/app.ts`: `ApiDeps.agentBook`, `/config.agentBookRegistrationAvailable`, mount.
- Modify `src/api/main.ts`: build deps when `canRegisterAgentBook(cfg)`, boot reconcile.
- Modify `src/payments/entityPayment.ts`, `src/payments/worldVerifier.ts`, `src/api/routes/x402Demo.ts`: signer chain 480, seller advertises both.
- Tests: `test/config/agentBookConfig.test.ts`, `test/world/agentBookRegistrar.test.ts`, `test/persistence/agentBookRepository.test.ts`, `test/workflow/agentBookReconcile.test.ts`, `test/api/agentBookRoute.test.ts` (rewritten), `test/api/agentBookRegistration.test.ts`, `test/payments/agentkitChains.test.ts`.

**Interface (`interface`)**
- Modify `package.json`: `"idkit-core-v2": "npm:@worldcoin/idkit-core@2.1.0"`.
- Modify `src/lib/api/types.ts`, `client.ts`, `hooks.ts`, `keys.ts`: session/register calls, status union, `PublicConfig.agentBookRegistrationAvailable`.
- Create `src/lib/agentbook/signal.ts`, `src/lib/agentbook/pin.ts`, `src/lib/agentbook/proof.ts`.
- Create `src/components/agents/VouchDialog.tsx`.
- Modify `src/components/agents/AgentDashboard.tsx` (chip + button), `src/app/personhood/page.tsx` (copy), `src/components/agents/TenantRecord.tsx` (waiver branch), `next.config.ts` (frame-ancestors).
- Tests: `src/lib/agentbook/signal.test.ts`, `pin.test.ts`, `proof.test.ts`.

**Docs**
- Create `back/docs/runbooks/agentbook-registration.md`.

---

### Task 0: Branch and the two design documents

**Files:**
- Commit: `back/docs/design/2026-08-25-agentbook-registration-design.md`, `back/docs/design/2026-09-07-agentbook-registration-audit.md`, this plan.

- [ ] **Step 1: Create the branch from main**

```bash
cd /home/mbarr/Project-Alpha && git fetch origin && git checkout -b hackathon/ethonline-2026 origin/main
```

- [ ] **Step 2: Commit the documents as documented pre-existing work**

```bash
git add back/docs/design/2026-08-25-agentbook-registration-design.md back/docs/design/2026-09-07-agentbook-registration-audit.md back/docs/plans/2026-09-07-agentbook-registration-plan.md
git commit -m "docs(agentbook): registration design v3, second audit, implementation plan

Design written 2026-08-25 (v2), audited and folded to v3 on 2026-09-07. ETHOnline 2026 work starts here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin hackathon/ethonline-2026
```

---

### Task 1: Config: submitter key, write RPC, predicate, invariants, redaction

**Files:**
- Modify: `back/backend/src/config/env.ts` (schema near line 180, `Config` interface near 269, build near 580, invariants near 613, `redact` near 815)
- Modify: `back/backend/.env.example` (World section near line 154)
- Test: `back/backend/test/config/agentBookConfig.test.ts`

**Interfaces:**
- Produces: `Config.agentBook?: { submitterPrivateKey: Hex; rpcUrl: string }`; `export function canRegisterAgentBook(cfg: Pick<Config, "agentBook" | "world">): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// back/backend/test/config/agentBookConfig.test.ts
import { expect, test } from "vitest";
import { canRegisterAgentBook, loadConfig, redact } from "../../src/config/env";

const KEY = `0x${"b".repeat(64)}`;
const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};
const WORLD = {
  WORLD_APP_ID: "app_staging_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
};

test("absent key: no agentBook block, registration unavailable", () => {
  const cfg = loadConfig(BASE);
  expect(cfg.agentBook).toBeUndefined();
  expect(canRegisterAgentBook(cfg)).toBe(false);
});

test("key without World portal config: block present, registration still unavailable", () => {
  const cfg = loadConfig({ ...BASE, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  expect(cfg.agentBook?.submitterPrivateKey).toBe(KEY);
  expect(canRegisterAgentBook(cfg)).toBe(false);
});

test("key plus World config: available; write RPC defaults to the read RPC", () => {
  const cfg = loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  expect(canRegisterAgentBook(cfg)).toBe(true);
  expect(cfg.agentBook?.rpcUrl).toBe(cfg.worldChain.rpcUrl);
});

test("a dedicated write RPC is honoured", () => {
  const cfg = loadConfig({
    ...BASE,
    ...WORLD,
    WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY,
    WORLDCHAIN_SUBMITTER_RPC: "https://paid.example/v2/key",
  });
  expect(cfg.agentBook?.rpcUrl).toBe("https://paid.example/v2/key");
});

test("the submitter key may never equal the platform key", () => {
  expect(() =>
    loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: BASE.PLATFORM_PRIVATE_KEY }),
  ).toThrow(/WORLDCHAIN_SUBMITTER_PRIVATE_KEY/);
});

test("redact hides the key and keeps the RPC", () => {
  const cfg = loadConfig({ ...BASE, ...WORLD, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: KEY });
  const out = JSON.stringify(redact(cfg));
  expect(out).not.toContain(KEY);
  expect(out).toContain('"rpcUrl"');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd back/backend && npx vitest run test/config/agentBookConfig.test.ts`
Expected: FAIL, `canRegisterAgentBook` is not exported.

- [ ] **Step 3: Implement**

In `EnvSchema` (after `WORLD_ENVIRONMENT`, line ~183):

```ts
  /** AgentBook registration (design 2026-08-25 v3 §4.2). The submitter holds World Chain ETH only.
   *  No fallback to any other key: the equality invariant below refuses boot. */
  WORLDCHAIN_SUBMITTER_PRIVATE_KEY: privKeySchema.optional(),
  /** Write endpoint for registrations; defaults to WORLD_CHAIN_RPC. Lets ops pin a paid key for
   *  writes without exposing it to the read path. */
  WORLDCHAIN_SUBMITTER_RPC: z.string().url().optional(),
```

In `export interface Config` (line ~269), next to `worldChain`:

```ts
  /** Present iff WORLDCHAIN_SUBMITTER_PRIVATE_KEY is set. Registration also needs `world`. */
  agentBook?: { submitterPrivateKey: Hex; rpcUrl: string };
```

In the config build (after the `worldChain: {...}` block, line ~585):

```ts
    agentBook: e.WORLDCHAIN_SUBMITTER_PRIVATE_KEY
      ? {
          submitterPrivateKey: e.WORLDCHAIN_SUBMITTER_PRIVATE_KEY,
          rpcUrl: e.WORLDCHAIN_SUBMITTER_RPC ?? e.WORLD_CHAIN_RPC,
        }
      : undefined,
```

Predicate, next to `canFormEntities` (line ~451):

```ts
/** The one definition of "this deployment can write AgentBook registrations": a submitter key AND
 *  the World portal block (the Orb gate reads `WorldStore`). Twin of `canFormEntities`: the boot
 *  gate, `GET /config` and the route mount all read this, so they cannot drift. */
export function canRegisterAgentBook(cfg: Pick<Config, "agentBook" | "world">): boolean {
  return Boolean(cfg.agentBook && cfg.world);
}
```

Invariants, inside `loadConfig` after the config object is built and before the production block (line ~613). The first runs in every environment, the second only in production:

```ts
  if (cfg.agentBook) {
    const others: Array<[string, string | undefined]> = [
      ["PLATFORM_PRIVATE_KEY", cfg.platformPrivateKey],
      ["CUSTOMER_PRIVATE_KEY", cfg.customerPrivateKey],
      ["OPERATOR_PRIVATE_KEY", cfg.operatorPrivateKey],
      ["JOB_CLIENT_PRIVATE_KEY", cfg.jobClientPrivateKey],
      ["JOB_EVALUATOR_PRIVATE_KEY", cfg.jobEvaluatorPrivateKey],
      ["X402_PROOF_AGENT_KEY", cfg.x402ProofAgentKey],
    ];
    const sub = cfg.agentBook.submitterPrivateKey.toLowerCase();
    for (const [name, value] of others) {
      if (value && value.toLowerCase() === sub)
        throw new Error(
          `Invalid config: WORLDCHAIN_SUBMITTER_PRIVATE_KEY must not equal ${name} — the submitter holds World Chain gas only`,
        );
    }
    if (isProduction && !cfg.world)
      throw new Error(
        "Invalid config: WORLDCHAIN_SUBMITTER_PRIVATE_KEY is set but the WORLD_* portal block is absent — a half-configured AgentBook feature is refused in production",
      );
  }
```

`isProduction` is whatever the existing production block already tests (read line ~618 and reuse the same expression). Confirm each `cfg.<key>` property name against the `Config` interface; the six names above are the ones `redact()` already lists.

`redact()` (line ~815), after `x402ProofAgentKey`:

```ts
    agentBook: cfg.agentBook
      ? { submitterPrivateKey: "REDACTED", rpcUrl: cfg.agentBook.rpcUrl }
      : undefined,
```

`.env.example`, after `# WORLD_ENVIRONMENT=production`:

```
# AgentBook registration (design 2026-08-25 v3 §4.2). A dedicated key holding World Chain ETH
# only; never reuse another key, never fund this address on any other chain. Absent = the
# "Vouch for this agent" action is unavailable and GET /config says so.
# WORLDCHAIN_SUBMITTER_PRIVATE_KEY=0x...
# WORLDCHAIN_SUBMITTER_RPC=https://worldchain-mainnet.g.alchemy.com/v2/<key>   (defaults to WORLD_CHAIN_RPC)
```

- [ ] **Step 4: Run the test, lint and typecheck**

Run: `cd back/backend && npx vitest run test/config && npm run lint && npm run typecheck`
Expected: PASS, no lint or type errors. The existing `test/config/*.test.ts` files must still pass.

- [ ] **Step 5: Commit**

```bash
git add back/backend/src/config/env.ts back/backend/.env.example back/backend/test/config/agentBookConfig.test.ts
git commit -m "feat(agentbook): submitter key, write RPC, canRegisterAgentBook predicate (design v3 §4.2-4.3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Persistence: `agentbook_registrations` table and repository

**Files:**
- Modify: `back/backend/src/persistence/db.ts` (inside `migrate`, after the `world_human_cache` table near line 467)
- Create: `back/backend/src/persistence/agentBookRepository.ts`
- Test: `back/backend/test/persistence/agentBookRepository.test.ts`

**Interfaces:**
- Produces:

```ts
export type AgentBookStatus = "pending" | "submitted" | "confirmed" | "disputed" | "failed" | "expired";
export interface AgentBookRow {
  id: number; sessionId: string; entityKey: string; tenantId: string; address: string; nonce: string;
  status: AgentBookStatus; nullifier: string | null; rawTx: string | null; submitterNonce: number | null;
  txHash: string | null; confirmedBlock: number | null; attempt: number; errorCode: string | null;
  expiresAt: number; createdAt: string; updatedAt: string;
}
export interface AgentBookRepository {
  createSession(p: { sessionId; entityKey; tenantId; address; nonce; expiresAt }): AgentBookRow;
  findBySession(sessionId: string): AgentBookRow | undefined;
  latestForEntity(entityKey: string): AgentBookRow | undefined;
  countLifetime(entityKey: string): number;                 // submitted|confirmed|disputed
  countSessionsSince(tenantId: string, sinceMs: number): number;
  countConfirmedForTenant(tenantId: string): number;        // the "already vouched for N" line
  listInFlight(): AgentBookRow[];                           // pending|submitted
  claimSubmit(sessionId, p: { nullifier; rawTx; submitterNonce }): "won" | "lost" | "inflight";
  setTxHash(sessionId: string, txHash: string): void;
  transition(sessionId, from: AgentBookStatus, to: AgentBookStatus, patch?: { errorCode?; confirmedBlock?; attempt? }): boolean;
  bumpAttempt(sessionId: string, errorCode: string): void;
}
export class SqliteAgentBookRepository implements AgentBookRepository
```

- [ ] **Step 1: Write the failing test**

```ts
// back/backend/test/persistence/agentBookRepository.test.ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SqliteAgentBookRepository } from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";

let db: Database.Database;
let repo: SqliteAgentBookRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteAgentBookRepository(db);
});
afterEach(() => db.close());

const session = (over: Partial<Parameters<SqliteAgentBookRepository["createSession"]>[0]> = {}) =>
  repo.createSession({
    sessionId: over.sessionId ?? "s1",
    entityKey: "agent-1",
    tenantId: "0xTenant",
    address: "0x2222222222222222222222222222222222222222",
    nonce: "0",
    expiresAt: Date.now() + 300_000,
    ...over,
  });

test("a session is a pending row and is found by id", () => {
  session();
  expect(repo.findBySession("s1")).toMatchObject({ status: "pending", nonce: "0", attempt: 0 });
});

test("claimSubmit is a CAS: pending -> submitted once, a second claim loses", () => {
  session();
  expect(repo.claimSubmit("s1", { nullifier: "0xabc", rawTx: "0x02aa", submitterNonce: 7 })).toBe("won");
  expect(repo.claimSubmit("s1", { nullifier: "0xabc", rawTx: "0x02aa", submitterNonce: 7 })).toBe("lost");
  expect(repo.findBySession("s1")).toMatchObject({ status: "submitted", nullifier: "0xabc", submitterNonce: 7 });
});

test("the partial unique index allows ONE in-flight submission per entity", () => {
  session({ sessionId: "s1" });
  session({ sessionId: "s2" });
  expect(repo.claimSubmit("s1", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 1 })).toBe("won");
  expect(repo.claimSubmit("s2", { nullifier: "0x2", rawTx: "0x02", submitterNonce: 2 })).toBe("inflight");
  expect(repo.findBySession("s2")?.status).toBe("pending");
});

test("a confirmed row coexists with a new submitted row (lifetime count sees both)", () => {
  session({ sessionId: "s1" });
  repo.claimSubmit("s1", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 1 });
  expect(repo.transition("s1", "submitted", "confirmed", { confirmedBlock: 100 })).toBe(true);
  session({ sessionId: "s2" });
  expect(repo.claimSubmit("s2", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 2 })).toBe("won");
  expect(repo.countLifetime("agent-1")).toBe(2);
  expect(repo.countConfirmedForTenant("0xTenant")).toBe(1);
  expect(repo.countConfirmedForTenant("0xOther")).toBe(0);
});

test("transition reports whether this caller won", () => {
  session();
  expect(repo.transition("s1", "submitted", "confirmed")).toBe(false);
  expect(repo.transition("s1", "pending", "expired")).toBe(true);
});

test("per-tenant session count is windowed", () => {
  session({ sessionId: "s1" });
  session({ sessionId: "s2" });
  expect(repo.countSessionsSince("0xTenant", Date.now() - 3_600_000)).toBe(2);
  expect(repo.countSessionsSince("0xTenant", Date.now() + 1_000)).toBe(0);
});

test("latestForEntity and listInFlight", () => {
  session({ sessionId: "s1" });
  repo.claimSubmit("s1", { nullifier: "0x1", rawTx: "0x02", submitterNonce: 1 });
  repo.setTxHash("s1", "0xhash");
  expect(repo.latestForEntity("agent-1")).toMatchObject({ sessionId: "s1", txHash: "0xhash" });
  expect(repo.listInFlight().map((r) => r.sessionId)).toEqual(["s1"]);
  repo.bumpAttempt("s1", "InvalidProof");
  expect(repo.findBySession("s1")).toMatchObject({ attempt: 1, errorCode: "InvalidProof" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd back/backend && npx vitest run test/persistence/agentBookRepository.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add the table to `migrate`**

In `src/persistence/db.ts`, inside the big `db.exec` of `migrate`, directly after the `world_human_cache` table:

```sql
    -- AgentBook registrations (design 2026-08-25 v3 §4.4). A `pending` row IS the session; the
    -- partial unique index on `submitted` is the atomic in-flight claim; `raw_tx` is persisted
    -- BEFORE broadcast (the bridge-legs rule) so a crash re-broadcasts the same transaction.
    CREATE TABLE IF NOT EXISTS agentbook_registrations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL UNIQUE,
      entity_key      TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      address         TEXT NOT NULL,
      nonce           TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN
                        ('pending','submitted','confirmed','disputed','failed','expired')),
      nullifier       TEXT,
      raw_tx          TEXT,
      submitter_nonce INTEGER,
      tx_hash         TEXT,
      confirmed_block INTEGER,
      attempt         INTEGER NOT NULL DEFAULT 0,
      error_code      TEXT,
      expires_at      INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agentbook_inflight
      ON agentbook_registrations(entity_key) WHERE status = 'submitted';
    CREATE INDEX IF NOT EXISTS idx_agentbook_entity
      ON agentbook_registrations(entity_key, id);
    CREATE INDEX IF NOT EXISTS idx_agentbook_tenant_created
      ON agentbook_registrations(tenant_id, created_at);
```

- [ ] **Step 4: Write the repository**

```ts
// back/backend/src/persistence/agentBookRepository.ts
import type Database from "better-sqlite3";

/**
 * AgentBook registrations (design 2026-08-25 v3 §4.4).
 *
 * Same CAS discipline as `oaAnchorRepository`: every state move is `UPDATE … WHERE status = ?` and
 * reports whether this caller won it. The partial unique index on `submitted` is the atomic
 * in-flight claim; a `pending` row is a session and never blocks a restart (expiry is its guard).
 */
export type AgentBookStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "disputed"
  | "failed"
  | "expired";

export interface AgentBookRow {
  id: number;
  sessionId: string;
  entityKey: string;
  tenantId: string;
  address: string;
  nonce: string;
  status: AgentBookStatus;
  nullifier: string | null;
  rawTx: string | null;
  submitterNonce: number | null;
  txHash: string | null;
  confirmedBlock: number | null;
  attempt: number;
  errorCode: string | null;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBookRepository {
  createSession(p: {
    sessionId: string;
    entityKey: string;
    tenantId: string;
    address: string;
    nonce: string;
    expiresAt: number;
  }): AgentBookRow;
  findBySession(sessionId: string): AgentBookRow | undefined;
  latestForEntity(entityKey: string): AgentBookRow | undefined;
  /** Rows that count toward the per-entity lifetime cap (D13). */
  countLifetime(entityKey: string): number;
  /** Sessions this tenant created since `sinceMs` (epoch ms), for the per-tenant window. */
  countSessionsSince(tenantId: string, sinceMs: number): number;
  /** Confirmed vouches from this tenant, for the "already vouched for N agents" dialog line. */
  countConfirmedForTenant(tenantId: string): number;
  listInFlight(): AgentBookRow[];
  /** pending -> submitted, writing what a crash must not lose. "inflight" = another submission for
   *  this entity holds the partial unique index. */
  claimSubmit(
    sessionId: string,
    p: { nullifier: string; rawTx: string; submitterNonce: number },
  ): "won" | "lost" | "inflight";
  setTxHash(sessionId: string, txHash: string): void;
  transition(
    sessionId: string,
    from: AgentBookStatus,
    to: AgentBookStatus,
    patch?: { errorCode?: string; confirmedBlock?: number },
  ): boolean;
  bumpAttempt(sessionId: string, errorCode: string): void;
}

const COLS = `id, session_id, entity_key, tenant_id, address, nonce, status, nullifier, raw_tx,
  submitter_nonce, tx_hash, confirmed_block, attempt, error_code, expires_at, created_at, updated_at`;

type Raw = {
  id: number;
  session_id: string;
  entity_key: string;
  tenant_id: string;
  address: string;
  nonce: string;
  status: AgentBookStatus;
  nullifier: string | null;
  raw_tx: string | null;
  submitter_nonce: number | null;
  tx_hash: string | null;
  confirmed_block: number | null;
  attempt: number;
  error_code: string | null;
  expires_at: number;
  created_at: string;
  updated_at: string;
};

const toRow = (r: Raw): AgentBookRow => ({
  id: r.id,
  sessionId: r.session_id,
  entityKey: r.entity_key,
  tenantId: r.tenant_id,
  address: r.address,
  nonce: r.nonce,
  status: r.status,
  nullifier: r.nullifier,
  rawTx: r.raw_tx,
  submitterNonce: r.submitter_nonce,
  txHash: r.tx_hash,
  confirmedBlock: r.confirmed_block,
  attempt: r.attempt,
  errorCode: r.error_code,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteAgentBookRepository implements AgentBookRepository {
  constructor(private readonly db: Database.Database) {}

  createSession(p: {
    sessionId: string;
    entityKey: string;
    tenantId: string;
    address: string;
    nonce: string;
    expiresAt: number;
  }): AgentBookRow {
    this.db
      .prepare(
        `INSERT INTO agentbook_registrations
           (session_id, entity_key, tenant_id, address, nonce, status, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(p.sessionId, p.entityKey, p.tenantId, p.address.toLowerCase(), p.nonce, p.expiresAt);
    const row = this.findBySession(p.sessionId);
    if (!row) throw new Error(`agentbook session ${p.sessionId} vanished after insert`);
    return row;
  }

  findBySession(sessionId: string): AgentBookRow | undefined {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM agentbook_registrations WHERE session_id = ?`)
      .get(sessionId) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  latestForEntity(entityKey: string): AgentBookRow | undefined {
    const r = this.db
      .prepare(
        `SELECT ${COLS} FROM agentbook_registrations WHERE entity_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(entityKey) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  countLifetime(entityKey: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agentbook_registrations
          WHERE entity_key = ? AND status IN ('submitted','confirmed','disputed')`,
      )
      .get(entityKey) as { n: number };
    return r.n;
  }

  countSessionsSince(tenantId: string, sinceMs: number): number {
    // created_at is a SQLite UTC timestamp; compare in seconds.
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agentbook_registrations
          WHERE tenant_id = ? AND strftime('%s', created_at) * 1000 >= ?`,
      )
      .get(tenantId, sinceMs) as { n: number };
    return r.n;
  }

  countConfirmedForTenant(tenantId: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agentbook_registrations
          WHERE tenant_id = ? AND status = 'confirmed'`,
      )
      .get(tenantId) as { n: number };
    return r.n;
  }

  listInFlight(): AgentBookRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLS} FROM agentbook_registrations
            WHERE status IN ('pending','submitted') ORDER BY id`,
        )
        .all() as Raw[]
    ).map(toRow);
  }

  claimSubmit(
    sessionId: string,
    p: { nullifier: string; rawTx: string; submitterNonce: number },
  ): "won" | "lost" | "inflight" {
    try {
      const res = this.db
        .prepare(
          `UPDATE agentbook_registrations
              SET status = 'submitted', nullifier = ?, raw_tx = ?, submitter_nonce = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ? AND status = 'pending'`,
        )
        .run(p.nullifier, p.rawTx, p.submitterNonce, sessionId);
      return res.changes === 1 ? "won" : "lost";
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT") return "inflight";
      throw e;
    }
  }

  setTxHash(sessionId: string, txHash: string): void {
    this.db
      .prepare(
        `UPDATE agentbook_registrations SET tx_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ?`,
      )
      .run(txHash, sessionId);
  }

  transition(
    sessionId: string,
    from: AgentBookStatus,
    to: AgentBookStatus,
    patch: { errorCode?: string; confirmedBlock?: number } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE agentbook_registrations
            SET status = ?, error_code = COALESCE(?, error_code),
                confirmed_block = COALESCE(?, confirmed_block), updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ? AND status = ?`,
      )
      .run(to, patch.errorCode ?? null, patch.confirmedBlock ?? null, sessionId, from);
    return res.changes === 1;
  }

  bumpAttempt(sessionId: string, errorCode: string): void {
    this.db
      .prepare(
        `UPDATE agentbook_registrations
            SET attempt = attempt + 1, error_code = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ?`,
      )
      .run(errorCode, sessionId);
  }
}
```

- [ ] **Step 5: Run the test, lint, typecheck**

Run: `cd back/backend && npx vitest run test/persistence/agentBookRepository.test.ts && npm run lint && npm run typecheck`
Expected: PASS. If the `inflight` test fails with a different SQLite error code, print `e.code` once and add it to the check; better-sqlite3 reports `SQLITE_CONSTRAINT_UNIQUE` for partial unique indexes.

- [ ] **Step 6: Commit**

```bash
git add back/backend/src/persistence/db.ts back/backend/src/persistence/agentBookRepository.ts back/backend/test/persistence/agentBookRepository.test.ts
git commit -m "feat(agentbook): registrations table with CAS repository and in-flight index (design v3 §4.4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Registrar adapter: signal, calldata, nonce, simulate, sign, broadcast

**Files:**
- Modify: `back/backend/src/payments/agentBookReader.ts` (export the shared constants and a fuller ABI)
- Create: `back/backend/src/adapters/worldid/agentBookRegistrar.ts`
- Test: `back/backend/test/world/agentBookRegistrar.test.ts`

**Interfaces:**
- Consumes: `withKeyedLock(key, fn)` from `src/payments/keyedMutex.ts`; `ContractRevertError` from `src/adapters/arc/relay.ts`.
- Produces:

```ts
// src/payments/agentBookReader.ts
export const AGENT_BOOK_CHAIN_ID = 480;
export const AGENT_BOOK_CAIP2 = "eip155:480";
export const AGENT_BOOK_ADDRESS = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";
export const AGENT_BOOK_ABI; // getNextNonce, lookupHuman, register, event AgentRegistered
// src/adapters/worldid/agentBookRegistrar.ts
export const AGENTBOOK_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
export const AGENTBOOK_ACTION = "agentbook-registration";
export function buildSignal(agent: Address, nonce: bigint): Hex;   // 52 bytes packed
export function hashSignal(signal: Hex): bigint;                    // keccak >> 8
export interface RegisterArgs { agent: Address; root: bigint; nonce: bigint; nullifierHash: bigint; proof: [bigint x8] }
export function encodeRegister(args: RegisterArgs): Hex;
export interface AgentBookRegistrar {
  address: Address;
  getNextNonce(agent: Address, blockTag?: "latest" | "safe"): Promise<bigint>;
  lookupHuman(agent: Address, blockTag?: "latest" | "safe"): Promise<string | null>;
  simulateRegister(args: RegisterArgs): Promise<void>;             // throws ContractRevertError on revert
  signRegister(args: RegisterArgs): Promise<{ rawTx: Hex; submitterNonce: number }>;
  broadcast(rawTx: Hex): Promise<Hex>;
  receiptStatus(txHash: Hex): Promise<"success" | "reverted" | null>;
  submitterNonce(): Promise<number>;
  submitterBalance(): Promise<bigint>;
}
export function createAgentBookRegistrar(opts: { submitterPrivateKey: Hex; readRpcUrl: string; writeRpcUrl: string; contractAddress?: Address; clients?: { publicClient; walletClient } }): AgentBookRegistrar;
```

- [ ] **Step 1: Write the failing tests**

```ts
// back/backend/test/world/agentBookRegistrar.test.ts
import { readFileSync } from "node:fs";
import { decodeFunctionData, keccak256, toFunctionSelector } from "viem";
import { describe, expect, test } from "vitest";
import {
  buildSignal,
  encodeRegister,
  hashSignal,
} from "../../src/adapters/worldid/agentBookRegistrar";
import { AGENT_BOOK_ABI, AGENT_BOOK_ADDRESS } from "../../src/payments/agentBookReader";

const AGENT = "0x1111111111111111111111111111111111111111" as const;

describe("signal", () => {
  test("golden vector: address (20 bytes) ++ nonce (32 bytes), packed, 52 bytes", () => {
    const sig = buildSignal(AGENT, 1n);
    expect(sig).toBe(`0x${"11".repeat(20)}${"00".repeat(31)}01`);
    expect((sig.length - 2) / 2).toBe(52);
  });
  test("hashSignal is keccak256 >> 8 (World's hashToField)", () => {
    const sig = buildSignal(AGENT, 7n);
    expect(hashSignal(sig)).toBe(BigInt(keccak256(sig)) >> 8n);
  });
});

describe("register calldata", () => {
  const args = {
    agent: AGENT,
    root: 2n,
    nonce: 3n,
    nullifierHash: 4n,
    proof: [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n] as const,
  };
  test("selector and argument order are pinned", () => {
    const data = encodeRegister({ ...args, proof: [...args.proof] });
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector("register(address,uint256,uint256,uint256,uint256[8])"),
    );
    const decoded = decodeFunctionData({ abi: AGENT_BOOK_ABI, data });
    expect(decoded.functionName).toBe("register");
    expect(decoded.args).toEqual([AGENT, 2n, 3n, 4n, [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n]]);
    // Raw slot check: three adjacent uint256s reorder silently if the ABI is rebuilt by hand.
    const words = data.slice(10).match(/.{64}/g) ?? [];
    expect(BigInt(`0x${words[1]}`)).toBe(2n); // root
    expect(BigInt(`0x${words[2]}`)).toBe(3n); // nonce
    expect(BigInt(`0x${words[3]}`)).toBe(4n); // nullifierHash
  });
});

describe("verifier chain pin (design v3 §1.3, audit H1)", () => {
  test("the installed agentkit-core verifier still reads World Chain and the canonical contract", () => {
    const dist = readFileSync(
      "node_modules/@worldcoin/agentkit-core/dist/cjs/index.js",
      "utf8",
    );
    expect(dist).toContain("worldchain");
    expect(dist.toLowerCase()).toContain(AGENT_BOOK_ADDRESS.toLowerCase());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd back/backend && npx vitest run test/world/agentBookRegistrar.test.ts`
Expected: FAIL, module not found / `AGENT_BOOK_ADDRESS` not exported.

- [ ] **Step 3: Extend `agentBookReader.ts`**

Replace the private `AGENT_BOOK_ABI` with an exported fuller ABI and add the constants. Keep `createAgentBookReader` unchanged apart from reading the exported ABI.

```ts
export const AGENT_BOOK_CHAIN_ID = 480;
export const AGENT_BOOK_CAIP2 = "eip155:480";
/** Canonical World Chain deployment; the SDK verifier and our reader both resolve here. */
export const AGENT_BOOK_ADDRESS = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;

/** Vendored as named args on purpose: `register` has three adjacent uint256s, and an ABI
 *  reconstructed from a selector reorders them silently (design v3 §4.1). */
export const AGENT_BOOK_ABI = [
  {
    inputs: [{ internalType: "address", name: "agent", type: "address" }],
    name: "lookupHuman",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "agent", type: "address" }],
    name: "getNextNonce",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "agent", type: "address" },
      { internalType: "uint256", name: "root", type: "uint256" },
      { internalType: "uint256", name: "nonce", type: "uint256" },
      { internalType: "uint256", name: "nullifierHash", type: "uint256" },
      { internalType: "uint256[8]", name: "proof", type: "uint256[8]" },
    ],
    name: "register",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "agent", type: "address" },
      { indexed: true, internalType: "uint256", name: "humanId", type: "uint256" },
    ],
    name: "AgentRegistered",
    type: "event",
  },
] as const;
```

- [ ] **Step 4: Write the registrar**

```ts
// back/backend/src/adapters/worldid/agentBookRegistrar.ts
import {
  http,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { worldchain } from "viem/chains";
import { withKeyedLock } from "../../payments/keyedMutex";
import { ContractRevertError } from "../arc/relay";
import { AGENT_BOOK_ABI, AGENT_BOOK_ADDRESS } from "../../payments/agentBookReader";

/** World's registration app and action (design v3 §1.3). The contract bakes the resulting
 *  external nullifier in with no getter, so the only validation is one live registration. */
export const AGENTBOOK_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
export const AGENTBOOK_ACTION = "agentbook-registration";

/** The registrar's lock key: one submitter EOA, one EVM nonce sequence, one writer at a time. */
export const SUBMITTER_LOCK = "worldchain-submitter";

/** `abi.encodePacked(address, uint256)`: 52 bytes. The padded 64-byte form type-checks, encodes,
 *  and reverts on-chain AFTER the guardian has done the work (design v3 §4.1). */
export function buildSignal(agent: Address, nonce: bigint): Hex {
  return encodePacked(["address", "uint256"], [agent, nonce]);
}

/** World's `hashToField`: keccak256 of the packed bytes, shifted right by 8 bits. */
export function hashSignal(signal: Hex): bigint {
  return BigInt(keccak256(signal)) >> 8n;
}

export interface RegisterArgs {
  agent: Address;
  root: bigint;
  nonce: bigint;
  nullifierHash: bigint;
  proof: bigint[]; // exactly 8; validated by the route's zod schema
}

export function encodeRegister(a: RegisterArgs): Hex {
  if (a.proof.length !== 8) throw new Error("register: proof must have exactly 8 elements");
  const proof = a.proof as unknown as readonly [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
  return encodeFunctionData({
    abi: AGENT_BOOK_ABI,
    functionName: "register",
    args: [a.agent, a.root, a.nonce, a.nullifierHash, proof],
  });
}

export interface AgentBookRegistrar {
  address: Address;
  getNextNonce(agent: Address, blockTag?: "latest" | "safe"): Promise<bigint>;
  /** `null` = definitively unregistered; throws on transport (same discipline as the reader). */
  lookupHuman(agent: Address, blockTag?: "latest" | "safe"): Promise<string | null>;
  /** Throws `ContractRevertError` for a deterministic revert, anything else for transport. */
  simulateRegister(args: RegisterArgs): Promise<void>;
  /** Signs under the submitter lock and returns the raw transaction plus the EVM nonce it used.
   *  Nothing is broadcast here: the caller persists first (bridge-legs rule), then broadcasts. */
  signRegister(args: RegisterArgs): Promise<{ rawTx: Hex; submitterNonce: number }>;
  broadcast(rawTx: Hex): Promise<Hex>;
  receiptStatus(txHash: Hex): Promise<"success" | "reverted" | null>;
  submitterNonce(): Promise<number>;
  submitterBalance(): Promise<bigint>;
}

export interface RegistrarOptions {
  submitterPrivateKey: Hex;
  readRpcUrl: string;
  writeRpcUrl: string;
  contractAddress?: Address;
  /** Test seam. */
  clients?: { publicClient: PublicClient; walletClient: WalletClient };
}

export function createAgentBookRegistrar(opts: RegistrarOptions): AgentBookRegistrar {
  const account = privateKeyToAccount(opts.submitterPrivateKey);
  const contract = (opts.contractAddress ?? AGENT_BOOK_ADDRESS) as Address;
  const publicClient =
    opts.clients?.publicClient ??
    createPublicClient({ chain: worldchain, transport: http(opts.readRpcUrl) });
  const walletClient =
    opts.clients?.walletClient ??
    createWalletClient({ chain: worldchain, transport: http(opts.writeRpcUrl), account });

  const revertOf = (e: unknown): ContractRevertError | undefined => {
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (r instanceof ContractFunctionRevertedError)
        return new ContractRevertError(
          `AgentBook.register reverted: ${r.data?.errorName ?? "unknown"}`,
          r.data?.errorName,
          { cause: e },
        );
    }
    return undefined;
  };

  return {
    address: account.address,
    async getNextNonce(agent, blockTag = "latest") {
      return (await publicClient.readContract({
        address: contract,
        abi: AGENT_BOOK_ABI,
        functionName: "getNextNonce",
        args: [agent],
        blockTag,
      })) as bigint;
    },
    async lookupHuman(agent, blockTag = "latest") {
      const id = (await publicClient.readContract({
        address: contract,
        abi: AGENT_BOOK_ABI,
        functionName: "lookupHuman",
        args: [agent],
        blockTag,
      })) as bigint;
      return id === 0n ? null : toHex(id);
    },
    async simulateRegister(args) {
      try {
        await publicClient.call({ account, to: contract, data: encodeRegister(args) });
      } catch (e) {
        const revert = revertOf(e);
        if (revert) throw revert;
        throw e;
      }
    },
    async signRegister(args) {
      return withKeyedLock(SUBMITTER_LOCK, async () => {
        const request = await walletClient.prepareTransactionRequest({
          account,
          chain: worldchain,
          to: contract,
          data: encodeRegister(args),
        });
        const rawTx = await walletClient.signTransaction(request);
        return { rawTx, submitterNonce: Number(request.nonce) };
      });
    },
    async broadcast(rawTx) {
      return publicClient.sendRawTransaction({ serializedTransaction: rawTx });
    },
    async receiptStatus(txHash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: txHash });
        return r.status === "success" ? "success" : "reverted";
      } catch (e) {
        if (e instanceof BaseError && /not (be )?found/i.test(e.shortMessage)) return null;
        throw e;
      }
    },
    async submitterNonce() {
      return publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    },
    async submitterBalance() {
      return publicClient.getBalance({ address: account.address });
    },
  };
}
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `cd back/backend && npx vitest run test/world/agentBookRegistrar.test.ts test/payments && npm run lint && npm run typecheck`
Expected: PASS. If `walletClient.signTransaction(request)` fails typecheck on the request shape, cast with `request as Parameters<typeof walletClient.signTransaction>[0]` and add a `biome-ignore` comment naming the viem version.

- [ ] **Step 6: Commit**

```bash
git add back/backend/src/payments/agentBookReader.ts back/backend/src/adapters/worldid/agentBookRegistrar.ts back/backend/test/world/agentBookRegistrar.test.ts
git commit -m "feat(agentbook): registrar with packed signal, pinned calldata, locked signing (design v3 §4.1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Reconciler: the §6 rules as a pure function over the repository and registrar

**Files:**
- Create: `back/backend/src/workflow/agentBookReconcile.ts`
- Test: `back/backend/test/workflow/agentBookReconcile.test.ts`

**Interfaces:**
- Consumes: `AgentBookRepository`, `AgentBookRow` (Task 2); `AgentBookRegistrar` (Task 3); `WorldStore.cacheLookup(address, humanId | null, now)` (existing, `src/persistence/worldStore.ts:117`).
- Produces:

```ts
export interface ReconcileDeps {
  repo: AgentBookRepository;
  registrar: Pick<AgentBookRegistrar, "getNextNonce" | "lookupHuman" | "broadcast" | "receiptStatus" | "submitterNonce">;
  store: Pick<WorldStore, "cacheLookup">;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}
export const STALE_AFTER_MS = 10 * 60_000;
export async function reconcileRow(row: AgentBookRow, deps: ReconcileDeps): Promise<AgentBookRow>;
export async function reconcileAgentBook(deps: ReconcileDeps): Promise<{ checked: number; changed: number }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// back/backend/test/workflow/agentBookReconcile.test.ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type AgentBookRow,
  SqliteAgentBookRepository,
} from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { STALE_AFTER_MS, reconcileRow } from "../../src/workflow/agentBookReconcile";

let db: Database.Database;
let repo: SqliteAgentBookRepository;
let store: SqliteWorldStore;
const POCKET = "0x2222222222222222222222222222222222222222";
const T0 = 1_800_000_000_000;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteAgentBookRepository(db);
  store = new SqliteWorldStore(db);
});
afterEach(() => db.close());

function submitted(over: { txHash?: string | null } = {}): AgentBookRow {
  repo.createSession({
    sessionId: "s1",
    entityKey: "agent-1",
    tenantId: "0xT",
    address: POCKET,
    nonce: "5",
    expiresAt: T0 + 300_000,
  });
  repo.claimSubmit("s1", { nullifier: "0xours", rawTx: "0x02raw", submitterNonce: 9 });
  if (over.txHash) repo.setTxHash("s1", over.txHash);
  return repo.findBySession("s1")!;
}

const registrar = (o: {
  nonce: bigint;
  human?: string | null;
  receipt?: "success" | "reverted" | null;
  chainNonce?: number;
}) => ({
  getNextNonce: vi.fn(async () => o.nonce),
  lookupHuman: vi.fn(async () => o.human ?? null),
  broadcast: vi.fn(async () => "0xrebroadcast" as `0x${string}`),
  receiptStatus: vi.fn(async () => o.receipt ?? null),
  submitterNonce: vi.fn(async () => o.chainNonce ?? 9),
});

test("nonce moved and lookupHuman equals ours -> confirmed, read at safe", async () => {
  const row = submitted({ txHash: "0xh" });
  const r = registrar({ nonce: 6n, human: "0xours", receipt: "success" });
  const out = await reconcileRow(row, { repo, registrar: r, store, now: () => T0 });
  expect(out.status).toBe("confirmed");
  expect(r.getNextNonce).toHaveBeenCalledWith(POCKET, "safe");
  expect(r.lookupHuman).toHaveBeenCalledWith(POCKET, "safe");
});

test("nonce moved and lookupHuman differs -> disputed, and the foreign id is cached", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, {
    repo,
    registrar: registrar({ nonce: 6n, human: "0xstranger" }),
    store,
    now: () => T0,
  });
  expect(out.status).toBe("disputed");
  expect(store.getCachedLookup(POCKET, T0, 60_000, 60_000)?.humanId).toBe("0xstranger");
});

test("receipt reverted -> failed immediately", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, {
    repo,
    registrar: registrar({ nonce: 5n, receipt: "reverted" }),
    store,
    now: () => T0,
  });
  expect(out).toMatchObject({ status: "failed", errorCode: "reverted" });
});

test("nonce unmoved, fresh -> unchanged", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, { repo, registrar: registrar({ nonce: 5n }), store, now: () => T0 });
  expect(out.status).toBe("submitted");
});

test("nonce unmoved, stale, no tx hash, submitter nonce not passed -> re-broadcast the stored raw tx", async () => {
  const row = submitted({ txHash: null });
  const r = registrar({ nonce: 5n, chainNonce: 9 });
  const out = await reconcileRow(row, { repo, registrar: r, store, now: () => T0 + STALE_AFTER_MS + 1 });
  expect(r.broadcast).toHaveBeenCalledWith("0x02raw");
  expect(out.txHash).toBe("0xrebroadcast");
  expect(out.status).toBe("submitted");
});

test("nonce unmoved, stale, submitter nonce passed -> failed as replaced", async () => {
  const row = submitted({ txHash: "0xh" });
  const out = await reconcileRow(row, {
    repo,
    registrar: registrar({ nonce: 5n, chainNonce: 10 }),
    store,
    now: () => T0 + STALE_AFTER_MS + 1,
  });
  expect(out).toMatchObject({ status: "failed", errorCode: "replaced" });
});

test("a pending session past expiry -> expired", async () => {
  repo.createSession({
    sessionId: "s9",
    entityKey: "agent-1",
    tenantId: "0xT",
    address: POCKET,
    nonce: "1",
    expiresAt: T0 - 1,
  });
  const out = await reconcileRow(repo.findBySession("s9")!, {
    repo,
    registrar: registrar({ nonce: 1n }),
    store,
    now: () => T0,
  });
  expect(out.status).toBe("expired");
});

test("a transport failure leaves the row untouched", async () => {
  const row = submitted({ txHash: "0xh" });
  const r = registrar({ nonce: 5n });
  r.getNextNonce.mockRejectedValueOnce(new Error("rpc down"));
  const out = await reconcileRow(row, { repo, registrar: r, store, now: () => T0 });
  expect(out.status).toBe("submitted");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd back/backend && npx vitest run test/workflow/agentBookReconcile.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the reconciler**

```ts
// back/backend/src/workflow/agentBookReconcile.ts
import type { Address, Hex } from "viem";
import type { AgentBookRegistrar } from "../adapters/worldid/agentBookRegistrar";
import type { AgentBookRepository, AgentBookRow } from "../persistence/agentBookRepository";
import type { WorldStore } from "../persistence/worldStore";

/**
 * The §6 reconciliation rules (design 2026-08-25 v3), contract state first:
 *   1. pending past expiry -> expired.
 *   2. a receipt with status 0 -> failed (fast path).
 *   3. getNextNonce(pocket) at `safe` moved past the row's nonce -> lookupHuman at `safe`:
 *      equal to our nullifier -> confirmed; different -> disputed (and cached, so the dials stop
 *      serving the stale id).
 *   4. nonce unmoved and the row older than STALE_AFTER_MS: re-broadcast the stored raw tx while
 *      the submitter's EVM nonce has not passed ours; once it has, the tx was replaced -> failed.
 * Transport failures change nothing: "could not tell" is never a state.
 */
export interface ReconcileDeps {
  repo: AgentBookRepository;
  registrar: Pick<
    AgentBookRegistrar,
    "getNextNonce" | "lookupHuman" | "broadcast" | "receiptStatus" | "submitterNonce"
  >;
  store: Pick<WorldStore, "cacheLookup">;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export const STALE_AFTER_MS = 10 * 60_000;

const ageMs = (row: AgentBookRow, now: number) => now - Date.parse(`${row.updatedAt}Z`);

export async function reconcileRow(row: AgentBookRow, deps: ReconcileDeps): Promise<AgentBookRow> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const reload = () => deps.repo.findBySession(row.sessionId) ?? row;

  if (row.status === "pending") {
    if (row.expiresAt < now()) deps.repo.transition(row.sessionId, "pending", "expired");
    return reload();
  }
  if (row.status !== "submitted") return row;

  try {
    if (row.txHash) {
      const receipt = await deps.registrar.receiptStatus(row.txHash as Hex);
      if (receipt === "reverted") {
        deps.repo.transition(row.sessionId, "submitted", "failed", { errorCode: "reverted" });
        log("agentbook_failed", { entity: row.entityKey, reason: "reverted" });
        return reload();
      }
    }
    const agent = row.address as Address;
    const nonce = await deps.registrar.getNextNonce(agent, "safe");
    if (nonce > BigInt(row.nonce)) {
      const human = await deps.registrar.lookupHuman(agent, "safe");
      if (human !== null && row.nullifier !== null && human.toLowerCase() === row.nullifier.toLowerCase()) {
        deps.repo.transition(row.sessionId, "submitted", "confirmed");
        log("agentbook_confirmed", { entity: row.entityKey });
      } else {
        deps.repo.transition(row.sessionId, "submitted", "disputed");
        deps.store.cacheLookup(agent, human, now());
        log("agentbook_disputed", { entity: row.entityKey });
      }
      return reload();
    }
    if (ageMs(row, now()) < STALE_AFTER_MS) return row;
    const chainNonce = await deps.registrar.submitterNonce();
    if (row.submitterNonce !== null && chainNonce > row.submitterNonce) {
      deps.repo.transition(row.sessionId, "submitted", "failed", { errorCode: "replaced" });
      log("agentbook_failed", { entity: row.entityKey, reason: "replaced" });
      return reload();
    }
    if (row.rawTx) {
      const hash = await deps.registrar.broadcast(row.rawTx as Hex);
      deps.repo.setTxHash(row.sessionId, hash);
      log("agentbook_rebroadcast", { entity: row.entityKey });
    }
    return reload();
  } catch (e) {
    log("agentbook_reconcile_unavailable", {
      entity: row.entityKey,
      errorName: e instanceof Error ? e.name : "unknown",
    });
    return row;
  }
}

export async function reconcileAgentBook(
  deps: ReconcileDeps,
): Promise<{ checked: number; changed: number }> {
  let checked = 0;
  let changed = 0;
  for (const row of deps.repo.listInFlight()) {
    checked += 1;
    const after = await reconcileRow(row, deps);
    if (after.status !== row.status || after.txHash !== row.txHash) changed += 1;
  }
  return { checked, changed };
}
```

Note on `ageMs`: SQLite's `CURRENT_TIMESTAMP` is `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, hence the appended `Z`. The "stale" test moves `now` forward instead of backdating the row, so the arithmetic above is what makes it pass.

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `cd back/backend && npx vitest run test/workflow/agentBookReconcile.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add back/backend/src/workflow/agentBookReconcile.ts back/backend/test/workflow/agentBookReconcile.test.ts
git commit -m "feat(agentbook): reconciler — contract state first, safe tag, re-broadcast, replaced (design v3 §6)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Routes, caps, wiring, and the moved status route

**Files:**
- Create: `back/backend/src/api/routes/agentBook.ts`
- Modify: `back/backend/src/api/routes/worldId.ts` (delete the `GET /entities/:id/agentbook` handler and its comment block, lines 415-455)
- Modify: `back/backend/src/api/app.ts` (`ApiDeps`, `/config`, mount)
- Modify: `back/backend/src/api/main.ts` (build the deps; boot reconcile)
- Rewrite: `back/backend/test/api/agentBookRoute.test.ts`
- Test: `back/backend/test/api/agentBookRegistration.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4; `requireAuth`, `ApiError`, `opsLog`, `WorldStore.findByTenant(tenantId, action)` (returns `{ credential, nullifier, ... } | undefined`), `AgentBookReader`.
- Produces:

```ts
export interface AgentBookDeps {
  registrar: AgentBookRegistrar;
  repo: AgentBookRepository;
  reader: AgentBookReader;
  store: WorldStore;
  network: "testnet" | "mainnet";
  caps: { perEntityLifetime: number; perTenantPerHour: number };
  budget: TokenBucket;
  now?: () => number;
}
export class TokenBucket { constructor(capacity: number, refillPerSecond: number); take(): boolean }
export function mountAgentBookRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void
// ApiDeps gains: agentBook?: AgentBookDeps
// GET /config gains: agentBookRegistrationAvailable: boolean
```

Response shapes:

```ts
// POST /entities/:id/agentbook/session -> 200
{ sessionId, appId, action, signal, nonce, pocketAddress, agentId, expiresAt, network, priorVouches }
// POST /entities/:id/agentbook/register { sessionId, root, nonce, nullifierHash, proof: string[8] } -> 200
{ status: "submitted", txHash: string | null }
// GET /entities/:id/agentbook -> 200 (superset of today's shape)
{ registered: boolean, humanId?: string, address?: string, reason?: "no-pocket-yet",
  outcome: "registered" | "unregistered" | "unknown" | "disputed",
  status?: AgentBookStatus, txHash?: string | null, disputed: boolean }
```

Error codes: `not_found` 404 (foreign or missing entity), `not_ready` 409 (`no-pocket-yet` or status below `bound`), `not_eligible` 403 (non-Orb credential), `limit_exceeded` 429 (caps), `unavailable` 503 (budget exhausted, RPC failure, submitter balance zero), `conflict` 409 (nonce moved, session expired, in-flight), `proof_rejected` 400 (simulate reverted; details `{ errorName }` only), `validation_error` 400 (zod).

- [ ] **Step 1: Rewrite the existing status-route test for the new deps**

Replace the `makeApp` body in `test/api/agentBookRoute.test.ts` so it no longer stubs `x402Demo`; keep the four existing tests and their expectations, and add the `outcome` field:

```ts
import { SqliteAgentBookRepository } from "../../src/persistence/agentBookRepository";
import { TokenBucket } from "../../src/api/routes/agentBook";

function makeApp(reader?: { lookupHuman(a: string): Promise<string | null> }) {
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    worldId: {
      cfg: {
        appId: "app_x",
        rpId: "rp_x",
        rpSigningKey: `0x${"1".repeat(64)}`,
        action: "guardian-verification",
        environment: "staging" as const,
      },
      store: world,
      requireGuardian: false,
    },
    agentBook: {
      registrar: {} as never,
      repo: new SqliteAgentBookRepository(db),
      reader: reader ?? { lookupHuman: async () => null },
      store: world,
      network: "testnet",
      caps: { perEntityLifetime: 3, perTenantPerHour: 5 },
      budget: new TokenBucket(100, 100),
    },
  } as never);
}
```

Update the first test to inject a reader that answers `"0xdeadbeef"` for `POCKET` and `null` otherwise, and assert `outcome: "registered"`. Add:

```ts
test("an RPC failure is 'unknown', never 'not registered'", async () => {
  repo.upsert(base());
  const app = makeApp({ lookupHuman: async () => { throw new Error("rpc down"); } });
  const body = await get(app);
  expect(body).toMatchObject({ registered: false, outcome: "unknown" });
});
```

- [ ] **Step 2: Write the failing registration tests**

```ts
// back/backend/test/api/agentBookRegistration.test.ts
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { signSession } from "../../src/auth/session";
import { SqliteAgentBookRepository } from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { EntityRecord } from "../../src/types";

const TENANT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const JWT_SECRET = "s";
const POCKET = "0x2222222222222222222222222222222222222222";
const ACTION = "guardian-verification";
const NULLIFIER = "0x0badf00d";
const PROOF = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString(16)}`);

let db: Database.Database;
let repo: SqliteEntityRepository;
let world: SqliteWorldStore;
let abRepo: SqliteAgentBookRepository;
let logs: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  world = new SqliteWorldStore(db);
  abRepo = new SqliteAgentBookRepository(db);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

const entity = (over: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    idempotencyKey: "agent-1", name: "A", status: "funded",
    manager: "0x000000000000000000000000000000000000000A", guardian: TENANT,
    operator: "0x1111111111111111111111111111111111111111", pocketAddress: POCKET,
    amendmentDelay: "0", ein: "12-3456789", formationDate: 0, oaHash: null, metadataURI: null,
    docPath: null, treasuryConfig: null, agentId: "900001", proxy: null, treasury: null,
    createTxHash: null, bindTxHash: null, fundTxHash: null, ownerTenantId: TENANT,
    walletProvider: "circle", publicId: "33333333-3333-3333-3333-333333333333", ...over,
  }) as EntityRecord;

function verifyGuardian(credential = "proof_of_human") {
  // The same call the World verify route makes after a successful proof (routes/worldId.ts:184).
  world.recordVerification({
    nullifier: "0xguardian",
    action: ACTION,
    tenantId: TENANT,
    issuerSchemaId: null,
    credential,
    environment: "staging",
    verifiedAt: Date.now(),
    expiresAtMin: null,
  });
}

const registrar = () => ({
  address: "0x9999999999999999999999999999999999999999",
  getNextNonce: vi.fn(async () => 0n),
  lookupHuman: vi.fn(async () => null),
  simulateRegister: vi.fn(async () => {}),
  signRegister: vi.fn(async () => ({ rawTx: "0x02raw" as const, submitterNonce: 1 })),
  broadcast: vi.fn(async () => "0xtxhash" as const),
  receiptStatus: vi.fn(async () => null),
  submitterNonce: vi.fn(async () => 1),
  submitterBalance: vi.fn(async () => 10n ** 16n),
});

function makeApp(reg = registrar(), caps = { perEntityLifetime: 3, perTenantPerHour: 5 }, budget = new TokenBucket(100, 100)) {
  return buildApiApp({
    webOrigin: "*", jwtSecret: JWT_SECRET, repo,
    worldId: {
      cfg: { appId: "app_x", rpId: "rp_x", rpSigningKey: `0x${"1".repeat(64)}`, action: ACTION, environment: "staging" as const },
      store: world, requireGuardian: false,
    },
    agentBook: { registrar: reg, repo: abRepo, reader: { lookupHuman: async () => null }, store: world, network: "testnet", caps, budget },
  } as never);
}

const token = async () => (await signSession(TENANT, JWT_SECRET, 3600, Math.floor(Date.now() / 1000))).token;
const call = async (app: ReturnType<typeof buildApiApp>, path: string, body?: unknown) =>
  app.request(`/entities/agent-1/agentbook${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("session: Orb guardian gets signal, nonce, address, agent id, network", async () => {
  repo.upsert(entity()); verifyGuardian();
  const res = await call(makeApp(), "/session", {});
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b).toMatchObject({ appId: "app_a7c3e2b6b83927251a0db5345bd7146a", action: "agentbook-registration", nonce: "0", pocketAddress: POCKET, agentId: "900001", network: "testnet", priorVouches: 0 });
  expect(b.signal).toBe(`0x${"22".repeat(20)}${"00".repeat(32)}`);
  expect(abRepo.findBySession(b.sessionId)?.status).toBe("pending");
});

test("session: a passport guardian is refused with not_eligible and the Orb message", async () => {
  repo.upsert(entity()); verifyGuardian("passport");
  const res = await call(makeApp(), "/session", {});
  expect(res.status).toBe(403);
  const b = await res.json();
  expect(b.error.code).toBe("not_eligible");
  expect(b.error.message).toContain("World ID from an Orb");
});

test("session: waiver guardian refused; no pocket -> not_ready; status below bound -> not_ready", async () => {
  repo.upsert(entity()); verifyGuardian("waiver");
  expect((await call(makeApp(), "/session", {})).status).toBe(403);
  verifyGuardian();
  repo.upsert(entity({ pocketAddress: null }));
  expect((await call(makeApp(), "/session", {})).status).toBe(409);
  repo.upsert(entity({ status: "created" }));
  expect((await call(makeApp(), "/session", {})).status).toBe(409);
});

test("caps: the tenant window and the entity lifetime cap return 429; the budget returns 503 before any RPC", async () => {
  repo.upsert(entity()); verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg, { perEntityLifetime: 3, perTenantPerHour: 2 });
  expect((await call(app, "/session", {})).status).toBe(200);
  expect((await call(app, "/session", {})).status).toBe(200);
  expect((await call(app, "/session", {})).status).toBe(429);
  const starved = makeApp(registrar(), undefined, new TokenBucket(0, 0));
  const res = await call(starved, "/session", {});
  expect(res.status).toBe(503);
  expect(reg.getNextNonce).toHaveBeenCalledTimes(2);
});

test("register: happy path claims, persists before broadcast, broadcasts, stores the hash", async () => {
  repo.upsert(entity()); verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", { sessionId, root: "0x1", nonce: "0", nullifierHash: NULLIFIER, proof: PROOF });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "submitted", txHash: "0xtxhash" });
  const row = abRepo.findBySession(sessionId)!;
  expect(row).toMatchObject({ status: "submitted", nullifier: NULLIFIER, rawTx: "0x02raw", submitterNonce: 1, txHash: "0xtxhash" });
  expect(reg.simulateRegister).toHaveBeenCalledOnce();
  expect(reg.signRegister.mock.invocationCallOrder[0]).toBeLessThan(reg.broadcast.mock.invocationCallOrder[0]);
});

test("register: a nonce that moved is a 409 and nothing is signed", async () => {
  repo.upsert(entity()); verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  reg.getNextNonce.mockResolvedValue(1n);
  const res = await call(app, "/register", { sessionId, root: "0x1", nonce: "0", nullifierHash: NULLIFIER, proof: PROOF });
  expect(res.status).toBe(409);
  expect(reg.signRegister).not.toHaveBeenCalled();
});

test("register: a deterministic revert is proof_rejected with the error NAME only; the log and body never carry the proof or the nullifier", async () => {
  repo.upsert(entity()); verifyGuardian();
  const reg = registrar();
  reg.simulateRegister.mockRejectedValue(new ContractRevertError("AgentBook.register reverted: InvalidNonce", "InvalidNonce"));
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", { sessionId, root: "0x1", nonce: "0", nullifierHash: NULLIFIER, proof: PROOF });
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain("InvalidNonce");
  expect(text).not.toContain(NULLIFIER);
  expect(text).not.toContain(PROOF[3]);
  expect(logs.join("\n")).not.toContain(NULLIFIER);
  expect(abRepo.findBySession(sessionId)).toMatchObject({ status: "pending", attempt: 1, errorCode: "InvalidNonce" });
});

test("register: input validation rejects 7 proof elements and a foreign session", async () => {
  repo.upsert(entity()); verifyGuardian();
  const app = makeApp();
  const { sessionId } = await (await call(app, "/session", {})).json();
  expect((await call(app, "/register", { sessionId, root: "0x1", nonce: "0", nullifierHash: NULLIFIER, proof: PROOF.slice(0, 7) })).status).toBe(400);
  expect((await call(app, "/register", { sessionId: "nope", root: "0x1", nonce: "0", nullifierHash: NULLIFIER, proof: PROOF })).status).toBe(409);
});

test("GET after submit reconciles and reports the row", async () => {
  repo.upsert(entity()); verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  await call(app, "/register", { sessionId, root: "0x1", nonce: "0", nullifierHash: NULLIFIER, proof: PROOF });
  reg.getNextNonce.mockResolvedValue(1n);
  reg.lookupHuman.mockResolvedValue(NULLIFIER);
  const b = await (await call(app, "")).json();
  expect(b).toMatchObject({ status: "confirmed", txHash: "0xtxhash", disputed: false, address: POCKET });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd back/backend && npx vitest run test/api/agentBookRegistration.test.ts test/api/agentBookRoute.test.ts`
Expected: FAIL, `src/api/routes/agentBook` not found.

- [ ] **Step 4: Write the routes module**

```ts
// back/backend/src/api/routes/agentBook.ts
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Address } from "viem";
import { z } from "zod";
import { ContractRevertError } from "../../adapters/arc/relay";
import {
  AGENTBOOK_ACTION,
  AGENTBOOK_APP_ID,
  type AgentBookRegistrar,
  buildSignal,
} from "../../adapters/worldid/agentBookRegistrar";
import { type AuthVars, requireAuth } from "../../auth/middleware";
import { opsLog } from "../../observability/opsLog";
import type { AgentBookReader } from "../../payments/agentBookReader";
import type { AgentBookRepository, AgentBookStatus } from "../../persistence/agentBookRepository";
import type { WorldStore } from "../../persistence/worldStore";
import type { EntityRecord } from "../../types";
import { reconcileRow } from "../../workflow/agentBookReconcile";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

/** Process-wide budget on World Chain calls made by these routes (design v3 §4.7, D13). */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface AgentBookDeps {
  registrar: AgentBookRegistrar;
  repo: AgentBookRepository;
  reader: AgentBookReader;
  store: WorldStore;
  network: "testnet" | "mainnet";
  caps: { perEntityLifetime: number; perTenantPerHour: number };
  budget: TokenBucket;
  now?: () => number;
}

const ORB_CREDENTIALS = new Set(["orb", "proof_of_human"]);
const SESSION_TTL_MS = 5 * 60_000;
const READY_STATUSES = new Set<EntityRecord["status"]>(["bound", "funded"]);
const NOT_ELIGIBLE_MESSAGE =
  "AgentBook vouching needs a World ID from an Orb. Your access here is unaffected. AgentBook is World's public registry and only accepts Orb-verified proofs. There is nothing we can substitute for that, and we will not fake it.";

const uint = z.string().regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/);
const RegisterBody = z.object({
  sessionId: z.string().uuid(),
  root: uint,
  nonce: uint,
  nullifierHash: uint,
  proof: z.array(uint).length(8),
});

export function mountAgentBookRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const ab = deps.agentBook;
  const world = deps.worldId;
  if (!ab || !world) return;
  const now = ab.now ?? Date.now;
  const auth = requireAuth(deps.jwtSecret);
  const limit = bodyLimit({ maxSize: 8 * 1024 });

  const ownedEntity = (id: string, tenantId: string): EntityRecord => {
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== tenantId) throw new ApiError("not_found", 404, "entity not found");
    return rec;
  };
  const requireOrb = (tenantId: string) => {
    const v = world.store.findByTenant(tenantId, world.cfg.action);
    if (!v || !ORB_CREDENTIALS.has(v.credential))
      throw new ApiError("not_eligible", 403, NOT_ELIGIBLE_MESSAGE, { credential: v?.credential ?? null });
    return v;
  };
  const requirePocket = (rec: EntityRecord): Address => {
    if (!rec.pocketAddress) throw new ApiError("not_ready", 409, "no-pocket-yet", { reason: "no-pocket-yet" });
    if (!READY_STATUSES.has(rec.status)) throw new ApiError("not_ready", 409, `entity is ${rec.status}`);
    return rec.pocketAddress as Address;
  };
  const takeBudget = () => {
    if (!ab.budget.take()) throw new ApiError("unavailable", 503, "AgentBook is busy; try again in a minute");
  };
  const tenantPrefix = (t: string) => t.slice(0, 10);

  app.post("/entities/:id/agentbook/session", auth, limit, async (c) => {
    const tenantId = c.get("tenantId");
    const rec = ownedEntity(c.req.param("id"), tenantId);
    requireOrb(tenantId);
    const pocket = requirePocket(rec);
    if (ab.repo.countLifetime(rec.idempotencyKey) >= ab.caps.perEntityLifetime)
      throw new ApiError("limit_exceeded", 429, "this agent has reached its AgentBook registration limit");
    if (ab.repo.countSessionsSince(tenantId, now() - 3_600_000) >= ab.caps.perTenantPerHour)
      throw new ApiError("limit_exceeded", 429, "too many vouch attempts this hour");
    takeBudget();
    let nonce: bigint;
    try {
      nonce = await ab.registrar.getNextNonce(pocket);
    } catch (e) {
      opsLog("agentbook_session_unavailable", { entity: rec.idempotencyKey, errorName: e instanceof Error ? e.name : "unknown" });
      throw new ApiError("unavailable", 503, "could not read AgentBook");
    }
    const sessionId = randomUUID();
    const row = ab.repo.createSession({
      sessionId, entityKey: rec.idempotencyKey, tenantId, address: pocket,
      nonce: nonce.toString(), expiresAt: now() + SESSION_TTL_MS,
    });
    const priorVouches = ab.repo.countConfirmedForTenant(tenantId);
    return c.json({
      sessionId, appId: AGENTBOOK_APP_ID, action: AGENTBOOK_ACTION,
      signal: buildSignal(pocket, nonce), nonce: nonce.toString(), pocketAddress: pocket,
      agentId: rec.agentId, expiresAt: row.expiresAt, network: ab.network, priorVouches,
    });
  });

  app.post("/entities/:id/agentbook/register", auth, limit, async (c) => {
    const tenantId = c.get("tenantId");
    const rec = ownedEntity(c.req.param("id"), tenantId);
    requireOrb(tenantId);
    const pocket = requirePocket(rec);
    const body = RegisterBody.parse(await c.req.json());
    const row = ab.repo.findBySession(body.sessionId);
    if (!row || row.tenantId !== tenantId || row.entityKey !== rec.idempotencyKey || row.status !== "pending")
      throw new ApiError("conflict", 409, "no open session for this agent; start again");
    if (row.expiresAt < now()) {
      ab.repo.transition(row.sessionId, "pending", "expired");
      throw new ApiError("conflict", 409, "session expired; start again");
    }
    if (BigInt(body.nonce) !== BigInt(row.nonce)) throw new ApiError("conflict", 409, "nonce mismatch; start again");
    takeBudget();
    let chainNonce: bigint;
    try {
      chainNonce = await ab.registrar.getNextNonce(pocket);
    } catch {
      throw new ApiError("unavailable", 503, "could not read AgentBook");
    }
    if (chainNonce !== BigInt(row.nonce)) throw new ApiError("conflict", 409, "the registry moved; start again");
    const args = {
      agent: pocket, root: BigInt(body.root), nonce: BigInt(body.nonce),
      nullifierHash: BigInt(body.nullifierHash), proof: body.proof.map((p) => BigInt(p)),
    };
    try {
      await ab.registrar.simulateRegister(args);
    } catch (e) {
      if (e instanceof ContractRevertError) {
        const errorName = e.errorName ?? "revert";
        ab.repo.bumpAttempt(row.sessionId, errorName);
        opsLog("agentbook_proof_rejected", { entity: rec.idempotencyKey, tenantPrefix: tenantPrefix(tenantId), errorName });
        throw new ApiError("proof_rejected", 400, "AgentBook rejected the registration", { errorName });
      }
      opsLog("agentbook_simulate_unavailable", { entity: rec.idempotencyKey, errorName: e instanceof Error ? e.name : "unknown" });
      throw new ApiError("unavailable", 503, "could not simulate the registration");
    }
    if ((await ab.registrar.submitterBalance()) === 0n) {
      opsLog("agentbook_submitter_low", { entity: rec.idempotencyKey });
      throw new ApiError("unavailable", 503, "registrations are paused");
    }
    const signed = await ab.registrar.signRegister(args);
    const nullifier = `0x${BigInt(body.nullifierHash).toString(16)}`;
    const claim = ab.repo.claimSubmit(row.sessionId, { nullifier, rawTx: signed.rawTx, submitterNonce: signed.submitterNonce });
    if (claim === "inflight") throw new ApiError("conflict", 409, "a registration for this agent is already in flight");
    if (claim === "lost") throw new ApiError("conflict", 409, "session already used");
    let txHash: string | null = null;
    try {
      txHash = await ab.registrar.broadcast(signed.rawTx);
      ab.repo.setTxHash(row.sessionId, txHash);
    } catch (e) {
      // Persisted before broadcast: the reconciler re-broadcasts the same raw tx (§6 rule 4).
      opsLog("agentbook_broadcast_unavailable", { entity: rec.idempotencyKey, errorName: e instanceof Error ? e.name : "unknown" });
    }
    opsLog("agentbook_submitted", { entity: rec.idempotencyKey, tenantPrefix: tenantPrefix(tenantId), txHash });
    return c.json({ status: "submitted" as const, txHash });
  });

  app.get("/entities/:id/agentbook", auth, async (c) => {
    const tenantId = c.get("tenantId");
    const rec = ownedEntity(c.req.param("id"), tenantId);
    if (!rec.pocketAddress) return c.json({ registered: false, reason: "no-pocket-yet", outcome: "unregistered", disputed: false });
    const address = rec.pocketAddress;
    let row = ab.repo.latestForEntity(rec.idempotencyKey);
    if (row && (row.status === "pending" || row.status === "submitted"))
      row = await reconcileRow(row, { repo: ab.repo, registrar: ab.registrar, store: ab.store, now, log: opsLog });
    let humanId: string | null | undefined;
    try {
      humanId = await ab.reader.lookupHuman(address);
    } catch {
      humanId = undefined;
    }
    const disputed = row?.status === "disputed" || (humanId != null && row?.nullifier != null && humanId.toLowerCase() !== row.nullifier.toLowerCase() && row.status === "confirmed");
    const outcome = disputed ? "disputed" : humanId === undefined ? "unknown" : humanId === null ? "unregistered" : "registered";
    return c.json({
      registered: outcome === "registered", ...(humanId ? { humanId } : {}), address, outcome, disputed,
      ...(row ? { status: row.status as AgentBookStatus, txHash: row.txHash } : {}),
    });
  });
}
```

`ab.repo.countConfirmedForTenant(tenantId)` is the repository method added in Task 2 ("confirmed vouches from this tenant"); the guardian's World ID pseudonym for OUR action differs from their AgentBook pseudonym, so a per-tenant count is the honest number for the "already vouched for N agents" line.

`world.store.findByTenant(tenantId, action)` returns the stored verification row; confirm the `credential` property name in `src/persistence/worldStore.ts` (it is what `/world-id/me` returns as `credential`, `routes/worldId.ts:463`).

- [ ] **Step 5: Delete the old GET from `worldId.ts`, wire `app.ts` and `main.ts`**

In `src/api/routes/worldId.ts` delete the block starting at the comment `// ── AgentBook standing for an agent (W9.3)` through the end of that `app.get("/entities/:id/agentbook", …)` handler (lines 415-455). Remove the now-unused `createAgentBookVerifier` import if any.

In `src/api/app.ts`:

```ts
import { mountAgentBookRoutes } from "./routes/agentBook";
// in ApiDeps, after `worldId?:`
  /** AgentBook registration (design 2026-08-25 v3). Present iff canRegisterAgentBook(cfg). */
  agentBook?: import("./routes/agentBook").AgentBookDeps;
// in /config
      agentBookRegistrationAvailable: Boolean(deps.agentBook),
// after mountWorldIdRoutes(app, deps);
  mountAgentBookRoutes(app, deps);
```

In `src/api/main.ts`, after the `x402Demo` block (line ~514):

```ts
  // AgentBook registration (design 2026-08-25 v3). One predicate shared with the env.ts
  // invariants and GET /config, so the boot gate and the advertised availability cannot drift.
  const agentBook = canRegisterAgentBook(cfg)
    ? {
        registrar: createAgentBookRegistrar({
          submitterPrivateKey: cfg.agentBook!.submitterPrivateKey,
          readRpcUrl: cfg.worldChain.rpcUrl,
          writeRpcUrl: cfg.agentBook!.rpcUrl,
          contractAddress: cfg.worldChain.agentBook as Address,
        }),
        repo: new SqliteAgentBookRepository(db),
        reader: createAgentBookReader({ rpcUrl: cfg.worldChain.rpcUrl, contractAddress: cfg.worldChain.agentBook as Address }),
        store: new SqliteWorldStore(db),
        network: cfg.arcNetwork ?? "testnet",
        caps: { perEntityLifetime: 3, perTenantPerHour: 5 },
        budget: new TokenBucket(30, 0.5),
      }
    : undefined;
  if (agentBook) {
    const r = await reconcileAgentBook({ repo: agentBook.repo, registrar: agentBook.registrar, store: agentBook.store, log: opsLog });
    console.log(`AgentBook reconcile at boot: ${r.checked} checked, ${r.changed} changed`);
  }
```

and pass `agentBook,` into `buildApiApp({...})`. Add the imports (`canRegisterAgentBook`, `createAgentBookRegistrar`, `SqliteAgentBookRepository`, `createAgentBookReader`, `TokenBucket`, `reconcileAgentBook`). `Address` is already imported from viem in `main.ts`; if not, add it.

- [ ] **Step 6: Run the whole backend suite, lint, typecheck**

Run: `cd back/backend && npm test && npm run lint && npm run typecheck`
Expected: all green, including the rewritten `agentBookRoute.test.ts`. If `hono/body-limit` is not resolvable, use `import { bodyLimit } from "hono/body-limit"` exactly; the middleware ships in the installed hono (`node_modules/hono/dist/middleware/body-limit/index.js`).

- [ ] **Step 7: Commit**

```bash
git add back/backend/src/api/routes/agentBook.ts back/backend/src/api/routes/worldId.ts back/backend/src/api/app.ts back/backend/src/api/main.ts back/backend/src/persistence/agentBookRepository.ts back/backend/test/api/agentBookRoute.test.ts back/backend/test/api/agentBookRegistration.test.ts back/backend/test/persistence/agentBookRepository.test.ts
git commit -m "feat(agentbook): session, register and status routes with caps, redaction and reconcile-on-read (design v3 §4.5, §4.7)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: AgentKit signer on World Chain; our seller advertises both chains (D10)

**Files:**
- Modify: `back/backend/src/payments/entityPayment.ts:145,152` (`cfg.chainId` → `AGENT_BOOK_CHAIN_ID` for the two `agentkit` signers only; the x402 signer is untouched)
- Modify: `back/backend/src/api/routes/x402Demo.ts:129` (`chainIdOf(deps.network)` → `AGENT_BOOK_CHAIN_ID` for the proof-key signer)
- Modify: `back/backend/src/payments/worldVerifier.ts:75-95` (`mintAgentkitExtension` advertises `[cfg.network, AGENT_BOOK_CAIP2]`)
- Modify: `back/backend/src/api/main.ts:511` (`rpcUrls` gains `"eip155:480": cfg.worldChain.rpcUrl`)
- Test: `back/backend/test/payments/agentkitChains.test.ts`

**Interfaces:**
- Consumes: `AGENT_BOOK_CHAIN_ID`, `AGENT_BOOK_CAIP2` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// back/backend/test/payments/agentkitChains.test.ts
import { expect, test } from "vitest";
import { agentkitSignerFromKey } from "../../src/adapters/worldid/agentkitSigner";
import { AGENT_BOOK_CAIP2, AGENT_BOOK_CHAIN_ID } from "../../src/payments/agentBookReader";
import { mintAgentkitExtension } from "../../src/payments/worldVerifier";

test("the seller's 402 advertises Arc AND World Chain, EIP-191 and ERC-1271 each", async () => {
  const ext = (await mintAgentkitExtension({
    domain: "api.example",
    resourceUrl: "https://api.example/x402-demo/paid",
    network: "eip155:5042002",
    allowancePerHuman: 3,
  })) as { agentkit: { supportedChains: Array<{ chainId: string; type: string }> } };
  const chains = ext.agentkit.supportedChains.map((c) => `${c.chainId}/${c.type}`);
  expect(chains).toContain("eip155:5042002/eip191");
  expect(chains).toContain(`${AGENT_BOOK_CAIP2}/eip191`);
  expect(chains).toContain(`${AGENT_BOOK_CAIP2}/eip1271`);
});

test("a pocket signer built for AgentBook announces eip155:480", () => {
  const s = agentkitSignerFromKey(`0x${"7".repeat(64)}`, AGENT_BOOK_CHAIN_ID);
  expect(s.chainId).toBe("eip155:480");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd back/backend && npx vitest run test/payments/agentkitChains.test.ts`
Expected: FAIL on the first assertion for `eip155:480` (only Arc is advertised today).

- [ ] **Step 3: Implement**

`worldVerifier.ts`, in `mintAgentkitExtension`: change `network: cfg.network` in the `declareAgentkitExtension` call to `network: [cfg.network, AGENT_BOOK_CAIP2]` (the SDK accepts a string or an array; verified in `agentkit/dist/cjs/index.js` `declareAgentkitExtension`). Import `AGENT_BOOK_CAIP2` from `./agentBookReader`. Update the doc comment on `network` in `AgentkitSellerConfig`: "CAIP-2 of the paid route's chain (Arc); World Chain is always advertised beside it because every AgentKit client in the wild signs for `eip155:480` (design v3 D10)".

`entityPayment.ts`: import `AGENT_BOOK_CHAIN_ID` from `./agentBookReader`; in `pocketSigners` replace `circleAgentkitSigner(api, ref, cfg.chainId)` with `circleAgentkitSigner(api, ref, AGENT_BOOK_CHAIN_ID)` and `agentkitSignerFromKey(pocketKey, cfg.chainId)` with `agentkitSignerFromKey(pocketKey, AGENT_BOOK_CHAIN_ID)`. Add a comment: "EIP-191 is chain-agnostic for a key; the chain id only selects the RPC a seller verifies against, and sellers advertise World Chain (D10)".

`x402Demo.ts:129`: `agentkitSignerFromKey(deps.proofAgentKey, AGENT_BOOK_CHAIN_ID)`.

`main.ts:511`: `rpcUrls: { [x402Demo.network]: cfg.rpcUrl, "eip155:480": cfg.worldChain.rpcUrl },`.

- [ ] **Step 4: Run the payments and x402 suites, lint, typecheck**

Run: `cd back/backend && npx vitest run test/payments test/api && npm run lint && npm run typecheck`
Expected: PASS. If an existing seller test pins `supportedChains` to exactly one entry, update that expectation to the two-chain list and cite D10 in the test comment.

- [ ] **Step 5: Commit**

```bash
git add back/backend/src/payments/entityPayment.ts back/backend/src/payments/worldVerifier.ts back/backend/src/api/routes/x402Demo.ts back/backend/src/api/main.ts back/backend/test/payments/agentkitChains.test.ts
git commit -m "feat(agentkit): sign for eip155:480 and advertise World Chain beside Arc (design v3 D10)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Interface API layer: types, client, hooks, config flag

**Files:**
- Modify: `interface/src/lib/api/types.ts` (`PublicConfig`, new `AgentBookStatusView`, `AgentBookSessionView`, `AgentBookRegisterBody`)
- Modify: `interface/src/lib/api/client.ts:309-325` (`entityAgentBook` return type; add `agentBookSession`, `agentBookRegister`)
- Modify: `interface/src/lib/api/hooks.ts:216-224` (invalidate on mutation; add two mutation hooks)

**Interfaces:**
- Produces:

```ts
export type AgentBookOutcome = "registered" | "unregistered" | "unknown" | "disputed";
export type AgentBookRowStatus = "pending" | "submitted" | "confirmed" | "disputed" | "failed" | "expired";
export type AgentBookStatusView = {
  registered: boolean; humanId?: string; address?: string;
  reason?: "not registered" | "no-operator-yet" | "no-pocket-yet";
  outcome?: AgentBookOutcome; status?: AgentBookRowStatus; txHash?: string | null; disputed?: boolean;
};
export type AgentBookSessionView = {
  sessionId: string; appId: string; action: string; signal: `0x${string}`; nonce: string;
  pocketAddress: `0x${string}`; agentId: string; expiresAt: number; network: "testnet" | "mainnet"; priorVouches: number;
};
export type AgentBookRegisterBody = { sessionId: string; root: string; nonce: string; nullifierHash: string; proof: string[] };
export function agentBookSession(token: string, id: string): Promise<AgentBookSessionView>;
export function agentBookRegister(token: string, id: string, body: AgentBookRegisterBody): Promise<{ status: "submitted"; txHash: string | null }>;
export function useAgentBookSessionMutation(entityId: string);
export function useAgentBookRegisterMutation(entityId: string);
```

- [ ] **Step 1: Types**

In `types.ts`, add the four types above next to `WorldIdMe`, and in `PublicConfig` add:

```ts
  /** AgentBook registration (design 2026-08-25 v3). Optional for deploy-order safety: absent means
   *  the backend predates the feature, i.e. unavailable. */
  agentBookRegistrationAvailable?: boolean;
```

- [ ] **Step 2: Client**

Replace the inline return type of `entityAgentBook` with `Promise<AgentBookStatusView>` (keep the doc comment) and add:

```ts
/** Start a vouch: the backend reads the registry nonce and records a pending session. */
export function agentBookSession(token: string, id: string): Promise<AgentBookSessionView> {
  return request(`/entities/${encodeURIComponent(id)}/agentbook/session`, { token, body: {} });
}

/** Hand the World ID proof to the backend, which submits the registration on World Chain. */
export function agentBookRegister(
  token: string,
  id: string,
  body: AgentBookRegisterBody,
): Promise<{ status: "submitted"; txHash: string | null }> {
  return request(`/entities/${encodeURIComponent(id)}/agentbook/register`, { token, body });
}
```

- [ ] **Step 3: Hooks**

Below `useEntityAgentBookQuery` add:

```ts
export function useAgentBookSessionMutation(entityId: string) {
  const token = useAuthToken();
  return useMutation({
    mutationFn: () => agentBookSession(token!, entityId),
  });
}

export function useAgentBookRegisterMutation(entityId: string) {
  const token = useAuthToken();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentBookRegisterBody) => agentBookRegister(token!, entityId, body),
    onSettled: () => qc.invalidateQueries({ queryKey: apiKeys.entityAgentBook(token ?? "", entityId) }),
  });
}
```

Import `agentBookSession`, `agentBookRegister` from `./client`, `AgentBookRegisterBody` from `./types`, and `useQueryClient` from `@tanstack/react-query` if not already imported (check the existing mutation hooks at lines 277-300 and follow their exact pattern for `useQueryClient` and `apiKeys`).

- [ ] **Step 4: Typecheck and lint**

Run: `cd interface && npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add interface/src/lib/api/types.ts interface/src/lib/api/client.ts interface/src/lib/api/hooks.ts
git commit -m "feat(interface): AgentBook session/register client and hooks, config flag (design v3 §4.5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Claims ceiling on prod: chip states, personhood copy, TenantRecord waiver, frame-ancestors

**Files:**
- Modify: `interface/src/components/agents/AgentDashboard.tsx:191-221`
- Modify: `interface/src/app/personhood/page.tsx:64-71`
- Modify: `interface/src/components/agents/TenantRecord.tsx:31-56`
- Modify: `interface/next.config.ts`

- [ ] **Step 1: Replace the chip block**

Replace lines 191-221 of `AgentDashboard.tsx` (the `{agentBook && (<span …>…</span>)}` block) with:

```tsx
            {agentBook && (() => {
              const outcome =
                agentBook.outcome ??
                (agentBook.registered ? "registered" : "unregistered");
              const label =
                outcome === "registered"
                  ? "Vouched in AgentBook ↗"
                  : outcome === "disputed"
                    ? "Disputed in AgentBook"
                    : outcome === "unknown"
                      ? "AgentBook · could not check"
                      : agentBook.reason === "no-pocket-yet" || agentBook.reason === "no-operator-yet"
                        ? "AgentBook · provisioning"
                        : "Not in AgentBook";
              const title =
                outcome === "registered"
                  ? "A World ID verified human has vouched for this agent's payment address in AgentBook."
                  : outcome === "disputed"
                    ? "Someone else has replaced the vouch for this address in AgentBook."
                    : outcome === "unknown"
                      ? "AgentBook could not be reached; this is not a statement about the registration."
                      : "No AgentBook entry for this agent's payment address.";
              const href =
                outcome === "registered" && agentBook.txHash
                  ? `https://worldscan.org/tx/${agentBook.txHash}`
                  : undefined;
              const cls =
                "inline-flex items-center gap-1.5 rounded-full border hairline-strong bg-paper-3/60 px-3 py-1.5 text-[11.5px] text-muted-2";
              return href ? (
                <a href={href} target="_blank" rel="noreferrer" title={title} className={cls}>
                  {label}
                </a>
              ) : (
                <span title={title} className={cls}>{label}</span>
              );
            })()}
```

Neutral styling on every state (D9): no emerald, no dot.

- [ ] **Step 2: Personhood page copy**

In `personhood/page.tsx:64-71`, replace the sentence that mentions `the dashboard "human-backed" chip` and "sellers can see an accountable buyer backed by a verified human" with:

> Sellers who check World's AgentBook can see whether a World ID verified human has vouched for this agent's payment address. The agent dashboard shows "Vouched in AgentBook" when one has.

- [ ] **Step 3: TenantRecord waiver branch**

In `TenantRecord.tsx`, after `const verified = me?.verified ?? false;` add `const waiver = me?.credential === "waiver";` and change the badge to:

```tsx
                className={cx(
                  "rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em]",
                  verified && !waiver
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                    : waiver
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
                      : "border-line-strong bg-paper-3/70 text-muted-2",
                )}
              >
                {verified && !waiver ? "Human-backed" : waiver ? "Admin waiver" : "No human on record"}
```

Match the exact amber classes `GuardianRecord.tsx:127-141` already uses so the two cards agree.

- [ ] **Step 4: frame-ancestors**

`interface/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 5: Typecheck, lint, and look at it**

Run: `cd interface && npx tsc --noEmit && npm run lint && npm run build`
Expected: clean build. Open the agent dashboard locally against a backend without `WORLDCHAIN_SUBMITTER_PRIVATE_KEY`: the chip reads "Not in AgentBook" in neutral styling, and the account page shows an amber "Admin waiver" badge for a waiver tenant.

- [ ] **Step 6: Commit**

```bash
git add interface/src/components/agents/AgentDashboard.tsx interface/src/app/personhood/page.tsx interface/src/components/agents/TenantRecord.tsx interface/next.config.ts
git commit -m "fix(interface): AgentBook chip and account badge under the claims ceiling; frame-ancestors (design v3 §5.4, D9)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The vouch dialog: v2 bridge, QR and deeplink, local signal check, address pin

**Files:**
- Modify: `interface/package.json` (dependency alias)
- Create: `interface/src/lib/agentbook/signal.ts`, `interface/src/lib/agentbook/proof.ts`, `interface/src/lib/agentbook/pin.ts`
- Create: `interface/src/components/agents/VouchDialog.tsx`
- Modify: `interface/src/components/agents/AgentDashboard.tsx` (button next to the chip)
- Test: `interface/src/lib/agentbook/signal.test.ts`, `proof.test.ts`, `pin.test.ts`

**Interfaces:**
- Consumes: Task 7 hooks and types; `useWorldIdMeQuery` (credential), `usePublicConfigQuery` (`agentBookRegistrationAvailable`); `qrcode` (`toDataURL`); `idkit-core-v2` (`createWorldBridgeStore`, `solidityEncode` from `idkit-core-v2/hashing`).
- Produces: `buildSignal(address, nonce): 0x…` (52 bytes), `normalizeProof(raw): string[] | null`, `readPin/writePin`, `<VouchDialog entityId agentId open onClose />`.

- [ ] **Step 1: Install the pinned bridge under an alias**

In `interface/package.json` dependencies add exactly:

```json
"idkit-core-v2": "npm:@worldcoin/idkit-core@2.1.0",
```

Run: `cd interface && npm install && npm ls idkit-core-v2 zustand ox`
Expected: `idkit-core-v2@npm:@worldcoin/idkit-core@2.1.0` resolves; duplicate `zustand@4` and `ox@0.1` appear under it (accepted, design v3 §4.6). Commit the lockfile change with this task.

- [ ] **Step 2: Write the failing helper tests**

```ts
// interface/src/lib/agentbook/signal.test.ts
import { describe, expect, test } from "vitest";
import { buildSignal } from "./signal";

describe("buildSignal", () => {
  test("matches the backend golden vector: address ++ uint256, packed, 52 bytes", () => {
    const sig = buildSignal("0x1111111111111111111111111111111111111111", "1");
    expect(sig).toBe(`0x${"11".repeat(20)}${"00".repeat(31)}01`);
  });
  test("accepts the nonce as a decimal string and normalises address case", () => {
    expect(buildSignal("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", "255")).toBe(
      `0x${"abcdefabcdefabcdefabcdefabcdefabcdefabcd"}${"00".repeat(31)}ff`,
    );
  });
});
```

```ts
// interface/src/lib/agentbook/proof.test.ts
import { encodeAbiParameters } from "viem";
import { describe, expect, test } from "vitest";
import { normalizeProof } from "./proof";

describe("normalizeProof", () => {
  test("a JSON array of 8 strings passes through", () => {
    const arr = Array.from({ length: 8 }, (_, i) => `0x${i + 1}`);
    expect(normalizeProof(JSON.stringify(arr))).toEqual(arr);
  });
  test("an ABI-encoded uint256[8] is decoded to 8 padded hex words", () => {
    const enc = encodeAbiParameters([{ type: "uint256[8]" }], [[1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]]);
    const out = normalizeProof(enc);
    expect(out).toHaveLength(8);
    expect(out?.[0]).toBe(`0x${"0".repeat(63)}1`);
  });
  test("garbage is null", () => {
    expect(normalizeProof("0xzz")).toBeNull();
    expect(normalizeProof("[1,2]")).toBeNull();
  });
});
```

```ts
// interface/src/lib/agentbook/pin.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import { checkPin } from "./pin";

describe("checkPin (trust on first use)", () => {
  beforeEach(() => localStorage.clear());
  test("first sight pins; same address later is fine; a different address is flagged", () => {
    expect(checkPin("agent-1", "0xaaa")).toBe("pinned");
    expect(checkPin("agent-1", "0xaaa")).toBe("match");
    expect(checkPin("agent-1", "0xbbb")).toBe("changed");
  });
  test("storage failures degrade to 'unavailable'", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    expect(checkPin("agent-1", "0xaaa")).toBe("unavailable");
    Storage.prototype.getItem = orig;
  });
});
```

The interface `vitest.config.ts` must use a DOM environment for `pin.test.ts`; if it is `node`, add `// @vitest-environment jsdom` as the first line of that test file and `npm i -D jsdom` if absent.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd interface && npx vitest run src/lib/agentbook`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write the helpers**

```ts
// interface/src/lib/agentbook/signal.ts
import { encodePacked, getAddress } from "viem";

/** `abi.encodePacked(address, uint256)`, 52 bytes. Must byte-equal the backend's `buildSignal`
 *  (design v3 D8): the dialog recomputes it and refuses a session whose signal differs. */
export function buildSignal(address: string, nonce: string): `0x${string}` {
  return encodePacked(["address", "uint256"], [getAddress(address), BigInt(nonce)]);
}
```

```ts
// interface/src/lib/agentbook/proof.ts
import { decodeAbiParameters } from "viem";

/** World's bridge returns the proof either as a JSON array of 8 strings or as an ABI-encoded
 *  `uint256[8]` blob; World's own CLI handles both (cli/src/index.ts at 434407c). */
export function normalizeProof(raw: string): string[] | null {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length === 8 ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  try {
    const [decoded] = decodeAbiParameters([{ type: "uint256[8]" }], raw as `0x${string}`);
    return decoded.map((v) => `0x${v.toString(16).padStart(64, "0")}`);
  } catch {
    return null;
  }
}
```

```ts
// interface/src/lib/agentbook/pin.ts
/** Trust-on-first-use pin of an agent's payment address in this browser (design v3 D8). It cannot
 *  catch a backend that lied from the start; it does catch a backend that starts lying later. */
export type PinResult = "pinned" | "match" | "changed" | "unavailable";

const key = (entityId: string) => `novi.agentbook.pocket.${entityId}`;

export function checkPin(entityId: string, address: string): PinResult {
  try {
    const seen = localStorage.getItem(key(entityId));
    const now = address.toLowerCase();
    if (!seen) {
      localStorage.setItem(key(entityId), now);
      return "pinned";
    }
    return seen === now ? "match" : "changed";
  } catch {
    return "unavailable";
  }
}
```

- [ ] **Step 5: Run the helper tests**

Run: `cd interface && npx vitest run src/lib/agentbook`
Expected: PASS.

- [ ] **Step 6: Write the dialog**

```tsx
// interface/src/components/agents/VouchDialog.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ApiError } from "@/lib/api/types";
import {
  useAgentBookRegisterMutation,
  useAgentBookSessionMutation,
  useWorldIdMeQuery,
} from "@/lib/api/hooks";
import type { AgentBookSessionView } from "@/lib/api/types";
import { normalizeProof } from "@/lib/agentbook/proof";
import { checkPin } from "@/lib/agentbook/pin";
import { buildSignal } from "@/lib/agentbook/signal";
import { Button, Spinner, cx } from "../primitives";

type Phase =
  | { kind: "confirm" }
  | { kind: "starting" }
  | { kind: "awaiting"; session: AgentBookSessionView; connectorURI: string; qr: string; deadline: number }
  | { kind: "submitting" }
  | { kind: "vouched"; txHash: string | null }
  | { kind: "failed"; message: string; retryable: boolean };

const ORB = new Set(["orb", "proof_of_human"]);
const POLL_MS = 1_000;
const TIMEOUT_MS = 300_000;

export const NOT_ELIGIBLE_COPY =
  "AgentBook vouching needs a World ID from an Orb. Your access here is unaffected. AgentBook is World's public registry and only accepts Orb-verified proofs. There is nothing we can substitute for that, and we will not fake it.";

export function VouchDialog(props: {
  entityId: string;
  agentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const me = useWorldIdMeQuery();
  const session = useAgentBookSessionMutation(props.entityId);
  const register = useAgentBookRegisterMutation(props.entityId);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const [accepted, setAccepted] = useState(false);
  const [details, setDetails] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!props.open) {
      cancelled.current = true;
      setPhase({ kind: "confirm" });
      setAccepted(false);
    } else {
      cancelled.current = false;
    }
  }, [props.open]);

  if (!props.open) return null;
  const credential = me.data?.credential ?? null;
  const eligible = credential !== null && ORB.has(credential);

  async function start() {
    setPhase({ kind: "starting" });
    let s: AgentBookSessionView;
    try {
      s = await session.mutateAsync();
    } catch (e) {
      setPhase({ kind: "failed", message: messageOf(e), retryable: true });
      return;
    }
    // D8: recompute the signal locally and refuse a session whose signal differs.
    if (buildSignal(s.pocketAddress, s.nonce) !== s.signal) {
      setPhase({ kind: "failed", message: "The server's request did not match this agent's payment address. Nothing was signed.", retryable: false });
      return;
    }
    if (checkPin(props.entityId, s.pocketAddress) === "changed") {
      setPhase({ kind: "failed", message: "This agent's payment address differs from the one this browser saw before. Nothing was signed. Check the address on Arcscan before trying again.", retryable: false });
      return;
    }
    // The v2 bridge, loaded only here (design v3 §4.6): never on the server, never on page load.
    const [{ createWorldBridgeStore }, { solidityEncode }] = await Promise.all([
      import("idkit-core-v2"),
      import("idkit-core-v2/hashing"),
    ]);
    const bridge = createWorldBridgeStore();
    await bridge.getState().createClient({
      app_id: s.appId,
      action: s.action,
      signal: solidityEncode(["address", "uint256"], [s.pocketAddress, s.nonce]),
    });
    const connectorURI = bridge.getState().connectorURI;
    if (!connectorURI) {
      setPhase({ kind: "failed", message: "World App could not be reached. Nothing was signed.", retryable: true });
      return;
    }
    const qr = await QRCode.toDataURL(connectorURI, { margin: 1, width: 240 });
    const deadline = Date.now() + Math.min(TIMEOUT_MS, s.expiresAt - Date.now());
    setPhase({ kind: "awaiting", session: s, connectorURI, qr, deadline });

    while (Date.now() < deadline && !cancelled.current) {
      await bridge.getState().pollForUpdates();
      const { result, errorCode } = bridge.getState();
      if (errorCode) {
        setPhase({ kind: "failed", message: `World App declined: ${errorCode}`, retryable: true });
        return;
      }
      if (result) {
        const proof = normalizeProof(result.proof);
        if (!proof) {
          setPhase({ kind: "failed", message: "World App returned a proof in an unexpected format.", retryable: true });
          return;
        }
        setPhase({ kind: "submitting" });
        try {
          const out = await register.mutateAsync({
            sessionId: s.sessionId,
            root: result.merkle_root,
            nonce: s.nonce,
            nullifierHash: result.nullifier_hash,
            proof,
          });
          setPhase({ kind: "vouched", txHash: out.txHash });
        } catch (e) {
          setPhase({ kind: "failed", message: messageOf(e), retryable: e instanceof ApiError && e.code !== "proof_rejected" });
        }
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!cancelled.current)
      setPhase({ kind: "failed", message: "Timed out waiting for World App. Nothing was written.", retryable: true });
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-2xl border hairline bg-paper-2 p-6">
        <h2 className="text-[20px] font-medium text-ink">Vouch for this agent in AgentBook</h2>

        {!eligible && (
          <p className="mt-4 text-[13.5px] text-muted-1">{NOT_ELIGIBLE_COPY}</p>
        )}

        {eligible && phase.kind === "confirm" && (
          <ConfirmBody
            agentId={props.agentId}
            accepted={accepted}
            onAccepted={setAccepted}
            details={details}
            onDetails={setDetails}
          />
        )}

        {phase.kind === "starting" && <Line><Spinner /> Preparing the request…</Line>}

        {phase.kind === "awaiting" && (
          <div className="mt-4 flex flex-col items-center gap-3">
            <img src={phase.qr} alt="World App QR code" width={240} height={240} />
            <a className="text-[13px] underline" href={phase.connectorURI}>Open in World App</a>
            <p className="text-[12.5px] text-muted-2">Approving in World App completes a public vouch.</p>
            <Countdown deadline={phase.deadline} />
            <p className="text-[12px] text-muted-2">
              Payment address <code>{phase.session.pocketAddress}</code> · agent #{phase.session.agentId}
              {phase.session.network === "testnet" && " · This agent runs on Arc testnet. The vouch is on World Chain mainnet and is just as permanent."}
              {phase.session.priorVouches > 0 && ` · You have already vouched for ${phase.session.priorVouches} agents from this account. This vouch will be publicly linkable to them.`}
            </p>
          </div>
        )}

        {phase.kind === "submitting" && <Line><Spinner /> Writing the registration on World Chain…</Line>}

        {phase.kind === "vouched" && (
          <p className="mt-4 text-[13.5px] text-ink">
            Registration submitted.{" "}
            {phase.txHash ? (
              <a className="underline" href={`https://worldscan.org/tx/${phase.txHash}`} target="_blank" rel="noreferrer">View the transaction</a>
            ) : (
              "We are confirming it with the registry and will update the dashboard."
            )}
          </p>
        )}

        {phase.kind === "failed" && (
          <p className="mt-4 text-[13.5px] text-amber-300">{phase.message}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>{phase.kind === "vouched" ? "Close" : "Cancel"}</Button>
          {eligible && phase.kind === "confirm" && (
            <Button disabled={!accepted} onClick={start}>Vouch permanently</Button>
          )}
          {phase.kind === "failed" && phase.retryable && (
            <Button onClick={() => setPhase({ kind: "confirm" })}>Try again</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmBody(p: {
  agentId: string;
  accepted: boolean;
  onAccepted: (v: boolean) => void;
  details: boolean;
  onDetails: (v: boolean) => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 text-[13.5px] text-muted-1">
      <p>You are about to publicly vouch for this agent, as a person.</p>
      <p><b>Public, forever.</b> A pseudonym from your World ID is written to a public blockchain next to this agent's payment address (agent #{p.agentId}, the address that pays its x402 invoices). It cannot be removed, by you, by us or by World.</p>
      <p><b>The same pseudonym every time.</b> Anyone can see that every agent you vouch for in AgentBook, here or anywhere else, shares one backer, and that Novi Corpus submitted it.</p>
      <p><b>Someone else can replace it.</b> Any World ID verified person can vouch for this address and overwrite yours. Your agent's dashboard will show it; we cannot prevent or undo it.</p>
      <p><b>Not a proof of control, not a legal signature.</b> It says one thing: a verified human chose to stand behind this address.</p>
      <p>Novi Corpus pays the network fee. World App will show a request from <b>AgentKit</b>, World's registry app, and may ask for Face Auth. Approving it is the vouch.</p>
      <button type="button" className="self-start text-[12.5px] underline" onClick={() => p.onDetails(!p.details)}>
        {p.details ? "Details ▴" : "Details ▾"}
      </button>
      {p.details && (
        <div className="flex flex-col gap-2 rounded-lg border hairline p-3 text-[12.5px]">
          <p><b>What this does.</b> It writes a record in AgentBook, a public registry on World Chain, saying that a World ID verified human stands behind this agent's payment address. Sellers who check AgentBook will see this agent as human-backed.</p>
          <p><b>What becomes public, forever.</b> A pseudonym derived from your World ID is published on a public blockchain, linked to this address. It does not reveal your name. But it is the same pseudonym every time you vouch in AgentBook, here or anywhere else, so anyone can see that every agent you vouch for shares one backer. The transaction is sent by Novi Corpus, so anyone can also list every address Novi Corpus has vouched for.</p>
          <p><b>You cannot remove this.</b> AgentBook has no removal function. Not you, not us, not World. The record outlives this agent and your account.</p>
          <p><b>Someone else can replace it.</b> AgentBook lets any World ID verified person vouch for any address, including this one, which overwrites the current vouch. Your agent's dashboard shows that state as "disputed"; we cannot prevent it or undo it.</p>
          <p><b>What this does not do.</b> It does not prove you control this address, and it is not a legal signature.</p>
        </div>
      )}
      <label className="mt-2 flex items-start gap-2 text-ink">
        <input type="checkbox" checked={p.accepted} onChange={(e) => p.onAccepted(e.target.checked)} />
        <span>I understand this is public, permanent, and can be replaced by someone else.</span>
      </label>
    </div>
  );
}

function Line(p: { children: React.ReactNode }) {
  return <p className="mt-4 flex items-center gap-2 text-[13.5px] text-muted-1">{p.children}</p>;
}

function Countdown(p: { deadline: number }) {
  const [left, setLeft] = useState(Math.max(0, p.deadline - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, p.deadline - Date.now())), 1000);
    return () => clearInterval(t);
  }, [p.deadline]);
  return <p className="text-[12px] text-muted-2">{Math.ceil(left / 1000)}s left</p>;
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "proof_rejected") return "AgentBook rejected the registration. Nothing was written. This usually means the request expired; start again.";
    if (e.code === "limit_exceeded") return e.message;
    if (e.code === "not_eligible") return NOT_ELIGIBLE_COPY;
    if (e.code === "conflict") return `${e.message}. Nothing was written.`;
    if (e.code === "unavailable") return "AgentBook could not be reached. Nothing was written. Try again in a minute.";
  }
  return "Something went wrong before anything was written. Try again.";
}
```

Check `ApiError` in `@/lib/api/types` exposes `code` and `message` (it does; `GuardianStep.tsx` imports it). Check `Button` supports a `variant="ghost"` prop in `../primitives`; if not, use the existing secondary style the cancel buttons in `GuardianStep.tsx` use. `idkit-core-v2/hashing` exists in 2.1.0 (`exports["./hashing"]`); if TypeScript cannot resolve the subpath, add to `tsconfig.json` `paths`: `"idkit-core-v2/hashing": ["./node_modules/idkit-core-v2/build/hashing.d.ts"]` after checking the actual file name under `node_modules/idkit-core-v2/build/`. `solidityEncode` accepts the nonce as a decimal string.

- [ ] **Step 7: Mount the button**

In `AgentDashboard.tsx`, next to the chip from Task 8, add a button and the dialog. Read `usePublicConfigQuery` (`hooks.ts:82`) for the flag:

```tsx
const config = usePublicConfigQuery();
const [vouchOpen, setVouchOpen] = useState(false);
const canVouch = config.data?.agentBookRegistrationAvailable === true;
const vouchDisabledReason =
  !canVouch ? "Vouching is not enabled on this deployment"
  : agentBook?.reason === "no-pocket-yet" ? "Agent still provisioning — payment wallet not set yet"
  : agentBook?.outcome === "registered" ? "Already vouched"
  : null;
```

```tsx
{entity && (
  <>
    <button
      type="button"
      disabled={vouchDisabledReason !== null}
      title={vouchDisabledReason ?? "Vouch for this agent in AgentBook"}
      onClick={() => setVouchOpen(true)}
      className="rounded-full border hairline-strong bg-paper-3/60 px-3 py-1.5 text-[11.5px] text-ink disabled:opacity-50"
    >
      Vouch in AgentBook
    </button>
    <VouchDialog entityId={entityId} agentId={entity.agentId ?? ""} open={vouchOpen} onClose={() => setVouchOpen(false)} />
  </>
)}
```

The button is shown disabled with the reason, never hidden (design §3 precondition 2). After `disputed`, it is shown again once (the backend's lifetime cap enforces the "once per dispute" rule in the first release).

- [ ] **Step 8: Typecheck, lint, tests, build**

Run: `cd interface && npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: clean. Then run the interface against a local backend with `WORLDCHAIN_SUBMITTER_PRIVATE_KEY` set to a throwaway key and `WORLD_*` configured: the button appears, the dialog opens, the QR renders (do not approve in World App on a dev backend; cancel).

- [ ] **Step 9: Commit**

```bash
git add interface/package.json interface/package-lock.json interface/src/lib/agentbook interface/src/components/agents/VouchDialog.tsx interface/src/components/agents/AgentDashboard.tsx
git commit -m "feat(interface): Vouch in AgentBook dialog on World's v2 bridge with local signal check (design v3 §3, §5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Runbook, submitter funding, the one live registration

**Files:**
- Create: `back/docs/runbooks/agentbook-registration.md`
- Modify: `back/docs/plans/2026-08-11-mainnet-readiness.md` (key table: one row for the submitter)

- [ ] **Step 1: Write the runbook**

```markdown
# Runbook: AgentBook registration

Design: `docs/design/2026-08-25-agentbook-registration-design.md` (v3). Audit: `2026-09-07-agentbook-registration-audit.md`.

## The submitter wallet

- Generate a fresh key (`cast wallet new`). It is `WORLDCHAIN_SUBMITTER_PRIVATE_KEY`. Never reuse
  another key; boot refuses equality with every other configured key.
- Fund the address with 0.005 ETH on World Chain (chain id 480) only. Bridge from Ethereum or
  Base with https://worldchain-mainnet.bridge.alchemy.com or withdraw from an exchange that
  supports World Chain. Never fund this address on any other chain: an EOA key is valid everywhere.
- Set `WORLDCHAIN_SUBMITTER_RPC` to a paid endpoint if the public one throttles (it is separate
  from `WORLD_CHAIN_RPC` on purpose).
- Balance alert: the API logs `agentbook_submitter_low` and returns 503 when the balance is zero.
  Check with `cast balance <address> --rpc-url https://worldchain-mainnet.g.alchemy.com/public`.

## Deploy order

1. PR #98 deployed and verified: `curl -s https://api.novicorpus.com/transparency | grep -c '"credential":"waiver"'`
   entities must show `"humanVerified":false`.
2. Backend with the two variables; `GET /config` shows `agentBookRegistrationAvailable: true`.
3. Interface build with the alias installed.

## The first live registration (one-off, mainnet)

Preconditions: prod backend, `NODE_ENV=production`, the founder's own World ID (Orb), a circle
agent whose `pocketAddress` is stored. The founder accepts that their AgentBook pseudonym is
permanently linked to this agent and to the `/proof` demo key from Lisbon.

1. Open the agent dashboard, press "Vouch in AgentBook", read the dialog, tick the box.
2. Scan the QR with World App. Note whether the request shows "AgentKit" and whether Face Auth
   was requested.
3. Wait for "Registration submitted" and open the transaction on worldscan.org.
4. Record here: date, agent id, pocket address, tx hash, the nullifier (from the row), whether a
   second proof from the same World ID was accepted, and the packed signal (from the session
   response) as the golden vector for `test/world/agentBookRegistrar.test.ts`.
5. Reload the dashboard: the chip must read "Vouched in AgentBook ↗" within one reconcile.

If simulate rejects the proof (`proof_rejected`, error name in the response), the constants in
`agentBookRegistrar.ts` are wrong; nothing was written. Compare with World's CLI at commit
`434407c` before retrying.

## Records

| Date | Agent | Pocket | Tx | Notes |
|---|---|---|---|---|
| | | | | |
```

- [ ] **Step 2: Add the key to the mainnet key table**

In `back/docs/plans/2026-08-11-mainnet-readiness.md`, in the key inventory table (near lines 140-150), add a row: `WORLDCHAIN_SUBMITTER_PRIVATE_KEY | World Chain ETH only, AgentBook registrations | hot, on the API box | refuses equality with every other key`.

- [ ] **Step 3: Commit**

```bash
git add back/docs/runbooks/agentbook-registration.md back/docs/plans/2026-08-11-mainnet-readiness.md
git commit -m "docs(agentbook): registration runbook, submitter funding, the first live vouch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Deferred (not in this plan, design v3 §9)

Reconciler interval in `api/main.ts` (boot reconcile is in Task 5; add `setInterval(() => reconcileAgentBook(deps), 60_000)` with the same shape as the formation sweeper when time allows). `agentBook` and `pocketAddress` on `EntityView` for MCP. Transparency chip in past tense. Monitor rules. The legal-body verifier (separate plan). The sandbox-pointed deployment (ops).

## Self-review

- **Spec coverage.** §3 preconditions 1-6 → Task 5. §4.1 → Task 3. §4.2 → Task 1. §4.3 → Tasks 1, 5. §4.4 → Task 2. §4.5 → Tasks 5, 7. §4.6 → Task 9. §4.7 → Task 5 (validation, caps, logging) and Task 8 (frame-ancestors). §5.1, §5.3 → Task 9 (verbatim copy, one ineligibility message). §5.2 → Tasks 5, 8, 9 (`unknown` outcome, states). §5.4 → Task 8 and the runbook's deploy order. §6 → Task 4. §7 → tests in Tasks 1-6 and 9, live registration in Task 10. D10 → Task 6. Gaps, deliberately deferred per §9: the reconciler interval, `EntityView.agentBook`, transparency chip, monitor rules.
- **Placeholders.** None remain: every step has code, a command, or a verbatim text.
- **Type consistency.** `AgentBookRow`/`AgentBookStatus`/`AgentBookRepository` (Task 2) are what Tasks 4 and 5 import; `AgentBookRegistrar` methods `getNextNonce(agent, blockTag)`, `lookupHuman(agent, blockTag)`, `simulateRegister`, `signRegister`, `broadcast`, `receiptStatus`, `submitterNonce`, `submitterBalance` (Task 3) are the names the Task 4 `ReconcileDeps` pick and the Task 5 test stub use; `TokenBucket(capacity, refillPerSecond)` and `AgentBookDeps` (Task 5) are what `main.ts` builds and the tests construct; `AgentBookSessionView` fields (Task 7) match the session response (Task 5) and the dialog's reads (Task 9); `countConfirmedForTenant` is declared in Task 2 and called in Task 5.

## Execution handoff

Plan complete and saved to `back/docs/plans/2026-09-07-agentbook-registration-plan.md`. Two execution options:

1. **Subagent-driven (recommended):** a fresh Opus subagent per task, Fable review between tasks.
2. **Inline execution:** tasks executed in this session with checkpoints.
