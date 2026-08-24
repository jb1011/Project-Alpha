import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { EntityLookupError } from "./errors";

/**
 * READ-ONLY view of the main legalbody.db.
 *
 * Opened with `{ readonly: true, fileMustExist: true }` — not as a convention but as an
 * enforcement: better-sqlite3 rejects every write statement on such a handle, so no future edit to
 * this process can accidentally mutate the money-path database. The API owns that schema; the
 * monitor only asks it three questions: which treasuries are ours, which agentIds are ours, and
 * what operator/guardian/manager did we record for them.
 *
 * The API writes in WAL mode, so a reader never blocks a writer and vice versa. A busy timeout
 * still guards the checkpoint window; anything longer surfaces as EntityLookupError, which the
 * poll loop logs and retries next tick rather than dying on.
 */

export interface MonitoredEntity {
  idempotencyKey: string;
  publicId: string | null;
  name: string;
  status: string;
  /** decimal string; null before the identity is minted. */
  agentId: string | null;
  manager: string;
  guardian: string;
  operator: string | null;
  treasury: string | null;
  proxy: string | null;
  // ── The OA anchor projection (design §8, audit H3/14). Version NUMBERS alone cannot feed the
  //    compromise rule: it has to compare the hash the CHAIN scheduled against the hash this
  //    deployment says is pending, and a number cannot do that. Read here so the rules stay pure
  //    functions of (log, context).
  /** The manifest version currently ANCHORED on chain, per our records. */
  oaManifestVersion: number | null;
  oaManifestAnchoredHash: string | null;
  /** The single in-flight version (single-pending rule), or null when nothing is pending. */
  oaManifestPendingHash: string | null;
  oaManifestPendingVersion: number | null;
}

export interface EntityLookup {
  /** Every entity with an on-chain footprint (treasury or agentId). */
  all(): MonitoredEntity[];
  close(): void;
}

interface Row {
  idempotency_key: string;
  public_id: string | null;
  name: string;
  status: string;
  agent_id: string | null;
  manager: string;
  guardian: string;
  operator: string | null;
  treasury: string | null;
  proxy: string | null;
  oa_manifest_version: number | null;
  oa_manifest_anchored_hash: string | null;
  oa_manifest_pending_hash: string | null;
  oa_manifest_pending_version: number | null;
}

const SELECT_ALL = `
  SELECT idempotency_key, public_id, name, status, agent_id, manager, guardian, operator, treasury, proxy,
         oa_manifest_version, oa_manifest_anchored_hash,
         oa_manifest_pending_hash, oa_manifest_pending_version
  FROM entities
  WHERE treasury IS NOT NULL OR agent_id IS NOT NULL
  ORDER BY rowid`;

/**
 * Is this SQLite failure the SCHEMA, rather than the moment?
 *
 * The two deserve opposite treatment and the difference is not visible from the message alone
 * unless you look for it, so it is looked for in exactly one place. A locked database is a bad
 * second; a missing column is a monitor pointed at a database the API has not migrated yet, and no
 * amount of retrying will produce the column.
 */
function isSchemaMismatch(err: unknown): boolean {
  return /no such (column|table)/i.test((err as Error)?.message ?? "");
}

/**
 * The STARTUP probe (review F4). Throws — loudly, and naming the deploy order — when the main
 * database does not have the columns this monitor's rules read.
 *
 * The monitor is deliberately forgiving mid-run: a lookup failure degrades the entity-derived
 * rules for one tick and the last known set is reused, because a watcher's whole job is to still
 * be running when the interesting block arrives. That tolerance is exactly wrong at boot. Deploy
 * the monitor before the API on a release that adds a column and every tick logs
 * `monitor_entity_lookup_failed` and carries on with an EMPTY entity set — a monitor that is
 * running, scanning, and silently blind to every treasury and every LegalManager proxy it exists
 * to watch. Silence that looks like health is the one failure mode this process must not have.
 *
 * Called from the composition root, whose `.catch` exits non-zero: systemd restarts it, and it
 * keeps failing until the API has migrated, which is the visible outcome.
 */
