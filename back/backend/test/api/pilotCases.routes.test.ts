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
import { migrate } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";
import { toPilotCaseView } from "../../src/pilot/views";
import {
  BUYER_AGENT,
  BUYER_NAME,
  ERROR_SENTINEL,
  EVIDENCE_TEXT,
  LOCAL_DISPUTE_ID,
  SELLER_AGENT,
  SELLER_NAME,
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
});

describe("GET /pilot/cases/:caseId", () => {
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
