/**
 * GET /pilot/cases and GET /pilot/cases/:caseId: the pilot's cases, public, read only, labelled
 * test data. The answers' shapes for a fresh row and a full row in each mode; the mode filter;
 * newest first, at most 100; the 15-second memo of the list; the cache header and CORS; the 400,
 * 404 and 503; the stored files read as absent when they cannot be read; nothing served that the
 * view does not list (no key, no path, no error text, no local dispute id, and "live" only as a
 * mode); both routes absent without their deps; and the composition root's wiring.
 *
 * A real in-memory database through the pilot case repository, a real document store on a
 * temporary data directory, a fixed clock. Every address is a placeholder.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import {
  signStatement,
  statementFromJson,
  verifyPublicStatement,
} from "../../src/legalBody/publicStatement";
import { migrate } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";
import { toPilotCaseView } from "../../src/pilot/views";
import { TEST_ATTESTOR } from "../helpers/legalBodyStatementFixtures";
import {
  BUYER_AGENT,
  BUYER_NAME,
  CHAIN_ID,
  ERROR_SENTINEL,
  EVIDENCE_TEXT,
  LOCAL_DISPUTE_ID,
  SELLER_AGENT,
  SELLER_NAME,
  STATEMENT_ISSUED_AT,
  answerFor,
  fullPatch,
  hash,
  newCase,
  storedIdsOf,
} from "../helpers/pilotCaseFixtures";

const EXPLORER = "https://explorer.testnet.arc.io";
const LOOKUP = "https://api.example.test";
const FRESH = "public, max-age=15";
const NO_STORE = "no-store";
const MODES = ["rehearsal", "testnet", "live"] as const;
/** U+2014, written as a code so this file holds none. */
const EM_DASH = String.fromCharCode(0x2014);

let db: Database.Database;
let cases: SqlitePilotCaseRepository;
let dataDir: string;
let docStore: FileDocumentStore;
let clock: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  cases = new SqlitePilotCaseRepository(db);
  dataDir = mkdtempSync(join(tmpdir(), "pilot-cases-"));
  docStore = new FileDocumentStore(join(dataDir, "documents"));
  clock = 1_790_000_000_000;
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeApp(o: { pilot?: boolean } = {}) {
  return buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: "s",
    now: () => clock,
    pilotCases:
      o.pilot === false
        ? undefined
        : { cases, docStore, explorerBase: EXPLORER, lookupBase: LOOKUP, environment: "testnet" },
  } as never);
}
type App = ReturnType<typeof makeApp>;

// biome-ignore lint/suspicious/noExplicitAny: a JSON answer, read field by field
type Json = any;
async function getJson(app: App, path: string) {
  const res = await app.request(path);
  return { res, body: (await res.json()) as Json };
}

/** The ops lines printed from now on: each line's fields, without `opslog` and `at`, by event. */
function captureOps() {
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  return (event: string): Json[] =>
    printed.flatMap((line) => {
      try {
        const { opslog, at: _at, ...fields } = JSON.parse(line) as Json;
        return opslog === event ? [fields] : [];
      } catch {
        return [];
      }
    });
}

let seq = 0;
/** A distinct case id per call. */
const nextCaseId = () => `pc_${(++seq).toString(16).padStart(12, "0")}`;

/** Puts a row at `status` directly, the way a test reaches any point of the machine. */
function setStatus(caseId: string, status: PilotStatus) {
  db.prepare("UPDATE pilot_cases SET status = ? WHERE case_id = ?").run(status, caseId);
}

/** A fresh row at `created`, as `pilot:job` inserts it. */
function freshCase(mode: PilotMode = "rehearsal"): PilotCaseRecord {
  return cases.insert(newCase({ caseId: nextCaseId(), mode }));
}

/** A full `settled` row of `mode`, with its evidence text and both lookup answers stored. */
function fullCase(mode: PilotMode): PilotCaseRecord {
  const row = freshCase(mode);
  const ids = storedIdsOf(row.caseId);
  docStore.put(ids.deliverable, "name,email\n");
  docStore.put(ids.evidence, EVIDENCE_TEXT);
  docStore.put(ids.buyerRecord, JSON.stringify(answerFor(BUYER_AGENT, BUYER_NAME)));
  docStore.put(ids.sellerRecord, JSON.stringify(answerFor(SELLER_AGENT, SELLER_NAME)));
  cases.patch(row.caseId, { ...fullPatch(mode, row.caseId), jobId: String(seq) });
  setStatus(row.caseId, "settled");
  return cases.find(row.caseId) as PilotCaseRecord;
}

