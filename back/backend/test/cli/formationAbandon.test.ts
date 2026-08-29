/**
 * `formation:abandon` — the OPERATOR ESCAPE the migration's refusal names (design §2 step 1).
 *
 * The entity → company re-key refuses to run while any `create_provider` row is in flight,
 * because re-keying a live create rotates its idempotency key and doola would file a SECOND real
 * Wyoming LLC. Most such rows clear themselves at the attempt bound. One shape never does — a row
 * parked on `key_reused` or on a lost answer never burns an attempt, by design (C1) — so without
 * this command a human-parked row blocks the upgrade forever.
 *
 * It runs on WHICHEVER SCHEMA IS ON DISK and deliberately does NOT migrate: it exists to be run
 * on a box whose migration is refusing, and running that migration first would be a catch-22.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildCli } from "../../src/cli/index";
import { migrate, openDatabase } from "../../src/persistence/db";
import { legacyEntity, legacyStep, openLegacyDb } from "../helpers/legacyFormationDb";

let dir: string;
let dbPath: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abandon-"));
  dbPath = join(dir, "legalbody.db");
  process.env.DB_PATH = dbPath;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

/** A pre-migration database ON DISK, in the shape a refusing box actually has. */
async function legacyOnDisk(over: { state: string; providerRef?: string | null }): Promise<string> {
  const db = openLegacyDb();
  const key = legacyEntity(db, { key: "tenant-a:parked" });
  legacyStep(db, {
    entityKey: key,
    step: "create_provider",
    state: over.state,
    providerRef: over.providerRef ?? null,
  });
  await db.backup(dbPath);
  db.close();
  return key;
}

const run = (args: string[]) =>
  buildCli(() => {
    throw new Error("this command must not build a chain context");
  }).parseAsync(["node", "cli", ...args]);

test("it abandons a parked create so the migration can proceed", async () => {
  const key = await legacyOnDisk({ state: "failed" });
  // The migration refuses first…
  const before = openDatabase(dbPath);
  expect(() => migrate(before)).toThrow(/formation:abandon/);
  before.close();

  await run(["formation:abandon", key, "--reason", "doola parked it on a human decision"]);

  const after = openDatabase(dbPath);
  expect(
    (
      after
        .prepare("SELECT state FROM formation_requests WHERE step = 'create_provider'")
        .get() as { state: string }
    ).state,
  ).toBe("abandoned");
  // …and now it does.
  expect(() => migrate(after)).not.toThrow();
  after.close();
});

test("it REFUSES a create that reached doola — that one is adopted, never abandoned by hand", async () => {
  const key = await legacyOnDisk({ state: "failed", providerRef: "cmp-real" });
  // A provider_ref means a company may really exist in Wyoming's records under this person's
  // name. Abandoning it is what would erase their data for a filing that happened.
  await expect(run(["formation:abandon", key])).rejects.toThrow(/holds doola company id cmp-real/);

  const after = openDatabase(dbPath);
  expect(
    (
      after
        .prepare("SELECT state FROM formation_requests WHERE step = 'create_provider'")
        .get() as { state: string }
    ).state,
  ).toBe("failed");
  after.close();
});

test("an unknown key is an error, and a second run is a no-op", async () => {
  const key = await legacyOnDisk({ state: "submitted" });
  await expect(run(["formation:abandon", "tenant-a:nope"])).rejects.toThrow(
    /no create_provider row/,
  );
  await run(["formation:abandon", key]);
  // Idempotent: the second call says so rather than throwing or double-logging a CRITICAL.
  await expect(run(["formation:abandon", key])).resolves.toBeDefined();
});

test("POST-migration it speaks the new schema too, and moves the COMPANY with the step", async () => {
  // A row parked after the upgrade: the argument is still an entity key, resolved through
  // `entities.company_id`, and the company's own status moves with the step so the two cannot
  // disagree about whether the filing is over (§4.6).
  const db = openLegacyDb();
  const key = legacyEntity(db, { key: "tenant-a:post" });
  await db.backup(dbPath);
  db.close();
  const live = openDatabase(dbPath);
  migrate(live);
  const companyId = (
    live.prepare("SELECT company_id AS c FROM entities WHERE idempotency_key = ?").get(key) as {
      c: string;
    }
  ).c;
  live
    .prepare("INSERT INTO formation_requests (company_id, step, state) VALUES (?,?,?)")
    .run(companyId, "create_provider", "failed");
  live.close();

  await run(["formation:abandon", key]);

  const after = openDatabase(dbPath);
  expect(
    (
      after.prepare("SELECT state FROM formation_requests WHERE company_id = ?").get(companyId) as {
        state: string;
      }
    ).state,
  ).toBe("abandoned");
  expect(
    (
      after.prepare("SELECT status FROM companies WHERE company_id = ?").get(companyId) as {
        status: string;
      }
    ).status,
  ).toBe("abandoned");
  after.close();
});
