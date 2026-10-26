import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import type { NewPilotCase, PilotMode, PilotStatus } from "../../src/pilot/types";

let db: Database.Database;
let repo: SqlitePilotCaseRepository;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  repo = new SqlitePilotCaseRepository(db);
});

let seq = 0;
/** A new case with placeholder addresses; no key or token anywhere. */
function newCase(over: Partial<NewPilotCase> = {}): NewPilotCase {
  seq += 1;
  return {
    caseId: `pc_${seq.toString(16).padStart(12, "0")}`,
    label: `TEST-${seq}`,
    mode: "rehearsal",
    chainId: 5042002,
    jobContract: "0x00000000000000000000000000000000000000c1",
    buyerAddress: "0x00000000000000000000000000000000000000b1",
    buyerAgentId: "11",
    sellerAddress: "0x00000000000000000000000000000000000000b2",
    sellerAgentId: "12",
    refereeAddress: "0x00000000000000000000000000000000000000b3",
    budgetAtomic: "1000000",
    description: "a test job",
    expiredAt: 1_800_000_000,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
    ...over,
  };
}

/** Put a row at `status` directly, the way a test reaches any point of the machine. */
function at(status: PilotStatus, mode: PilotMode = "rehearsal") {
  const c = repo.insert(newCase({ mode }));
  db.prepare("UPDATE pilot_cases SET status = ? WHERE case_id = ?").run(status, c.caseId);
  return c.caseId;
}

describe("insert and find", () => {
  test("insert writes status created and returns the row; find reads it back", () => {
    const input = newCase({
      deliverablePath: "deliverables/1.md",
      deliverableHash: `0x${"ab".repeat(32)}`,
      deliverableExtension: "md",
    });
    const rec = repo.insert(input);
    expect(rec).toMatchObject({ ...input, status: "created", jobId: null, klerosChain: null });
    expect(rec.klerosCourtId).toBeNull();
    expect(rec.klerosPolicyUri).toBeNull();
    expect(typeof rec.createdAt).toBe("string");
    expect(typeof rec.updatedAt).toBe("string");
    expect(repo.find(input.caseId)).toEqual(rec);
    expect(repo.find("pc_missing")).toBeUndefined();
  });

  test("findByJobId finds the row once its job id is written", () => {
    const rec = repo.insert(newCase());
    expect(repo.findByJobId("42")).toBeUndefined();
    repo.patch(rec.caseId, { jobId: "42" });
    expect(repo.findByJobId("42")?.caseId).toBe(rec.caseId);
  });
});

describe("list", () => {
  test("newest first, and the mode filter keeps only that mode", () => {
    const a = repo.insert(newCase({ mode: "rehearsal" }));
    const b = repo.insert(newCase({ mode: "testnet" }));
    const c = repo.insert(newCase({ mode: "rehearsal" }));
    // Same-second created_at on all three: the order must still be newest first.
    expect(repo.list().map((r) => r.caseId)).toEqual([c.caseId, b.caseId, a.caseId]);
    expect(repo.list({ mode: "rehearsal" }).map((r) => r.caseId)).toEqual([c.caseId, a.caseId]);
    expect(repo.list({ mode: "testnet" }).map((r) => r.caseId)).toEqual([b.caseId]);
    expect(repo.list({ mode: "live" })).toEqual([]);
  });
});

describe("advance", () => {
  test("from the right status it moves, applies the patch and sets updated_at", () => {
    const rec = repo.insert(newCase());
    db.prepare("UPDATE pilot_cases SET updated_at = '2000-01-01 00:00:00' WHERE case_id = ?").run(
      rec.caseId,
    );
    const moved = repo.advance(rec.caseId, "created", "funded", {
      jobId: "7",
      createTxHash: `0x${"11".repeat(32)}`,
      fundTxHash: `0x${"22".repeat(32)}`,
      fundedBlockTime: 1_799_999_000,
    });
    expect(moved).toMatchObject({
      status: "funded",
      jobId: "7",
      fundTxHash: `0x${"22".repeat(32)}`,
      fundedBlockTime: 1_799_999_000,
    });
    expect(moved?.updatedAt).not.toBe("2000-01-01 00:00:00");
    expect(repo.find(rec.caseId)).toEqual(moved);
  });

  test("from the wrong status it returns undefined and changes nothing", () => {
    const rec = repo.insert(newCase());
    const before = repo.find(rec.caseId);
    expect(repo.advance(rec.caseId, "submitted", "contested", { contestReason: "late" })).toBe(
      undefined,
    );
    expect(repo.find(rec.caseId)).toEqual(before);
  });

  test("an unknown case returns undefined", () => {
    expect(repo.advance("pc_missing", "created", "funded")).toBeUndefined();
  });

  test("two advances from contested to filing: only the first files", () => {
    const id = at("contested");
    const first = repo.advance(id, "contested", "filing", {
      klerosChain: "fake",
      klerosCourtId: 8,
      klerosPolicyUri: "/ipfs/QmPolicy",
      filingStartedAt: 1_800_000_100,
    });
    const second = repo.advance(id, "contested", "filing", {
      klerosChain: "fake",
      filingStartedAt: 1_800_000_200,
    });
    expect(first).toMatchObject({
      status: "filing",
      klerosChain: "fake",
      klerosCourtId: 8,
      klerosPolicyUri: "/ipfs/QmPolicy",
      filingStartedAt: 1_800_000_100,
    });
    expect(second).toBeUndefined();
    expect(repo.find(id)?.filingStartedAt).toBe(1_800_000_100);
  });
});

