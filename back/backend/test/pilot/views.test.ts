/**
 * The public projection of a pilot case: what `toPilotCaseView` keeps of a row, from a fresh
 * `created` row to a full `settled` row in each of the three modes; the Court URL and label per
 * Kleros chain; the budget in USDC; the parties' names and standing from the stored lookup
 * answers; and the two bases the links are built on.
 */
import { describe, expect, test } from "vitest";
import { arcTestnet } from "../../src/chains";
import type { Config } from "../../src/config/env";
import type { PilotMode } from "../../src/pilot/types";
import {
  budgetUsdcOf,
  courtLabelOf,
  parseStoredAnswer,
  pilotExplorerBase,
  pilotLookupBase,
  toPilotCaseView,
} from "../../src/pilot/views";
import {
  BUYER,
  BUYER_AGENT,
  BUYER_NAME,
  CHAIN_ID,
  CORE_ID_OF,
  COURT_OF,
  JOB_CONTRACT,
  REFEREE,
  SELLER,
  SELLER_AGENT,
  SELLER_NAME,
  answerFor,
  freshRecord,
  fullRecord,
  hash,
} from "../helpers/pilotCaseFixtures";

const EXPLORER = "https://explorer.testnet.arc.io";
const LOOKUP = "https://api.example.test";
const OPTS = { explorerBase: EXPLORER, lookupBase: LOOKUP };
const RECORDS = {
  buyer: answerFor(BUYER_AGENT, BUYER_NAME),
  seller: answerFor(SELLER_AGENT, SELLER_NAME),
};

/** The keys of a view, in the order the interface lists them. Nothing else may appear. */
const VIEW_KEYS = [
  "caseId",
  "label",
  "mode",
  "status",
  "chainId",
  "jobContract",
  "jobId",
  "buyer",
  "seller",
  "refereeAddress",
  "budgetUsdc",
  "description",
  "expiredAt",
  "tx",
  "kleros",
  "evidence",
  "settlement",
  "contest",
  "updatedAt",
];

