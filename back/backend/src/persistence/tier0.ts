import type Database from "better-sqlite3";
import { getAddress } from "viem";
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

/** Mirror of `assertCircleCoverage` for the turnkey side: a deployment with turnkey-custody agents
 *  (including legacy rows, whose `wallet_provider` is NULL) but no Turnkey provisioning config must
 *  refuse to BOOT — those agents' vaults are unserviceable. A circle-only deployment with an empty
 *  or all-circle DB (the mainnet shape) passes. */
export function assertTurnkeyCoverage(db: Database.Database, turnkeyServiceable: boolean): void {
  if (turnkeyServiceable) return;
  const r = db
    .prepare(
      "SELECT COUNT(*) AS n FROM entities WHERE wallet_provider = 'turnkey' OR wallet_provider IS NULL",
    )
    .get() as { n: number };
  if (r.n > 0)
    throw new Error(
      `${r.n} agent(s) use the turnkey custody path but TURNKEY_* (incl. the delegated keypair) is not configured — refusing to boot (they would be unserviceable)`,
    );
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

/**
 * The DB half of the revenue-address separation invariant (design 2026-08-26 §6.6).
 *
 * `config/env.ts` refuses a `FORMATION_REVENUE_ADDRESS` that equals the executor or any key in
 * the fixed env set. It cannot see the OTHER half of "every platform key": the per-agent operator
 * and pocket addresses, which are rows rather than variables — env parsing has no database, and a
 * pocket address is derived from a seed rather than configured.
 *
 * The harm is the same one, one layer along: formation revenue landing on a hot wallet this
 * platform can sign for, on a box where the whole point of the revenue address is that no key for
 * it exists here. Three columns, because an operator that has been ROTATED AWAY is still an
 * address this deployment held a key for, and a pocket is derived from a seed that is still on
 * the box.
 *
 * ONE indexed EXISTS rather than a fleet scan (each arm has its own partial index, added in
 * `migrate`): a thousand-agent deployment must not read a thousand rows to answer a yes/no
 * question at every boot. Called from the API composition root beside `assertCircleCoverage`, and
 * a no-op on every deployment that does not charge.
 */
export function assertRevenueAddressSeparation(
  db: Database.Database,
  payment: { required: boolean; revenueAddress?: string },
): void {
  if (!payment.required || !payment.revenueAddress) return;
  // SQLite's default `=` on TEXT is case-SENSITIVE, and a miss on casing would PASS this check
  // and lose the money — addresses are stored in whatever casing wrote them (viem checksums,
  // older paths and hand-written rows do not). `COLLATE NOCASE` rather than `LOWER(column)`:
  // both are correct, but a function on the indexed side is not sargable, and the three partial
  // indexes `migrate` creates are declared NOCASE precisely so this stays a lookup.
  const revenue = getAddress(payment.revenueAddress);
  const hit = db
    .prepare(
      `SELECT 1 AS hit FROM entities
        WHERE operator = ? COLLATE NOCASE
           OR previous_operator = ? COLLATE NOCASE
           OR pocket_address = ? COLLATE NOCASE
        LIMIT 1`,
    )
    .get(revenue, revenue, revenue) as { hit: number } | undefined;
  if (hit)
    throw new Error(
      "Invalid config: FORMATION_REVENUE_ADDRESS is an agent operator or pocket address held by this deployment — formation revenue lands on a receive-only Ledger account, never on a wallet this box can sign for (refusing to boot)",
    );
}