export function assertLookupSchema(lookup: EntityLookup): void {
  try {
    lookup.all();
  } catch (err) {
    if (err instanceof EntityLookupError && err.schemaMismatch)
      throw new EntityLookupError(
        [
          `monitor: the main database is missing columns this monitor reads (${err.message}).`,
          "DEPLOY ORDER: restart the API (which migrates the schema on boot) BEFORE the monitor.",
          "Refusing to start blind — a running monitor with an empty entity set watches no treasury and no LegalManager proxy.",
        ].join(" "),
        { cause: err, schemaMismatch: true },
      );
    throw err;
  }
}

export class SqliteEntityLookup implements EntityLookup {
  private db?: Database.Database;

  constructor(
    private readonly path: string,
    private readonly busyTimeoutMs = 5_000,
  ) {}

  private connect(): Database.Database {
    if (this.db) return this.db;
    // fileMustExist would throw SqliteError; check first so the message names the actual problem
    // (a monitor pointed at the wrong DATA_DIR is the likely cause, and it must say so).
    if (!existsSync(this.path))
      throw new EntityLookupError(
        `monitor: main database ${this.path} does not exist — check DATA_DIR (the monitor reads the API's legalbody.db read-only)`,
      );
    try {
      const db = new Database(this.path, { readonly: true, fileMustExist: true });
      db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
      this.db = db;
      return db;
    } catch (err) {
      throw new EntityLookupError(
        `monitor: could not open ${this.path} read-only: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  all(): MonitoredEntity[] {
    let rows: Row[];
    try {
      rows = this.connect().prepare(SELECT_ALL).all() as Row[];
    } catch (err) {
      // Drop the handle: a file replaced under us (restore, litestream recovery) leaves a stale fd
      // that never recovers on its own. Next tick reconnects.
      this.close();
      throw new EntityLookupError(
        `monitor: entity lookup failed against ${this.path}: ${(err as Error).message}`,
        { cause: err, schemaMismatch: isSchemaMismatch(err) },
      );
    }
    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      publicId: r.public_id,
      name: r.name,
      status: r.status,
      agentId: r.agent_id,
      manager: r.manager,
      guardian: r.guardian,
      operator: r.operator,
      treasury: r.treasury,
      proxy: r.proxy,
      oaManifestVersion: r.oa_manifest_version,
      oaManifestAnchoredHash: r.oa_manifest_anchored_hash,
      oaManifestPendingHash: r.oa_manifest_pending_hash,
      oaManifestPendingVersion: r.oa_manifest_pending_version,
    }));
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Closing a handle that is already gone is not an error worth propagating.
    }
    this.db = undefined;
  }
}

/** Index the entity list the way the rules query it. Rebuilt each tick — it is a dozen rows. */
export interface EntityIndex {
  /** lowercased treasury address -> entity */
  byTreasury: Map<string, MonitoredEntity>;
  /** agentId (decimal string) -> entity */
  byAgentId: Map<string, MonitoredEntity>;
  /** lowercased LegalManager proxy address -> entity. The OA amendment rules key off this. */
  byProxy: Map<string, MonitoredEntity>;
}

export function indexEntities(entities: readonly MonitoredEntity[]): EntityIndex {
  const byTreasury = new Map<string, MonitoredEntity>();
  const byAgentId = new Map<string, MonitoredEntity>();
  const byProxy = new Map<string, MonitoredEntity>();
  for (const e of entities) {
    if (e.treasury) byTreasury.set(e.treasury.toLowerCase(), e);
    if (e.agentId) byAgentId.set(e.agentId, e);
    if (e.proxy) byProxy.set(e.proxy.toLowerCase(), e);
  }
  return { byTreasury, byAgentId, byProxy };
}
