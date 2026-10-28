import type { Context, Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { opsLog } from "../../observability/opsLog";
import type { FileDocumentStore } from "../../persistence/documentStore";
import type { PilotCaseRepository } from "../../pilot/casesRepository";
import { PILOT_MODES, type PilotCaseRecord, type PilotMode } from "../../pilot/types";
import { type PilotCaseView, parseStoredAnswer, toPilotCaseView } from "../../pilot/views";
import type { ApiDeps } from "../app";
import {
  AnswerMemo,
  FRESH_CACHE_CONTROL,
  MEMO_TTL_MS,
  NO_STORE,
  UNAVAILABLE_BODY,
  errorNameOf,
} from "./legalBodies";
import type { ByAgentAnswer } from "./legalBodyStatements";

/**
 * GET /pilot/cases and GET /pilot/cases/:caseId: the dispute pilot's cases, PUBLIC, read only and
 * labelled test data, for a page anyone may open.
 *
 * The pilot runs ERC-8183 jobs between two test agents, each with a legal body, on Arc; a
 * contested job goes to the Kleros Dispute Service, and the referee carries the ruling out on Arc.
 * The pilot's commands write the table; this surface only reads it, through the public view
 * (`pilot/views.ts`), which serves no key, no file path, no error text and no local dispute id.
 *
 * Mounted only where the deps exist (a box with the pilot block or the Kleros block); elsewhere
 * both routes are a 404. Both answers carry the statement routes' 15-second freshness, and the
 * list is memoised for the same window, so a page refreshing in a loop costs one read of the table
 * per window and filter. Every refusal is a short fixed sentence, `no-store`.
 */
export interface PilotCaseDeps {
  cases: PilotCaseRepository;
  /** The API's document store: the evidence text and the two stored lookup answers. */
  docStore: FileDocumentStore;
  /** The Arc explorer, for the job's transaction links (`pilotExplorerBase`). */
  explorerBase: string;
  /** The API origin of the parties' lookup links (`pilotLookupBase`). */
  lookupBase: string;
  /** The Arc network this deployment runs on, as the answer states it. */
  environment: "testnet" | "mainnet";
  /** Injectable clock (ms) for the memo; defaults to the API's, then Date.now. */
  now?: () => number;
}

/** What `GET /pilot/cases` answers. */
export interface PilotCaseList {
  environment: "testnet" | "mainnet";
  testData: true;
  cases: PilotCaseView[];
}

/** What `GET /pilot/cases/:caseId` answers: the view, the stored evidence text beside the
 *  evidence's name and hash, and the two lookup answers as stored at filing. */
export type PilotCaseDetail = Omit<PilotCaseView, "evidence"> & {
  evidence: (NonNullable<PilotCaseView["evidence"]> & { description: string | null }) | null;
  records: { buyer: ByAgentAnswer | null; seller: ByAgentAnswer | null };
};

/** The most cases the list serves, newest first. */
const CASES_LISTED = 100;
/** One answer per filter: every mode, and each of the three. */
const LIST_MEMO_ENTRIES = PILOT_MODES.length + 1;
/** The case id `newCaseId` mints, and nothing else. */
const CASE_ID = /^pc_[0-9a-f]{12}$/;

const INVALID_MODE = { error: "validation_error", message: "unknown mode" } as const;
const INVALID_CASE_ID = {
  error: "validation_error",
  message: "caseId must be pc_ followed by 12 lower-case hex digits",
} as const;
const NOT_FOUND = { error: "not_found", message: "no pilot case with this id" } as const;

const isPilotMode = (v: string): v is PilotMode => (PILOT_MODES as readonly string[]).includes(v);

/** Mounts nothing without `deps.pilotCases`: both routes are then a 404. */
export function mountPilotCaseRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const pc = deps.pilotCases;
  if (!pc) return;
  const now = () => (pc.now ?? deps.now ?? Date.now)();
  const memo = new AnswerMemo<PilotCaseList>(MEMO_TTL_MS, LIST_MEMO_ENTRIES, now);
  const viewOpts = { explorerBase: pc.explorerBase, lookupBase: pc.lookupBase };

  /** A stored file's text; null when the row names none or it cannot be read. The reason never
   *  reaches an answer: it would carry the path. */
  const readStored = async (id: string | null): Promise<string | null> => {
    if (id === null) return null;
    try {
      return (await pc.docStore.getBytesAsync(id)).toString("utf8");
    } catch {
      return null;
    }
  };
  const readAnswer = async (id: string | null): Promise<ByAgentAnswer | null> => {
    const text = await readStored(id);
    return text === null ? null : parseStoredAnswer(text);
  };
  const recordsOf = async (row: PilotCaseRecord) => {
    const [buyer, seller] = await Promise.all([
      readAnswer(row.buyerRecordPath),
      readAnswer(row.sellerRecordPath),
    ]);
    return { buyer, seller };
  };
  /** The view of a row, its parties named from the stored answers that could be read. */
  const viewOf = (row: PilotCaseRecord, records: PilotCaseDetail["records"]) =>
    toPilotCaseView(row, {
      ...viewOpts,
      records: { buyer: records.buyer ?? undefined, seller: records.seller ?? undefined },
    });

  const refuse = (c: Context, body: object, status: 400 | 404) => {
    c.header("Cache-Control", NO_STORE);
    return c.json(body, status);
  };
  /** The table could not be read (or a row could not be projected): the flat 503 of the public
   *  routes, never memoised, with the error's name only in the ops line. */
  const unavailable = (c: Context, e: unknown) => {
    opsLog("pilot_cases_read_failed", { errorName: errorNameOf(e) });
    c.header("Cache-Control", NO_STORE);
    return c.json(UNAVAILABLE_BODY, 503);
  };

  app.get("/pilot/cases", async (c) => {
    const supplied = c.req.query("mode");
    if (supplied !== undefined && !isPilotMode(supplied)) return refuse(c, INVALID_MODE, 400);
    const mode = supplied;
    const key = mode ?? "every";

    const hit = memo.get(key);
    if (hit !== undefined) {
      c.header("Cache-Control", FRESH_CACHE_CONTROL);
      return c.json(hit);
    }
    let answer: PilotCaseList;
    try {
      // The repository's own list, newest first; the pilot holds a handful of cases, so the cap
      // is taken here rather than in SQL.
      const rows = (mode === undefined ? pc.cases.list() : pc.cases.list({ mode })).slice(
        0,
        CASES_LISTED,
      );
      const views = await Promise.all(rows.map(async (row) => viewOf(row, await recordsOf(row))));
      answer = { environment: pc.environment, testData: true, cases: views };
    } catch (e) {
      return unavailable(c, e);
    }
    memo.set(key, answer);
    c.header("Cache-Control", FRESH_CACHE_CONTROL);
    return c.json(answer);
  });

  app.get("/pilot/cases/:caseId", async (c) => {
    const caseId = c.req.param("caseId");
    if (!CASE_ID.test(caseId)) return refuse(c, INVALID_CASE_ID, 400);

    let answer: PilotCaseDetail;
    try {
      const row = pc.cases.find(caseId);
      if (!row) return refuse(c, NOT_FOUND, 404);
      const [description, records] = await Promise.all([
        readStored(row.evidencePath),
        recordsOf(row),
      ]);
      const view = viewOf(row, records);
      answer = {
        ...view,
        evidence: view.evidence === null ? null : { ...view.evidence, description },
        records,
      };
    } catch (e) {
      return unavailable(c, e);
    }
    c.header("Cache-Control", FRESH_CACHE_CONTROL);
    return c.json(answer);
  });
}