describe("the Kleros chain on the row is written once", () => {
  test("a patch or an advance that changes a set kleros_chain is refused and writes nothing", () => {
    const id = at("contested");
    repo.advance(id, "contested", "filing", { klerosChain: "arbitrum-sepolia-testnet" });
    const before = repo.find(id);

    expect(() => repo.patch(id, { klerosChain: "arbitrum-one" })).toThrow(/kleros_chain/);
    expect(() => repo.patch(id, { klerosChain: null })).toThrow(/kleros_chain/);
    expect(() =>
      repo.advance(id, "filing", "filed", { klerosChain: "arbitrum-one", coreDisputeId: "5" }),
    ).toThrow(/kleros_chain/);
    expect(repo.find(id)).toEqual(before);
  });

  test("once kleros_chain is set, a change to kleros_court_id or kleros_policy_uri is refused", () => {
    const id = at("contested");
    repo.advance(id, "contested", "filing", {
      klerosChain: "arbitrum-sepolia-testnet",
      klerosCourtId: 8,
      klerosPolicyUri: "/ipfs/QmPolicy",
    });
    const before = repo.find(id);

    expect(() => repo.patch(id, { klerosCourtId: 34 })).toThrow(/kleros_court_id/);
    expect(() => repo.patch(id, { klerosCourtId: null })).toThrow(/kleros_court_id/);
    expect(() => repo.advance(id, "filing", "filed", { klerosCourtId: 34 })).toThrow(
      /kleros_court_id/,
    );
    expect(() => repo.patch(id, { klerosPolicyUri: "/ipfs/QmOther" })).toThrow(/kleros_policy_uri/);
    expect(() => repo.patch(id, { klerosPolicyUri: null })).toThrow(/kleros_policy_uri/);
    expect(() => repo.advance(id, "filing", "filed", { klerosPolicyUri: "/ipfs/QmOther" })).toThrow(
      /kleros_policy_uri/,
    );
    expect(repo.find(id)).toEqual(before);

    // The same values again are not a change.
    expect(
      repo.advance(id, "filing", "filed", { klerosCourtId: 8, klerosPolicyUri: "/ipfs/QmPolicy" })
        ?.status,
    ).toBe("filed");
  });

  test("before kleros_chain is set, the court and the policy may be written", () => {
    const id = at("contested");
    repo.patch(id, { klerosCourtId: 8, klerosPolicyUri: "/ipfs/QmPolicy" });
    expect(repo.patch(id, { klerosCourtId: 34 }).klerosCourtId).toBe(34);
  });

  test("the same value again is not a change, and a NULL chain may be set", () => {
    const id = at("contested");
    repo.patch(id, { klerosChain: "fake" });
    expect(repo.advance(id, "contested", "filing", { klerosChain: "fake" })?.klerosChain).toBe(
      "fake",
    );
  });
});

