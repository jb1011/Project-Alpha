/**
 * THE TWO WRITERS THAT PERSIST A STEP ERROR REDACT IT (design §4).
 *
 * `formationSsnForward`/`ssnNeverLogged` drive the whole filing path and prove the property
 * end-to-end. This file asks the narrower question directly of `failFormationStep` and
 * `parkFormationStep`, because they are the CHOKE POINTS and a choke point is worth a test that
 * does not depend on any particular producer reaching it:
 *
 *  - `describeDoolaError` redacts doola's own errors, so a test that goes through doola cannot
 *    tell whether the defence here exists at all;
 *  - the text these two write is not always doola's. Any exception whose message embeds a request
 *    body arrives here as a plain `Error`, and this is the last place before it becomes a row.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { failFormationStep, parkFormationStep } from "../../src/workflow/formationStep";

const COMPANY = "company-1";
const SSN = "123-45-6789";

let db: DatabaseType.Database;
let requests: SqliteFormationRepository;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  requests = new SqliteFormationRepository(db);
  repo = new SqliteEntityRepository(db);
  requests.claimAllSteps(COMPANY);
});
afterEach(() => db.close());

const errorOf = () => requests.find(COMPANY, "create_provider")?.error ?? "";

/** Every spelling the redactor has to catch, in the shape a leak actually arrives in. */
const LEAKS = [
  `E_REQUEST_BODY_INVALID: {"responsibleParty":{"ssn":"${SSN}"}}`,
  "ssn123456789 rejected by underwriting",
  "the number 123 45 6789 was refused",
];

test("failFormationStep never persists an SSN-shaped run", () => {
  for (const message of LEAKS) {
    failFormationStep({ repo, requests }, COMPANY, "create_provider", message);
    expect(errorOf(), message).toContain("[redacted]");
    expect(errorOf(), message).not.toContain(SSN);
    expect(errorOf(), message).not.toMatch(/\d{3}[-. ]?\d{2}[-. ]?\d{4}/);
  }
});

test("parkFormationStep never persists one either", () => {
  for (const message of LEAKS) {
    parkFormationStep({ repo, requests }, COMPANY, "create_provider", message);
    expect(errorOf(), message).toContain("[redacted]");
    expect(errorOf(), message).not.toContain(SSN);
    expect(errorOf(), message).not.toMatch(/\d{3}[-. ]?\d{2}[-. ]?\d{4}/);
  }
});

test("an ordinary error is written through untouched — the redactor is not a filter", () => {
  // The cost of a blunt redactor is false positives, so the other half of the property matters:
  // an operator has to be able to read the error they are being paged about, and a `nextRetryAt`
  // epoch inside the retry schedule has to survive being written next to one.
  failFormationStep({ repo, requests }, COMPANY, "create_provider", "socket hang up (attempt 3)");
  expect(errorOf()).toBe("socket hang up (attempt 3)");
  parkFormationStep({ repo, requests }, COMPANY, "create_provider", "doola returned HTTP 503");
  expect(errorOf()).toBe("doola returned HTTP 503");
  expect(requests.find(COMPANY, "create_provider")!.detail).toContain("nextRetryAt");
});
