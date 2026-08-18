/**
 * Monitor error taxonomy. The distinction that matters operationally: a CONFIG error must stop the
 * process (a monitor watching the wrong addresses is worse than no monitor, because it manufactures
 * silence), while a SCAN or LOOKUP error must NOT — the watcher's whole job is to still be running
 * when the interesting block arrives, so a transient RPC or DB failure is logged and retried.
 */

/** Refuses the boot. Thrown only from the composition root, before the loop starts. */
export class MonitorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorConfigError";
  }
}

/** The main legalbody.db could not be read (missing, locked beyond the busy timeout, un-migrated).
 *  Recoverable: the entity-derived rules degrade for a tick, the controller rules do not. */
export class EntityLookupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EntityLookupError";
  }
}

/** One scan window failed against the RPC. The cursor is not advanced past the failed chunk, so
 *  the next tick re-reads exactly the blocks that were missed — no gap, at worst a duplicate scan
 *  (which the alert dedup key absorbs). */
export class ScanError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScanError";
  }
}