describe("patch", () => {
  test("writes the fields given, leaves status alone and sets updated_at", () => {
    const rec = repo.insert(newCase());
    db.prepare("UPDATE pilot_cases SET updated_at = '2000-01-01 00:00:00' WHERE case_id = ?").run(
      rec.caseId,
    );
    const out = repo.patch(rec.caseId, { error: "the referee wallet has no gas", contestedAt: 9 });
    expect(out).toMatchObject({
      status: "created",
      error: "the referee wallet has no gas",
      contestedAt: 9,
      label: rec.label,
    });
    expect(out.updatedAt).not.toBe("2000-01-01 00:00:00");
  });

  test("refuses the identity columns mode, chainId and jobContract, in patch and advance", () => {
    const rec = repo.insert(newCase({ mode: "testnet" }));
    const before = repo.find(rec.caseId);
    expect(() => repo.patch(rec.caseId, { mode: "live" })).toThrow(/mode/);
    expect(() => repo.patch(rec.caseId, { chainId: 1 })).toThrow(/chainId/);
    expect(() =>
      repo.patch(rec.caseId, { jobContract: "0x00000000000000000000000000000000000000c2" }),
    ).toThrow(/jobContract/);
    expect(() => repo.advance(rec.caseId, "created", "funded", { mode: "live" })).toThrow(/mode/);
    expect(repo.find(rec.caseId)).toEqual(before);
    expect(repo.countFiled("live")).toBe(0);
  });

  test("refuses a status, a case id or a timestamp column, and an unknown case", () => {
    const rec = repo.insert(newCase());
    expect(() => repo.patch(rec.caseId, { status: "settled" })).toThrow(/status/);
    expect(() => repo.patch(rec.caseId, { caseId: "pc_other" })).toThrow(/caseId/);
    expect(() => repo.patch(rec.caseId, { updatedAt: "x" })).toThrow(/updatedAt/);
    expect(() => repo.patch("pc_missing", { error: "x" })).toThrow(/pc_missing/);
    expect(repo.find(rec.caseId)?.status).toBe("created");
  });
});

describe("events", () => {
  test("are returned in the order they were recorded", () => {
    const rec = repo.insert(newCase());
    repo.recordEvent(rec.caseId, "create", "mined", `0x${"aa".repeat(32)}`, null);
    repo.recordEvent(rec.caseId, "fund", "mined", `0x${"bb".repeat(32)}`, null);
    repo.recordEvent(rec.caseId, "dispute_create", "failed", null, "the service did not answer");
    expect(repo.events(rec.caseId).map(({ createdAt, ...e }) => e)).toEqual([
      { step: "create", status: "mined", ref: `0x${"aa".repeat(32)}`, detail: null },
      { step: "fund", status: "mined", ref: `0x${"bb".repeat(32)}`, detail: null },
      {
        step: "dispute_create",
        status: "failed",
        ref: null,
        detail: "the service did not answer",
      },
    ]);
    expect(typeof repo.events(rec.caseId)[0]?.createdAt).toBe("string");
    expect(repo.events("pc_missing")).toEqual([]);
  });
});

describe("countFiled", () => {
  test("counts exactly the seven statuses, and only rows of the mode asked for", () => {
    const counted: PilotStatus[] = [
      "filing",
      "filed",
      "ruled",
      "settling",
      "settled",
      "filing_unknown",
      "evidence_unknown",
    ];
    const notCounted: PilotStatus[] = ["created", "funded", "submitted", "contested", "failed"];
    for (const s of [...counted, ...notCounted]) at(s, "testnet");
    for (const s of counted) at(s, "live");
    at("filed", "rehearsal");

    expect(repo.countFiled("testnet")).toBe(7);
    expect(repo.countFiled("live")).toBe(7);
    expect(repo.countFiled("rehearsal")).toBe(1);
  });
});

describe("countSeenInCourt", () => {
  test("counts rows of the mode at filed or later that carry a seen_in_court event", () => {
    const seen = (id: string) => repo.recordEvent(id, "seen_in_court", "ok", "5", null);

    seen(at("filed", "testnet"));
    seen(at("ruled", "testnet"));
    seen(at("settled", "testnet"));
    // Each of these is left out for one reason:
    at("filed", "testnet"); // no seen_in_court event
    seen(at("filing", "testnet")); // not yet filed
    seen(at("filing_unknown", "testnet")); // the filing is in doubt
    seen(at("filed", "live")); // another mode
    seen(at("evidence_unknown", "testnet")); // filed, the evidence in doubt: counted
    seen(at("failed", "testnet")); // never filed
    const twice = at("settling", "testnet");
    seen(twice);
    seen(twice); // two events, one row

    expect(repo.countSeenInCourt("testnet")).toBe(5);
    expect(repo.countSeenInCourt("live")).toBe(1);
    expect(repo.countSeenInCourt("rehearsal")).toBe(0);
  });
});

describe("transaction", () => {
  test("rolls back every write when fn throws", () => {
    const rec = repo.insert(newCase());
    expect(() =>
      repo.transaction(() => {
        repo.advance(rec.caseId, "created", "funded");
        repo.recordEvent(rec.caseId, "fund", "mined", null, null);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(repo.find(rec.caseId)?.status).toBe("created");
    expect(repo.events(rec.caseId)).toEqual([]);
  });
});

test("newCaseId is pc_ and 12 lower-case hex, and differs each call", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newCaseId()));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^pc_[0-9a-f]{12}$/);
});