describe("toPilotCaseView", () => {
  test("a fresh created row: the job's terms, the two parties, and null for every later step", () => {
    const view = toPilotCaseView(freshRecord(), OPTS);
    expect(view).toEqual({
      caseId: "pc_0123456789ab",
      label: "TEST-1",
      mode: "rehearsal",
      status: "created",
      chainId: CHAIN_ID,
      jobContract: JOB_CONTRACT,
      jobId: null,
      buyer: {
        address: BUYER,
        agentId: BUYER_AGENT,
        legalName: null,
        standingAtFiling: null,
        lookupUrl: `${LOOKUP}/legal-bodies/by-agent/${BUYER_AGENT}`,
      },
      seller: {
        address: SELLER,
        agentId: SELLER_AGENT,
        legalName: null,
        standingAtFiling: null,
        lookupUrl: `${LOOKUP}/legal-bodies/by-agent/${SELLER_AGENT}`,
      },
      refereeAddress: REFEREE,
      budgetUsdc: "2.00",
      description: "Clean the supplier list and return it as a CSV file (test data).",
      expiredAt: 1_800_000_000,
      tx: { create: null, fund: null, submit: null, settle: null },
      kleros: null,
      evidence: null,
      settlement: null,
      contest: null,
      updatedAt: "2026-10-28 09:00:00",
    });
    expect(Object.keys(view)).toEqual(VIEW_KEYS);
  });

  const expectedKleros: Record<PilotMode, unknown> = {
    rehearsal: {
      chain: "fake",
      courtId: null,
      courtLabel: "rehearsal (no court)",
      coreDisputeId: CORE_ID_OF.rehearsal,
      caseUrl: null,
    },
    testnet: {
      chain: "arbitrum-sepolia-testnet",
      courtId: 8,
      courtLabel: "Kleros testnet court",
      coreDisputeId: "186",
      caseUrl: "https://v2-testnet.kleros.builders/#/cases/186/overview",
    },
    live: {
      chain: "arbitrum-one",
      courtId: 34,
      courtLabel: "Kleros Agentic Commerce Court",
      coreDisputeId: "287",
      caseUrl: "https://v2.kleros.builders/#/cases/287/overview",
    },
  };

  for (const mode of ["rehearsal", "testnet", "live"] as const) {
    test(`a full settled row in ${mode}: every step, with its links, and nothing else`, () => {
      const view = toPilotCaseView(fullRecord(mode), { ...OPTS, records: RECORDS });
      expect(view).toEqual({
        caseId: "pc_0123456789ab",
        label: "TEST-1",
        mode,
        status: "settled",
        chainId: CHAIN_ID,
        jobContract: JOB_CONTRACT,
        jobId: "42",
        buyer: {
          address: BUYER,
          agentId: BUYER_AGENT,
          legalName: BUYER_NAME,
          standingAtFiling: "active",
          lookupUrl: `${LOOKUP}/legal-bodies/by-agent/${BUYER_AGENT}`,
        },
        seller: {
          address: SELLER,
          agentId: SELLER_AGENT,
          legalName: SELLER_NAME,
          standingAtFiling: "active",
          lookupUrl: `${LOOKUP}/legal-bodies/by-agent/${SELLER_AGENT}`,
        },
        refereeAddress: REFEREE,
        budgetUsdc: "2.00",
        description: "Clean the supplier list and return it as a CSV file (test data).",
        expiredAt: 1_800_000_000,
        tx: {
          create: { hash: hash("a1"), url: `${EXPLORER}/tx/${hash("a1")}` },
          fund: { hash: hash("a2"), url: `${EXPLORER}/tx/${hash("a2")}` },
          submit: { hash: hash("a3"), url: `${EXPLORER}/tx/${hash("a3")}` },
          settle: { hash: hash("a4"), url: `${EXPLORER}/tx/${hash("a4")}` },
        },
        kleros: {
          ...(expectedKleros[mode] as object),
          status: "Executed",
          ruling: "1",
          tied: false,
          roundCount: 1,
          rulingLabel: "Pay the provider",
          readAt: 1_790_000_060,
        },
        evidence: {
          name: "Job TEST-1: the complete record (test data)",
          sha256: hash("e1"),
          attachmentUri: "/ipfs/bafyexamplecid",
        },
        settlement: {
          action: "complete",
          reason: hash("c1"),
          outcome: "released",
          at: 1_790_000_070,
        },
        contest: {
          reason: "The file has 3 rows; the job asked for 30.",
          reply: "The source list had 3 rows.",
          at: 1_790_000_030,
        },
        updatedAt: "2026-10-28 10:30:00",
      });
      expect(Object.keys(view)).toEqual(VIEW_KEYS);
      expect(COURT_OF[mode]).toBe(view.kleros?.courtId ?? null);
    });
  }

  test("the Court URL: one pattern per chain, null for the fake and before a dispute id", () => {
    const urlOf = (mode: PilotMode, coreDisputeId: string | null) =>
      toPilotCaseView(fullRecord(mode, { coreDisputeId }), OPTS).kleros?.caseUrl;
    expect(urlOf("testnet", "12")).toBe("https://v2-testnet.kleros.builders/#/cases/12/overview");
    expect(urlOf("live", "12")).toBe("https://v2.kleros.builders/#/cases/12/overview");
    expect(urlOf("rehearsal", "12")).toBeNull();
    // At `filing`, the deployment is on the row and the dispute id is not yet.
    expect(urlOf("testnet", null)).toBeNull();
    expect(urlOf("live", null)).toBeNull();
    // A dispute id that is not a decimal number is never turned into a link.
    expect(urlOf("testnet", "12/../../x")).toBeNull();
  });

  test("courtLabel: the deployment's label, or rehearsal (no court) for the fake", () => {
    expect(courtLabelOf("arbitrum-sepolia-testnet")).toBe("Kleros testnet court");
    expect(courtLabelOf("arbitrum-one")).toBe("Kleros Agentic Commerce Court");
    expect(courtLabelOf("fake")).toBe("rehearsal (no court)");
    for (const chain of ["arbitrum-sepolia-testnet", "arbitrum-one", "fake"] as const)
      expect(courtLabelOf(chain)).not.toMatch(/live/i);
  });

  test("a row at filing: the deployment is shown, the ruling fields are null", () => {
    const row = freshRecord({
      status: "filing",
      klerosChain: "arbitrum-sepolia-testnet",
      klerosCourtId: 8,
    });
    expect(toPilotCaseView(row, OPTS).kleros).toEqual({
      chain: "arbitrum-sepolia-testnet",
      courtId: 8,
      courtLabel: "Kleros testnet court",
      coreDisputeId: null,
      caseUrl: null,
      status: null,
      ruling: null,
      tied: null,
      roundCount: null,
      rulingLabel: null,
      readAt: null,
    });
  });

  test("tied reads the INTEGER column: 1 is true, 0 is false, null is null", () => {
    const tiedOf = (rulingTied: number | null) =>
      toPilotCaseView(fullRecord("testnet", { rulingTied }), OPTS).kleros?.tied;
    expect(tiedOf(1)).toBe(true);
    expect(tiedOf(0)).toBe(false);
    expect(tiedOf(null)).toBeNull();
  });

  test("a settlement with no transaction yet, and a contest with no reply", () => {
    const view = toPilotCaseView(
      fullRecord("testnet", {
        status: "settling",
        settleTxHash: null,
        settledAt: null,
        escrowOutcome: null,
        contestReply: null,
      }),
      OPTS,
    );
    expect(view.tx.settle).toBeNull();
    expect(view.settlement).toEqual({
      action: "complete",
      reason: hash("c1"),
      outcome: null,
      at: null,
    });
    expect(view.contest).toEqual({
      reason: "The file has 3 rows; the job asked for 30.",
      reply: null,
      at: 1_790_000_030,
    });
  });

  test("the parties: names and standing from the stored answers, null without them", () => {
    const view = (records?: Parameters<typeof toPilotCaseView>[1]["records"]) =>
      toPilotCaseView(fullRecord("testnet"), { ...OPTS, records });
    expect(view().buyer).toMatchObject({ legalName: null, standingAtFiling: null });
    expect(view({ seller: RECORDS.seller }).buyer.legalName).toBeNull();
    expect(view({ seller: RECORDS.seller }).seller.legalName).toBe(SELLER_NAME);
    // The standing the signed statement stated at filing.
    expect(
      view({ buyer: answerFor(BUYER_AGENT, BUYER_NAME, "pending") }).buyer.standingAtFiling,
    ).toBe("pending");
    // An answer with no statement states no name and no standing.
    expect(
      view({
        buyer: { agentId: BUYER_AGENT, legalBody: false, standing: null, checkedAt: "x" },
      }).buyer,
    ).toMatchObject({ legalName: null, standingAtFiling: null });
    // A statement whose names may not be shown carries "": no name, not an empty one.
    expect(view({ buyer: answerFor(BUYER_AGENT, "") }).buyer.legalName).toBeNull();
  });

  test("bases with trailing slashes still give one slash in every link", () => {
    const view = toPilotCaseView(fullRecord("testnet"), {
      explorerBase: `${EXPLORER}//`,
      lookupBase: `${LOOKUP}/`,
    });
    expect(view.tx.create?.url).toBe(`${EXPLORER}/tx/${hash("a1")}`);
    expect(view.buyer.lookupUrl).toBe(`${LOOKUP}/legal-bodies/by-agent/${BUYER_AGENT}`);
  });

  test("the view holds no path, no error text, no local dispute id and no policy", () => {
    const text = JSON.stringify(toPilotCaseView(fullRecord("live"), { ...OPTS, records: RECORDS }));
    for (const absent of ["pilot-pc_", "srv/novi", "SENTINELKEY", "918273645", "policy"])
      expect(text).not.toContain(absent);
  });
});

