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
 * The DB half of the payment-address separation invariants (design 2026-08-26 §6.6, B1 gate A2).
 *
 * `config/env.ts` refuses a `FORMATION_REVENUE_ADDRESS` or a `FORMATION_SETTLE_SUBMITTER_KEY`
 * that collides with the executor or any key in the fixed env set. It cannot see the OTHER half
 * of "every platform key": the per-agent operator and pocket addresses, which are rows rather
 * than variables — env parsing has no database, and a pocket address is derived from a seed
 * rather than configured.
 *
 * Two addresses, two harms:
 *
 *  - the REVENUE address landing on a hot wallet this platform can sign for, on a box where the
 *    whole point of it is that no key for it exists here;
 *  - the SETTLE SUBMITTER being an address the fleet already uses, which puts a guardian's
 *    settle back into a nonce space shared with agent operations — exactly what the dedicated
 *    submitter exists to escape.
 *
 * Three columns, because an operator that has been ROTATED AWAY is still an address this
 * deployment held a key for, and a pocket is derived from a seed that is still on the box.
 *
 * It MAY SCAN, and that is deliberate (finding B4). It runs ONCE, at API boot, on a deployment
 * that charges — microseconds against any fleet this system will have — where the three partial
 * indexes it used to rely on were paid for on every write to `entities`, forever, on every
 * deployment including the ones that never charge for anything. Called from the API composition
 * root beside `assertCircleCoverage`, and a no-op where payment is off.
 */
export function assertPaymentAddressSeparation(
  db: Database.Database,
  payment: { required: boolean; revenueAddress?: string; submitterKey?: Hex },
): void {
  if (!payment.required) return;
  const held = (address: string): boolean => {
    // SQLite's default `=` on TEXT is case-SENSITIVE, and a miss on casing would PASS this check
    // and lose the money — addresses are stored in whatever casing wrote them (viem checksums,
    // older paths and hand-written rows do not). `COLLATE NOCASE` is how the comparison stays
    // correct for all of them.
    const checksummed = getAddress(address);
    return (
      db
        .prepare(
          `SELECT 1 AS hit FROM entities
            WHERE operator = ? COLLATE NOCASE
               OR previous_operator = ? COLLATE NOCASE
               OR pocket_address = ? COLLATE NOCASE
            LIMIT 1`,
        )
        .get(checksummed, checksummed, checksummed) !== undefined
    );
  };

  if (payment.revenueAddress && held(payment.revenueAddress))
    throw new Error(
      "Invalid config: FORMATION_REVENUE_ADDRESS is an agent operator or pocket address held by this deployment — formation revenue lands on a receive-only Ledger account, never on a wallet this box can sign for (refusing to boot)",
    );
  if (payment.submitterKey && held(privateKeyToAccount(payment.submitterKey).address))
    throw new Error(
      "Invalid config: FORMATION_SETTLE_SUBMITTER_KEY is an agent operator or pocket key held by this deployment — the settle submitter needs its own nonce space and its own gas float, and sharing one with agent operations is what it exists to avoid (refusing to boot)",
    );
}
