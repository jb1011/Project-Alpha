import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";

describe("jobs migration", () => {
  test("migrate creates jobs and job_events tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain("jobs");
    expect(names).toContain("job_events");
  });
});