describe("budgetUsdcOf", () => {
  test("whole cents with two decimals; a finer budget with every significant decimal", () => {
    expect(budgetUsdcOf("2000000")).toBe("2.00");
    expect(budgetUsdcOf("0")).toBe("0.00");
    expect(budgetUsdcOf("2500000")).toBe("2.50");
    expect(budgetUsdcOf("2010000")).toBe("2.01");
    expect(budgetUsdcOf("2001000")).toBe("2.001");
    expect(budgetUsdcOf("2000001")).toBe("2.000001");
    expect(budgetUsdcOf("1")).toBe("0.000001");
    expect(budgetUsdcOf("123456789")).toBe("123.456789");
    expect(budgetUsdcOf("100000000000000000000")).toBe("100000000000000.00");
  });

  test("a budget that is not a decimal number is refused, never rendered", () => {
    for (const bad of ["", "2.00", "-1", "0x10", " 1", "1e6"])
      expect(() => budgetUsdcOf(bad), bad).toThrow();
  });
});

describe("parseStoredAnswer", () => {
  test("a stored answer is read back as it was stored", () => {
    const answer = answerFor(BUYER_AGENT, BUYER_NAME);
    expect(parseStoredAnswer(JSON.stringify(answer))).toEqual(answer);
    const none = { agentId: "7", legalBody: false, standing: null, checkedAt: "2026-10-28" };
    expect(parseStoredAnswer(JSON.stringify(none))).toEqual(none);
  });

  test("anything else is absent: not JSON, not an object, or not an answer's shape", () => {
    const answer = answerFor(BUYER_AGENT, BUYER_NAME);
    for (const text of [
      "",
      "{",
      "null",
      "[]",
      '"text"',
      JSON.stringify({ ...answer, agentId: 11 }),
      JSON.stringify({ ...answer, legalBody: "yes" }),
      JSON.stringify({ ...answer, checkedAt: undefined }),
      JSON.stringify({ ...answer, statement: "signed" }),
      JSON.stringify({ ...answer, statement: { ...answer.statement, message: null } }),
      JSON.stringify({
        ...answer,
        statement: {
          ...answer.statement,
          message: { ...answer.statement.message, legalName: 1 },
        },
      }),
    ])
      expect(parseStoredAnswer(text), text.slice(0, 60)).toBeNull();
  });
});

describe("the two bases", () => {
  const cfg = (over: Partial<Config>) =>
    ({ metadataBaseUrl: "https://www.example.test/", ...over }) as Config;
  const pilot = (lookupBase: string) => ({ lookupBase }) as Config["pilot"];

  test("pilotExplorerBase: the configured explorer, else Arc testnet's, without a trailing slash", () => {
    expect(pilotExplorerBase(cfg({ arcExplorerUrl: "https://explorer.example.test/" }))).toBe(
      "https://explorer.example.test",
    );
    expect(pilotExplorerBase(cfg({ arcExplorerUrl: undefined }))).toBe(
      arcTestnet.blockExplorers?.default.url.replace(/\/+$/, ""),
    );
  });

  test("pilotLookupBase: the pilot's, else the API's public origin, else the metadata base", () => {
    expect(
      pilotLookupBase(
        cfg({ pilot: pilot("https://lookup.example.test/"), publicApiUrl: "https://a.test" }),
      ),
    ).toBe("https://lookup.example.test");
    expect(pilotLookupBase(cfg({ publicApiUrl: "https://api.example.test/" }))).toBe(
      "https://api.example.test",
    );
    expect(pilotLookupBase(cfg({}))).toBe("https://www.example.test");
  });
});
