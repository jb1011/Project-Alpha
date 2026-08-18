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
}

const SELECT_ALL = `
  SELECT idempotency_key, public_id, name, status, agent_id, manager, guardian, operator, treasury, proxy
  FROM entities
  WHERE treasury IS NOT NULL OR agent_id IS NOT NULL
  ORDER BY rowid`;

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
        { cause: err },
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
}

export function indexEntities(entities: readonly MonitoredEntity[]): EntityIndex {
  const byTreasury = new Map<string, MonitoredEntity>();
  const byAgentId = new Map<string, MonitoredEntity>();
  for (const e of entities) {
    if (e.treasury) byTreasury.set(e.treasury.toLowerCase(), e);
    if (e.agentId) byAgentId.set(e.agentId, e);
  }
  return { byTreasury, byAgentId };
}