const RECORDS = {
  buyer: answerFor(BUYER_AGENT, BUYER_NAME),
  seller: answerFor(SELLER_AGENT, SELLER_NAME),
};
const viewOf = (row: PilotCaseRecord, records?: typeof RECORDS) =>
  toPilotCaseView(row, { explorerBase: EXPLORER, lookupBase: LOOKUP, records });

describe("GET /pilot/cases", () => {
  test("every mode, newest first, labelled test data, each case a view with its parties' names", async () => {
    const a = fullCase("rehearsal");
    const b = freshCase("testnet");
    const c = fullCase("live");
    const { res, body } = await getJson(makeApp(), "/pilot/cases");
    expect(res.status).toBe(200);
    expect(body).toEqual({
      environment: "testnet",
      testData: true,
      cases: [viewOf(c, RECORDS), viewOf(b), viewOf(a, RECORDS)],
    });
    expect(Object.keys(body)).toEqual(["environment", "testData", "cases"]);
    expect(body.cases[0].buyer.legalName).toBe(BUYER_NAME);
    expect(body.cases[0].seller.standingAtFiling).toBe("active");
  });

  test("the environment is the one the deps name", async () => {
    const app = buildApiApp({
      webOrigin: "https://www.example.test",
      jwtSecret: "s",
      pilotCases: {
        cases,
        docStore,
        explorerBase: EXPLORER,
        lookupBase: LOOKUP,
        environment: "mainnet",
      },
    } as never);
    expect((await getJson(app, "/pilot/cases")).body.environment).toBe("mainnet");
  });

  test("no case yet: an empty list, still labelled", async () => {
    const { res, body } = await getJson(makeApp(), "/pilot/cases");
    expect(res.status).toBe(200);
    expect(body).toEqual({ environment: "testnet", testData: true, cases: [] });
  });

  test("the mode filter keeps only that mode, for each of the three", async () => {
    const byMode = {
      rehearsal: [fullCase("rehearsal"), freshCase("rehearsal")],
      testnet: [fullCase("testnet")],
      live: [freshCase("live"), fullCase("live")],
    };
    const app = makeApp();
    for (const mode of MODES) {
      const { res, body } = await getJson(app, `/pilot/cases?mode=${mode}`);
      expect(res.status, mode).toBe(200);
      expect(
        body.cases.map((v: Json) => v.caseId),
        mode,
      ).toEqual(byMode[mode].map((r) => r.caseId).reverse());
      expect(new Set(body.cases.map((v: Json) => v.mode)), mode).toEqual(new Set([mode]));
    }
  });

  test("an unknown mode is a 400 that names no mode", async () => {
    const app = makeApp();
    for (const q of ["mode=LIVE", "mode=", "mode=production", "mode=all"]) {
      const { res, body } = await getJson(app, `/pilot/cases?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("cache-control"), q).toBe(NO_STORE);
      expect(body, q).toEqual({ error: "validation_error", message: "unknown mode" });
    }
  });

  test("at most 100, the newest", async () => {
    const ids = Array.from({ length: 105 }, () => freshCase().caseId);
    const { body } = await getJson(makeApp(), "/pilot/cases");
    expect(body.cases).toHaveLength(100);
    expect(body.cases.map((v: Json) => v.caseId)).toEqual(ids.slice(5).reverse());
  });

  test("memoised for 15 seconds, per filter; the case route is not", async () => {
    const app = makeApp();
    const first = freshCase("testnet");
    expect((await getJson(app, "/pilot/cases")).body.cases).toHaveLength(1);
    expect((await getJson(app, "/pilot/cases?mode=testnet")).body.cases).toHaveLength(1);
    freshCase("testnet");
    cases.patch(first.caseId, { jobId: "7" });
    clock += 14_999;
    const kept = await getJson(app, "/pilot/cases");
    expect(kept.body.cases).toHaveLength(1);
    expect(kept.res.headers.get("cache-control")).toBe(FRESH);
    expect((await getJson(app, "/pilot/cases?mode=testnet")).body.cases).toHaveLength(1);
    // Another filter is another answer, read now.
    expect((await getJson(app, "/pilot/cases?mode=live")).body.cases).toHaveLength(0);
    // The case route reads the row on every request.
    expect((await getJson(app, `/pilot/cases/${first.caseId}`)).body.jobId).toBe("7");
    clock += 1;
    expect((await getJson(app, "/pilot/cases")).body.cases).toHaveLength(2);
    expect((await getJson(app, "/pilot/cases?mode=testnet")).body.cases).toHaveLength(2);
  });

  test("a failed database read is a 503 with a fixed sentence, never stored", async () => {
    const app = makeApp();
    const spy = vi.spyOn(cases, "list").mockImplementationOnce(() => {
      throw new Error(`SQLITE_BUSY at ${dataDir}/novi.db`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { res, body } = await getJson(app, "/pilot/cases");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(body).toEqual({
      error: "unavailable",
      message: "could not check right now; try again shortly",
    });
    // Not memoised: the next request reads again.
    expect((await getJson(app, "/pilot/cases")).res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("a row the view cannot show is skipped with one ops line; the others are served and memoised", async () => {
    const opsOf = captureOps();
    const a = fullCase("testnet");
    // A budget that is not a decimal number: the view refuses to render it.
    const bad = cases.insert(
      newCase({ caseId: nextCaseId(), mode: "testnet", budgetAtomic: "2.00" }),
    );
    const c = freshCase("rehearsal");
    const app = makeApp();
    const { res, body } = await getJson(app, "/pilot/cases");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    expect(body).toEqual({
      environment: "testnet",
      testData: true,
      cases: [viewOf(c), viewOf(a, RECORDS)],
    });
    expect(opsOf("pilot_cases_row_skipped")).toEqual([{ caseId: bad.caseId, errorName: "Error" }]);
    expect(opsOf("pilot_cases_read_failed")).toEqual([]);
    // The filter that holds the row skips it too.
    const testnet = await getJson(app, "/pilot/cases?mode=testnet");
    expect(testnet.body.cases.map((v: Json) => v.caseId)).toEqual([a.caseId]);
    expect(opsOf("pilot_cases_row_skipped")).toHaveLength(2);
    // Memoised like any answer: a hit within the window reads and logs nothing.
    const spy = vi.spyOn(cases, "list");
    expect((await getJson(app, "/pilot/cases")).body.cases).toHaveLength(2);
    expect(spy).not.toHaveBeenCalled();
    expect(opsOf("pilot_cases_row_skipped")).toHaveLength(2);
    // The case route for that one row stays the fixed 503.
    const detail = await getJson(app, `/pilot/cases/${bad.caseId}`);
    expect(detail.res.status).toBe(503);
    expect(detail.res.headers.get("cache-control")).toBe(NO_STORE);
    expect(detail.body).toEqual({
      error: "unavailable",
      message: "could not check right now; try again shortly",
    });
    expect(opsOf("pilot_cases_read_failed")).toEqual([{ errorName: "Error" }]);
  });

  test("a list whose rows can all be shown logs no skip", async () => {
    const opsOf = captureOps();
    fullCase("live");
    freshCase("testnet");
    expect((await getJson(makeApp(), "/pilot/cases")).body.cases).toHaveLength(2);
    expect(opsOf("pilot_cases_row_skipped")).toEqual([]);
  });
});

describe("GET /pilot/cases/:caseId", () => {
  test("the stored answers are served rebuilt: no extra key reaches records, and the statement still verifies", async () => {
    const extra = {
      error: "fetch failed at https://lookup.example.test/?apiKey=EXTRAKEY",
      path: `${dataDir}/documents/pilot-record.json`,
      localDisputeId: LOCAL_DISPUTE_ID,
      fetchedFrom: "https://lookup.example.test/internal",
    };
    // A statement signed for real by the test attestor, and an answer around it.
    const base = answerFor(BUYER_AGENT, BUYER_NAME);
    const signed = await signStatement(statementFromJson(base.statement.message), TEST_ATTESTOR);
    const buyer = { ...base, statement: signed };
    const seller = {
      agentId: SELLER_AGENT,
      legalBody: true,
      standing: "unknown",
      publicId: null,
      network: "testnet",
      links: { transparency: "https://www.example.test/transparency" },
      checkedAt: "2026-10-28T09:30:00.000Z",
      statement: null,
    };
    const storedBuyer = {
      ...extra,
      ...buyer,
      links: { ...buyer.links, ...extra },
      statement: {
        ...extra,
        ...signed,
        domain: { ...signed.domain, ...extra },
        message: { ...signed.message, ...extra },
      },
    };
    const storedSeller = { ...extra, ...seller, links: { ...seller.links, ...extra } };
    const verify = (statement: unknown) =>
      verifyPublicStatement(statement, {
        attestor: TEST_ATTESTOR.address,
        expectedChainId: CHAIN_ID,
        nowSeconds: STATEMENT_ISSUED_AT,
      });
    expect(await verify(signed)).toBe(true);
    // As stored, the extras alone make the statement fail to verify.
    expect(await verify(storedBuyer.statement)).toBe(false);

    const row = fullCase("testnet");
    const ids = storedIdsOf(row.caseId);
    docStore.put(ids.buyerRecord, JSON.stringify(storedBuyer));
    docStore.put(ids.sellerRecord, JSON.stringify(storedSeller));
    const app = makeApp();
    const { res, body } = await getJson(app, `/pilot/cases/${row.caseId}`);
    expect(res.status).toBe(200);
    // Every known field served, as stored; nothing else.
    expect(body.records).toEqual({ buyer, seller });
    expect(Object.keys(body.records.buyer)).toEqual(Object.keys(buyer));
    expect(Object.keys(body.records.buyer.statement)).toEqual(Object.keys(signed));
    expect(Object.keys(body.records.buyer.statement.message)).toEqual(Object.keys(signed.message));
    expect(await verify(body.records.buyer.statement)).toBe(true);
    expect(body.buyer.legalName).toBe(BUYER_NAME);
    expect(body.buyer.standingAtFiling).toBe("active");
    expect(body.seller).toMatchObject({ legalName: null, standingAtFiling: null });
    const list = (await getJson(app, "/pilot/cases")).body;
    for (const answer of [body, list]) {
      const { keys } = walk(answer);
      for (const k of Object.keys(extra))
        expect(keys.map((key) => key.toLowerCase())).not.toContain(k.toLowerCase());
      const text = JSON.stringify(answer);
      for (const value of [...Object.values(extra), "EXTRAKEY", dataDir])
        expect(text).not.toContain(value);
    }
  });

  test("a full row: the view, the stored evidence text and the two stored answers", async () => {
    const row = fullCase("testnet");
    const { res, body } = await getJson(makeApp(), `/pilot/cases/${row.caseId}`);
    expect(res.status).toBe(200);
    const view = viewOf(row, RECORDS);
    expect(body).toEqual({
      ...view,
      evidence: {
        name: "Job TEST-1: the complete record (test data)",
        sha256: hash("e1"),
        attachmentUri: "/ipfs/bafyexamplecid",
        description: EVIDENCE_TEXT,
      },
      records: RECORDS,
    });
    expect(Object.keys(body)).toEqual([...Object.keys(view), "records"]);
    expect(body.kleros.caseUrl).toBe("https://v2-testnet.kleros.builders/#/cases/186/overview");
    expect(body.kleros.courtLabel).toBe("Kleros testnet court");
  });

  test("a fresh created row: null for every later step, no evidence, no records", async () => {
    const row = freshCase("live");
    const { res, body } = await getJson(makeApp(), `/pilot/cases/${row.caseId}`);
    expect(res.status).toBe(200);
    expect(body).toEqual({ ...viewOf(row), records: { buyer: null, seller: null } });
    expect(body.evidence).toBeNull();
    expect(body.kleros).toBeNull();
    expect(body.tx).toEqual({ create: null, fund: null, submit: null, settle: null });
  });

  test("a stored file that is missing, unreadable or not an answer is served as absent", async () => {
    const row = freshCase("testnet");
    const ids = storedIdsOf(row.caseId);
    docStore.put(ids.sellerRecord, "{ not json");
    cases.patch(row.caseId, {
      evidencePath: ids.evidence, // never written
      evidenceSha256: hash("e1"),
      evidenceName: "Job TEST-1: the complete record (test data)",
      buyerRecordPath: "../../outside-the-store.json",
      sellerRecordPath: ids.sellerRecord,
    });
    const { res, body } = await getJson(makeApp(), `/pilot/cases/${row.caseId}`);
    expect(res.status).toBe(200);
    expect(body.evidence).toEqual({
      name: "Job TEST-1: the complete record (test data)",
      sha256: hash("e1"),
      attachmentUri: null,
      description: null,
    });
    expect(body.records).toEqual({ buyer: null, seller: null });
    expect(body.buyer.legalName).toBeNull();
    const text = JSON.stringify(body);
    for (const absent of [dataDir, "outside-the-store", ids.evidence, ids.sellerRecord, "ENOENT"])
      expect(text).not.toContain(absent);
  });

  test("a case id that is not pc_ and 12 lower-case hex digits is a 400; an unknown one a 404", async () => {
    const app = makeApp();
    for (const id of [
      "pc_0123456789a",
      "pc_0123456789abc",
      "pc_0123456789AB",
      "PC_0123456789ab",
      "pc-0123456789ab",
      "pc_0123456789ag",
      "x",
      "%20pc_0123456789ab",
    ]) {
      const { res, body } = await getJson(app, `/pilot/cases/${id}`);
      expect(res.status, id).toBe(400);
      expect(res.headers.get("cache-control"), id).toBe(NO_STORE);
      expect(body, id).toEqual({
        error: "validation_error",
        message: "caseId must be pc_ followed by 12 lower-case hex digits",
      });
    }
    const { res, body } = await getJson(app, "/pilot/cases/pc_00000000ffff");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(body).toEqual({ error: "not_found", message: "no pilot case with this id" });
  });

  test("a failed database read is a 503 with a fixed sentence", async () => {
    vi.spyOn(cases, "find").mockImplementationOnce(() => {
      throw new Error(`SQLITE_BUSY at ${dataDir}/novi.db`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { res, body } = await getJson(makeApp(), "/pilot/cases/pc_00000000ffff");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(body).toEqual({
      error: "unavailable",
      message: "could not check right now; try again shortly",
    });
  });
});

describe("the stored files: the pilot's own, found by their file name in the store", () => {
  /** Points a row's three stored-file columns at `values`. */
  const pointAt = (caseId: string, values: { evidence: string; buyer: string; seller: string }) =>
    cases.patch(caseId, {
      evidencePath: values.evidence,
      buyerRecordPath: values.buyer,
      sellerRecordPath: values.seller,
    });

  test("an absolute path to a pilot file in the store is served exactly like its flat id", async () => {
    const row = fullCase("testnet");
    const ids = storedIdsOf(row.caseId);
    // The flat ids the row holds.
    const flat = await getJson(makeApp(), `/pilot/cases/${row.caseId}`);
    expect(flat.res.status).toBe(200);
    expect(flat.body.evidence.description).toBe(EVIDENCE_TEXT);
    expect(flat.body.records).toEqual(RECORDS);
    expect(flat.body.buyer.legalName).toBe(BUYER_NAME);
    expect(flat.body.seller.standingAtFiling).toBe("active");

    // The absolute paths the store's own writes answer, as a writer that kept them would store.
    pointAt(row.caseId, {
      evidence: docStore.put(ids.evidence, EVIDENCE_TEXT).path,
      buyer: docStore.put(ids.buyerRecord, JSON.stringify(RECORDS.buyer)).path,
      seller: docStore.put(ids.sellerRecord, JSON.stringify(RECORDS.seller)).path,
    });
    expect((cases.find(row.caseId) as PilotCaseRecord).evidencePath).toContain(dataDir);
    const app = makeApp();
    const absolute = await getJson(app, `/pilot/cases/${row.caseId}`);
    expect(absolute.res.status).toBe(200);
    expect(absolute.body).toEqual(flat.body);
    const list = (await getJson(app, "/pilot/cases")).body;
    expect(list.cases).toEqual([viewOf(cases.find(row.caseId) as PilotCaseRecord, RECORDS)]);
    for (const answer of [absolute.body, list])
      expect(JSON.stringify(answer)).not.toContain(dataDir);
  });

  test("a file whose name does not start with pilot-, though the store holds it, is served as absent", async () => {
    const row = fullCase("testnet");
    const OTHER_TEXT = "a document of another kind, never public";
    const OTHER_NAME = "Other DAO LLC";
    const otherAnswer = JSON.stringify(answerFor(BUYER_AGENT, OTHER_NAME));
    const stored = {
      evidence: docStore.put(`tenant-${row.caseId}-evidence.txt`, OTHER_TEXT),
      buyer: docStore.put(`PILOT-${row.caseId}-buyer-record.json`, otherAnswer),
      seller: docStore.put(`x-pilot-${row.caseId}-seller-record.json`, otherAnswer),
    };
    for (const by of ["id", "path"] as const) {
      pointAt(row.caseId, {
        evidence: stored.evidence[by],
        buyer: stored.buyer[by],
        seller: stored.seller[by],
      });
      const app = makeApp();
      const { res, body } = await getJson(app, `/pilot/cases/${row.caseId}`);
      expect(res.status, by).toBe(200);
      expect(body.evidence.description, by).toBeNull();
      expect(body.records, by).toEqual({ buyer: null, seller: null });
      expect(body.buyer, by).toMatchObject({ legalName: null, standingAtFiling: null });
      expect(body.seller, by).toMatchObject({ legalName: null, standingAtFiling: null });
      const list = (await getJson(app, "/pilot/cases")).body;
      expect(list.cases[0].buyer.legalName, by).toBeNull();
      expect(list.cases[0].seller.legalName, by).toBeNull();
      for (const answer of [body, list]) {
        const text = JSON.stringify(answer);
        for (const absent of [OTHER_TEXT, OTHER_NAME, dataDir])
          expect(text, by).not.toContain(absent);
      }
    }
  });

  test("a value with ../ segments, or a path outside the store, serves only the pilot file of that name in the store, never a file outside it", async () => {
    const row = fullCase("testnet");
    const ids = storedIdsOf(row.caseId);
    // Beside the store, not in it: files under the case's own names, and one the store lacks.
    const OUTSIDE_TEXT = "a text outside the store";
    const OUTSIDE_NAME = "Outside DAO LLC";
    const beside = new FileDocumentStore(join(dataDir, "elsewhere"));
    const evidence = beside.put(ids.evidence, OUTSIDE_TEXT);
    const buyer = beside.put(
      `pilot-${row.caseId}-not-in-the-store.json`,
      JSON.stringify(answerFor(BUYER_AGENT, OUTSIDE_NAME)),
    );
    const seller = beside.put(
      ids.sellerRecord,
      JSON.stringify(answerFor(SELLER_AGENT, OUTSIDE_NAME)),
    );
    for (const values of [
      {
        evidence: `../elsewhere/${evidence.id}`,
        buyer: `../elsewhere/${buyer.id}`,
        seller: `../../${seller.id}`,
      },
      { evidence: evidence.path, buyer: buyer.path, seller: seller.path },
    ]) {
      pointAt(row.caseId, values);
      const app = makeApp();
      const { res, body } = await getJson(app, `/pilot/cases/${row.caseId}`);
      expect(res.status, values.evidence).toBe(200);
      // The store's own evidence text and seller record, under the names the values end in.
      expect(body.evidence.description, values.evidence).toBe(EVIDENCE_TEXT);
      expect(body.records, values.evidence).toEqual({ buyer: null, seller: RECORDS.seller });
      expect(body.buyer.legalName, values.evidence).toBeNull();
      expect(body.seller.legalName, values.evidence).toBe(SELLER_NAME);
      const list = (await getJson(app, "/pilot/cases")).body;
      expect(list.cases[0].seller.legalName, values.evidence).toBe(SELLER_NAME);
      for (const answer of [body, list]) {
        const text = JSON.stringify(answer);
        for (const absent of [OUTSIDE_TEXT, OUTSIDE_NAME, dataDir, "elsewhere"])
          expect(text, values.evidence).not.toContain(absent);
      }
    }
  });
});

describe("GET /pilot/cases/:caseId: the memo", () => {
  test("a case's 200 is memoised for 15 seconds, per case: a change inside the window is not seen", async () => {
    const row = fullCase("testnet");
    const other = fullCase("testnet");
    const ids = storedIdsOf(row.caseId);
    const app = makeApp();
    const first = await getJson(app, `/pilot/cases/${row.caseId}`);
    expect(first.res.status).toBe(200);
    expect(first.body.evidence.description).toBe(EVIDENCE_TEXT);
    // The stored file and the row change after the first answer.
    docStore.put(ids.evidence, "a changed evidence text");
    cases.patch(row.caseId, { jobId: "7" });
    clock += 14_999;
    const find = vi.spyOn(cases, "find");
    const kept = await getJson(app, `/pilot/cases/${row.caseId}`);
    expect(kept.res.status).toBe(200);
    expect(kept.res.headers.get("cache-control")).toBe(FRESH);
    expect(kept.body).toEqual(first.body);
    expect(find).not.toHaveBeenCalled();
    // Another case is its own entry, read now.
    expect((await getJson(app, `/pilot/cases/${other.caseId}`)).body.caseId).toBe(other.caseId);
    expect(find).toHaveBeenCalledTimes(1);
    // Once the window has passed, the case is read again.
    clock += 1;
    const fresh = await getJson(app, `/pilot/cases/${row.caseId}`);
    expect(fresh.res.headers.get("cache-control")).toBe(FRESH);
    expect(fresh.body.evidence.description).toBe("a changed evidence text");
    expect(fresh.body.jobId).toBe("7");
    expect(find).toHaveBeenCalledTimes(2);
  });

  test("a 404 and a 503 are not memoised: the next read inside the window reads again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const app = makeApp();
    const caseId = "pc_00000000ffff";
    expect((await getJson(app, `/pilot/cases/${caseId}`)).res.status).toBe(404);
    cases.insert(newCase({ caseId, mode: "testnet" }));
    const found = await getJson(app, `/pilot/cases/${caseId}`);
    expect(found.res.status).toBe(200);
    expect(found.body.caseId).toBe(caseId);

    const later = freshCase("rehearsal");
    const find = vi.spyOn(cases, "find").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    expect((await getJson(app, `/pilot/cases/${later.caseId}`)).res.status).toBe(503);
    const again = await getJson(app, `/pilot/cases/${later.caseId}`);
    expect(again.res.status).toBe(200);
    expect(again.body.caseId).toBe(later.caseId);
    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe("both routes", () => {
  test("Cache-Control public, max-age=15 on every answer of both", async () => {
    const row = fullCase("testnet");
    const fresh = freshCase("rehearsal");
    const app = makeApp();
    for (const path of [
      "/pilot/cases",
      "/pilot/cases?mode=testnet",
      `/pilot/cases/${row.caseId}`,
      `/pilot/cases/${fresh.caseId}`,
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(FRESH);
    }
    // A memo hit carries the same header.
    expect((await app.request("/pilot/cases")).headers.get("cache-control")).toBe(FRESH);
  });

  test("CORS *: a page on any origin may read both, with no credential", async () => {
    const row = freshCase();
    const app = makeApp();
    for (const path of ["/pilot/cases", `/pilot/cases/${row.caseId}`]) {
      const preflight = await app.request(path, {
        method: "OPTIONS",
        headers: { Origin: "https://page.example", "Access-Control-Request-Method": "GET" },
      });
      expect(preflight.headers.get("access-control-allow-origin"), path).toBe("*");
      const res = await app.request(path, { headers: { Origin: "https://page.example" } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
    }
    // Only these two paths: a neighbour, the bare prefix and a protected route keep the web origin.
    for (const path of ["/pilot/casesx", "/pilot/casesx/pc_0123456789ab", "/pilot", "/entities"]) {
      for (const method of ["GET", "OPTIONS"]) {
        const res = await app.request(path, {
          method,
          headers: { Origin: "https://page.example", "Access-Control-Request-Method": "GET" },
        });
        expect(res.headers.get("access-control-allow-origin"), `${method} ${path}`).toBe(
          "https://www.example.test",
        );
      }
    }
  });

  test("without the pilot cases' deps both routes are not mounted: 404", async () => {
    const row = fullCase("testnet");
    const app = makeApp({ pilot: false });
    expect((await app.request("/pilot/cases")).status).toBe(404);
    expect((await app.request("/pilot/cases?mode=testnet")).status).toBe(404);
    expect((await app.request(`/pilot/cases/${row.caseId}`)).status).toBe(404);
  });
});

/** Every key and every string value of a JSON answer, each with the key it sits under. */
function walk(value: unknown, key = ""): { keys: string[]; strings: [string, string][] } {
  const out = { keys: [] as string[], strings: [] as [string, string][] };
  const visit = (v: unknown, k: string) => {
    if (typeof v === "string") out.strings.push([k, v]);
    else if (Array.isArray(v)) for (const item of v) visit(item, k);
    else if (v !== null && typeof v === "object")
      for (const [childKey, child] of Object.entries(v)) {
        out.keys.push(childKey);
        visit(child, childKey);
      }
  };
  visit(value, key);
  return out;
}

describe("nothing served but the view", () => {
  /** Every 200 answer of both routes over a full row of each mode and a fresh one. */
  async function everyAnswer(): Promise<{ path: string; body: Json }[]> {
    const rows = [...MODES.map((m) => fullCase(m)), freshCase("live")];
    const app = makeApp();
    const paths = [
      "/pilot/cases",
      ...MODES.map((m) => `/pilot/cases?mode=${m}`),
      ...rows.map((r) => `/pilot/cases/${r.caseId}`),
    ];
    const answers = [];
    for (const path of paths) {
      const { res, body } = await getJson(app, path);
      expect(res.status, path).toBe(200);
      answers.push({ path, body });
    }
    return answers;
  }

  test("no key, no path, no error text, no local dispute id, in any key or string value", async () => {
    const words = ["PrivateKey", "apiKey", "ApiKey", "KLEROS_API_KEY", "path", "localDisputeId"];
    const forbidden = [...words, "error"].map((w) => w.toLowerCase());
    const answers = await everyAnswer();
    const storedIds = (
      db.prepare("SELECT case_id FROM pilot_cases").all() as { case_id: string }[]
    ).flatMap((r) => Object.values(storedIdsOf(r.case_id)));
    for (const { path, body } of answers) {
      const { keys, strings } = walk(body);
      for (const k of keys)
        for (const w of forbidden) expect(k.toLowerCase(), `${path}: key ${k}`).not.toContain(w);
      for (const [k, s] of strings) {
        for (const w of forbidden) expect(s.toLowerCase(), `${path}: ${k} = ${s}`).not.toContain(w);
        // Nothing that looks like a file under the data directory, by any spelling.
        expect(s, `${path}: ${k}`).not.toContain(dataDir);
        expect(s, `${path}: ${k}`).not.toMatch(/^file:|pc_[0-9a-f]{12}[-/.]|\.(json|csv|txt)$/);
        for (const id of storedIds) expect(s, `${path}: ${k}`).not.toContain(id);
      }
      const text = JSON.stringify(body);
      expect(text, path).not.toContain(ERROR_SENTINEL);
      expect(text, path).not.toContain("SENTINELKEY");
      expect(text, path).not.toContain(LOCAL_DISPUTE_ID);
    }
  });

  test('"live" only as the mode value; none of the words a public surface never says', async () => {
    const answers = await everyAnswer();
    const app = makeApp();
    // The refusals too: their sentences are public words as well.
    for (const path of ["/pilot/cases?mode=x", "/pilot/cases/x", "/pilot/cases/pc_00000000ffff"])
      answers.push({ path, body: (await getJson(app, path)).body });
    let liveModes = 0;
    for (const { path, body } of answers) {
      const { keys, strings } = walk(body);
      for (const k of keys) expect(k, `${path}: key ${k}`).not.toMatch(/live/i);
      for (const [k, s] of strings) {
        if (k === "mode" && s === "live") {
          liveModes += 1;
          continue;
        }
        expect(s, `${path}: ${k}`).not.toMatch(/\blive\b/i);
        for (const w of [/production/i, /non-custodial/i, /kleros enforces/i, /partner/i])
          expect(s, `${path}: ${k}`).not.toMatch(w);
        expect(s, `${path}: ${k}`).not.toContain(EM_DASH);
      }
    }
    // The live rows were served, and said so only in their mode.
    expect(liveModes).toBeGreaterThan(0);
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the other composition guards do. What it protects: the pilot cases' deps exist only on a box
 * with the pilot block or the Kleros block; they read the table through the pilot repository and
 * the files through the API's own document store; the two bases come from the shared helpers; the
 * environment is the deployment's network; and the API is handed them.
 */
test("the composition root wires the pilot cases only with the pilot or the Kleros block", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const at = main.indexOf("const pilotCases");
  expect(at, "the pilot cases' deps were not found").toBeGreaterThan(0);
  const built = main.slice(at, main.indexOf(": undefined;", at));
  expect(built).toMatch(
    /^const pilotCases: PilotCaseDeps \| undefined =\n {4}cfg\.pilot \|\| cfg\.kleros\n {6}\? \{$/m,
  );
  expect(built).toMatch(/^ {10}cases: new SqlitePilotCaseRepository\(db\),$/m);
  expect(built).toMatch(/^ {10}docStore,$/m);
  expect(built).toMatch(/^ {10}explorerBase: pilotExplorerBase\(cfg\),$/m);
  expect(built).toMatch(/^ {10}lookupBase: pilotLookupBase\(cfg\),$/m);
  expect(built).toMatch(/^ {10}environment: cfg\.arcNetwork \?\? "testnet",$/m);
  expect(main.match(/new SqlitePilotCaseRepository\(/g)).toHaveLength(1);
  const appAt = main.indexOf("const app = buildApiApp({");
  expect(at).toBeLessThan(appAt);
  expect(main.slice(appAt, main.indexOf("\n  });\n", appAt))).toMatch(/^ {4}pilotCases,$/m);
});
