import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import type { Hex } from "../types";

/**
 * Tier-0 foundations (docs/design/2026-08-03-tier0-circle-wallet-migration.md, audit items 1+7).
 *
 * `backfillPocketAddresses`: pocket addresses were always RE-DERIVED from POCKET_MASTER_SEED at
 * every use — never stored — so the seed could never retire while any read path still derived.
 * One-shot, marker-guarded (meta table, same pattern as the S1 capability backfill): derive each
 * existing entity's pocket address once and store it. Runs from the composition roots (which
 * hold the seed), NOT from migrate() (which is pure-db by design). New agents get their address
 * written at creation; rows added after the backfill are deliberately not re-visited.
 *
 * `assertCircleCoverage`: a deployment with `wallet_provider='circle'` agents but no Circle
 * credentials must refuse to BOOT, not fail at the first signature — those agents are
 * unserviceable and every op against them would die confusingly at runtime.
 */
const POCKET_BACKFILL_KEY = "pocket_address_backfill";

export function backfillPocketAddresses(db: Database.Database, masterSeed: Hex): number {
  const done = db.prepare("SELECT value FROM meta WHERE key = ?").get(POCKET_BACKFILL_KEY);
  if (done) return 0;
  const rows = db
    .prepare("SELECT idempotency_key FROM entities WHERE pocket_address IS NULL")
    .all() as { idempotency_key: string }[];
  const update = db.prepare("UPDATE entities SET pocket_address = ? WHERE idempotency_key = ?");
  const run = db.transaction(() => {
    for (const r of rows) {
      const address = privateKeyToAccount(derivePocketKey(masterSeed, r.idempotency_key)).address;
      update.run(address, r.idempotency_key);
    }
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')").run(POCKET_BACKFILL_KEY);
  });
  run();
  return rows.length;
}

export function assertCircleCoverage(
  db: Database.Database,
  circle: { apiKey: string; entitySecret: string } | undefined,
): void {
  if (circle) return;
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM entities WHERE wallet_provider = 'circle'")
    .get() as { n: number };
  if (r.n > 0)
    throw new Error(
      `${r.n} agent(s) use the circle custody path but CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET are not configured — refusing to boot (they would be unserviceable)`,
    );
}
