/**
 * The evidence a juror reads: rendered from a contested job's row, the chain's facts, the
 * delivered file and the two public lookup answers.
 *
 * The golden file is the authority: test case 1 rendered from the fixtures below, compared byte
 * for byte. Its dates are the fixture row's block times (20 to 27 October), not the test case's,
 * on purpose. Every refusal has a test, and so does every rule about what the record may print.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Hex, keccak256, stringToBytes } from "viem";
import { describe, expect, test } from "vitest";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import {
  LEGAL_BODY_STATEMENT_TYPES,
  type LegalBodyStatementJson,
} from "../../src/legalBody/publicStatement";
import {
  EVIDENCE_DESCRIPTION_MAX_BYTES,
  EVIDENCE_NAME_MAX_BYTES,
  EvidenceError,
  type EvidenceInput,
  formatUsdc,
  formatUtcDate,
  renderEvidence,
} from "../../src/pilot/evidence";
import type { PilotCaseRecord } from "../../src/pilot/types";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "pilot");
const SRC = join(import.meta.dirname, "..", "..", "src");

const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, name)));
/** A text fixture without the file's own trailing LF. */
const fixtureText = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8").replace(/\n$/, "");
const lookup = (side: "buyer" | "seller"): ByAgentAnswer =>
  JSON.parse(readFileSync(join(FIXTURES, `lookup-${side}.json`), "utf8")) as ByAgentAnswer;

type FoundAnswer = Extract<ByAgentAnswer, { publicId: string }>;
const withMessage = (a: ByAgentAnswer, patch: Partial<LegalBodyStatementJson>): ByAgentAnswer => {
  const f = a as FoundAnswer;
  return { ...f, statement: { ...f.statement, message: { ...f.statement.message, ...patch } } };
};

const at = (iso: string): number => Date.parse(iso) / 1000;
/** The fixture's transaction hashes: hashes of these phrases, not of real transactions. */
const txHash = (what: string): Hex => keccak256(stringToBytes(`test case 1: ${what} transaction`));

const CSV = fixtureBytes("test-case-1-report.csv");
const CSV_KECCAK: Hex = "0xadedff9ae723ade4bfc2b287cd6818eb22151ed6a168c50f6df101c97d6cffb5";
/** The job contract's configured default. */
const JOB_CONTRACT = "0x0747EEf0706327138c69792bF28Cd525089e4583";

/** Test case 1 as a contested row: anvil's accounts 1 to 3 as buyer, seller and referee. */
function fixtureRow(): PilotCaseRecord {
  return {
    caseId: "00000000-0000-4000-8000-000000000001",
    label: "TEST-1",
    mode: "testnet",
    status: "contested",
    chainId: 5042002,
    jobContract: JOB_CONTRACT,
    jobId: "17",
    buyerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    buyerAgentId: "1001",
    sellerAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    sellerAgentId: "1002",
    refereeAddress: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    budgetAtomic: "2000000",
    description: fixtureText("test-case-1-description.txt"),
    expiredAt: at("2026-10-27T09:14:05Z"),
    deliverablePath: null,
    deliverableHash: CSV_KECCAK,
    deliverableExtension: "csv",
    createTxHash: txHash("create"),
    fundTxHash: txHash("fund"),
    submitTxHash: txHash("submit"),
    createdBlockTime: at("2026-10-20T09:14:05Z"),
    fundedBlockTime: at("2026-10-20T09:14:31Z"),
    submittedBlockTime: at("2026-10-21T10:02:47Z"),
    contestReason: fixtureText("test-case-1-reason.txt"),
    contestReply: fixtureText("test-case-1-reply.txt"),
    contestedAt: at("2026-10-21T16:40:12Z"),
    buyerRecordPath: null,
    sellerRecordPath: null,
    evidencePath: null,
    evidenceSha256: null,
    evidenceName: null,
    klerosChain: null,
    klerosCourtId: null,
    klerosPolicyUri: null,
    attachmentUri: null,
    attachmentCid: null,
    filingStartedAt: null,
    coreDisputeId: null,
    localDisputeId: null,
    createDisputeTx: null,
    filedAt: null,
    evidenceTx: null,
    evidenceStatus: null,
    rulingStatus: null,
    rulingValue: null,
    rulingTied: null,
    rulingRoundCount: null,
    rulingLabel: null,
    rulingReadAt: null,
    rulingDeadline: null,
    settleAction: null,
    settleReason: null,
    settleTxHash: null,
    settledAt: null,
    escrowOutcome: null,
    error: null,
    createdAt: "2026-10-20 09:13:58",
    updatedAt: "2026-10-21 16:40:12",
  };
}

function fixtureInput(): EvidenceInput {
  return {
    row: fixtureRow(),
    chain: {
      descriptionOnChain: fixtureText("test-case-1-description.txt"),
      submittedDeliverable: CSV_KECCAK,
      networkLabel: "Arc Testnet",
      chainId: 5042002,
      jobContract: JOB_CONTRACT,
      explorerBase: "https://explorer.testnet.arc.io",
    },
    deliverable: { bytes: CSV, extension: "csv" },
    records: { buyer: lookup("buyer"), seller: lookup("seller") },
    lookupBase: "https://api.novicorpus.com",
    arcNetwork: "testnet",
  };
}

/** The input with a different delivered text, its fingerprint recomputed so only the text changes. */
function withDelivered(text: string | Uint8Array, extension = "csv"): EvidenceInput {
  const i = fixtureInput();
  const bytes = typeof text === "string" ? stringToBytes(text) : text;
  return {
    ...i,
    chain: { ...i.chain, submittedDeliverable: keccak256(bytes) },
    deliverable: { bytes, extension },
  };
}

/** What `fn` threw, or undefined when it returned. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/** The EvidenceError's code, or undefined when nothing was thrown. Any other throw fails the test. */
function codeOf(fn: () => unknown): string | undefined {
  const e = thrown(fn);
  if (e === undefined) return undefined;
  if (e instanceof EvidenceError) return e.code;
  throw e;
}

/** A plain Error: an input the record has no approved words for, refused rather than described. */
function expectPlainRefusal(fn: () => unknown): void {
  const e = thrown(fn);
  expect(e).toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(EvidenceError);
}

const render = (i: EvidenceInput = fixtureInput(), opts?: { allowStanding?: string }) =>
  renderEvidence(i, opts).description;

describe("the golden: test case 1", () => {
  const goldenBytes = (): Buffer => readFileSync(join(FIXTURES, "test-case-1-evidence.txt"));

  test("renders byte for byte as the golden file", () => {
    const ev = renderEvidence(fixtureInput());
    const golden = goldenBytes();
    expect(ev.description).toBe(golden.toString("utf8"));
    expect(Buffer.from(ev.description, "utf8").equals(golden)).toBe(true);
  });

  test("is named for the case and carries the description's sha256 and UTF-8 length", () => {
    const ev = renderEvidence(fixtureInput());
    const golden = goldenBytes();
    expect(ev.name).toBe("Job TEST-1: the complete record (test data)");
    expect(ev.byteLength).toBe(golden.length);
    expect(ev.sha256).toBe(`0x${createHash("sha256").update(golden).digest("hex")}`);
  });

  test("takes its dates from the row's block times and the records' checkedAt, none from the test case", () => {
    const d = render();
    expect(d).toContain("created a job on Arc Testnet on 20 October 2026 and paid the price,");
    expect(d).toContain("submitted its delivery on 21 October 2026. The client agent contested it");
    expect(d).toContain("The job expires on 27 October 2026.");
    expect(d).toContain("The client's reason for contesting (21 October 2026):");
    expect(d).toContain("The provider's reply (21 October 2026):");
    expect(d).toContain("snapshot taken when the case was created, 22 October 2026):");
    for (const day of ["8 October 2026", "9 October 2026", "15 October 2026"]) {
      expect(d).not.toContain(day);
    }
  });

  test("renders the same bytes every time", () => {
    expect(renderEvidence(fixtureInput())).toEqual(renderEvidence(fixtureInput()));
  });
});

test("a row dated now renders today's dates", () => {
  const now = Math.floor(Date.now() / 1000);
  const inAWeek = now + 7 * 86_400;
  // An oracle independent of the module, which uses no locale API.
  const day = (s: number) =>
    new Date(s * 1000).toLocaleDateString("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  const i = fixtureInput();
  const checkedAt = new Date(now * 1000).toISOString();
  const d = render({
    ...i,
    row: {
      ...i.row,
      createdBlockTime: now,
      fundedBlockTime: now,
      submittedBlockTime: now,
      contestedAt: now,
      expiredAt: inAWeek,
    },
    records: {
      buyer: { ...i.records.buyer, checkedAt },
      seller: { ...i.records.seller, checkedAt },
    },
  });
  expect(d).toContain(`created a job on Arc Testnet on ${day(now)} and paid the price,`);
  expect(d).toContain(`submitted its delivery on ${day(now)}.`);
  expect(d).toContain(`The job expires on ${day(inAWeek)}.`);
  expect(d).toContain(`for contesting (${day(now)}):`);
  expect(d).toContain(`reply (${day(now)}):`);
  expect(d).toContain(`snapshot taken when the case was created, ${day(now)}):`);
  expect(d).not.toContain("20 October 2026");
});

describe("what the record prints", () => {
  test("the notice, the entity form, the chain id, the contract and both lookup URLs, from the input", () => {
    const i = fixtureInput();
    const chainId = 1234567;
    const jobContract = "0x5555555555555555555555555555555555555555";
    const d = render({
      ...i,
      // The row must agree with the chain (a test below refuses one that does not).
      row: { ...i.row, chainId, jobContract },
      chain: { ...i.chain, chainId, jobContract, explorerBase: "https://explorer.example/" },
      lookupBase: "https://lookup.example/",
    });
    expect(d.startsWith("**TEST DATA.** ")).toBe(true);
    expect(d).toContain("Wyoming DAO LLC");
    expect(d).toContain("- Network: Arc Testnet, chain id 1234567. ");
    expect(d).toContain("Job contract (ERC-8183): 0x5555555555555555555555555555555555555555. ");
    expect(d).toContain("public record https://lookup.example/legal-bodies/by-agent/1001\n");
    expect(d).toContain("public record https://lookup.example/legal-bodies/by-agent/1002\n");
    expect(d).toContain("(explorer: https://explorer.example).");
    expect(d).not.toContain("arcscan");
    expect(d).not.toContain(JOB_CONTRACT);
  });

  test("the description is the chain's, not the row's", () => {
    const i = fixtureInput();
    const d = render({ ...i, row: { ...i.row, description: "A description only the row holds." } });
    expect(d).toContain(`\n"${fixtureText("test-case-1-description.txt")}"\n`);
    expect(d).not.toContain("A description only the row holds.");
  });

  test("no em dash", () => {
    // Built from its code point, so this file holds no em dash either.
    expect(render().includes(String.fromCodePoint(0x2014))).toBe(false);
  });

  test("none of the test case's internal sections", () => {
    const d = render();
    for (const heading of [
      "The ruling we expect",
      "How the policy leads",
      "Appendix",
      "The story",
      "What this test checks",
    ]) {
      expect(d).not.toContain(heading);
    }
  });

  test("the question names the two answers in words", () => {
    expect(render()).toContain(
      'Answer 1, "Pay the provider", or Answer 2, "Refund the client". The dispute policy',
    );
  });

  test("an unverified control reads as not verified", () => {
    const i = fixtureInput();
    for (const patch of [{ guardianHumanVerified: false }, { controlVerified: false }]) {
      const d = render({
        ...i,
        records: { ...i.records, seller: withMessage(i.records.seller, patch) },
      });
      expect(d).toContain(
        '- Provider agent: "Novi Pilot Test Seller DAO LLC" (test entity), a Wyoming DAO LLC, standing active, control not verified on this record.\n',
      );
      expect(d).toContain(
        '- Client agent: "Novi Pilot Test Buyer DAO LLC" (test entity), a Wyoming DAO LLC, standing active, controlled by a person verified as a unique human (World ID).\n',
      );
    }
  });
});

describe("the delivered file", () => {
  test.each(["csv", "txt", "json", "md"])(
    "a .%s file is printed word for word in a fenced block",
    (ext) => {
      const text = '{"day":"2026-10-01","count":3}\n{"day":"2026-10-02","count":4}\n';
      const d = render(withDelivered(text, ext));
      expect(d).toContain(`(see section 8).\n\n\`\`\`\n${text}\`\`\`\n\n**4. `);
      expect(d).toContain(
        `(the ${ext.toUpperCase()} above as a UTF-8 file with LF line endings and one trailing newline, 62 bytes).`,
      );
    },
  );

  test.each([
    ["LF, one trailing newline", "a,b\n1,2\n", "LF line endings and one trailing newline, 8 bytes"],
    ["LF, no trailing newline", "a,b\n1,2", "LF line endings and no trailing newline, 7 bytes"],
    [
      "CRLF, one trailing newline",
      "a,b\r\n1,2\r\n",
      "CRLF line endings and one trailing newline, 10 bytes",
    ],
    [
      "CRLF, no trailing newline",
      "a,b\r\n1,2",
      "CRLF line endings and no trailing newline, 8 bytes",
    ],
  ])("the line-ending note is read from the bytes: %s", (_what, text, note) => {
    const d = render(withDelivered(text));
    expect(d).toContain(`(the CSV above as a UTF-8 file with ${note}).`);
    // The block closes on its own line whether or not the file ends in a line end.
    expect(d).toContain(`\`\`\`\n${text}${text.endsWith("\n") ? "" : "\n"}\`\`\`\n\n**4. `);
  });

  test("a one-byte file is counted as 1 byte", () => {
    const d = render(withDelivered("\n"));
    expect(d).toContain("```\n\n```\n");
    expect(d).toContain("with LF line endings and one trailing newline, 1 byte).");
  });

  test.each([
    ["LF beside CRLF", "a,b\r\n1,2\n"],
    ["a CR on its own", "a,b\r1,2\n"],
    ["a code fence", "a,b\n```\n1,2\n"],
    // No note about these would be true.
    ["no line ending at all", "a,b"],
    ["a blank last line, LF", "a,b\n1,2\n\n"],
    ["a blank last line, CRLF", "a,b\r\n1,2\r\n\r\n"],
  ])(
    "a file the record cannot print faithfully (%s): binary_deliverable_unsupported",
    (_what, text) => {
      expect(codeOf(() => render(withDelivered(text)))).toBe("binary_deliverable_unsupported");
    },
  );
});

describe("refusals", () => {
  test("a mainnet case: mainnet_notice_missing", () => {
    expect(codeOf(() => render({ ...fixtureInput(), arcNetwork: "mainnet" }))).toBe(
      "mainnet_notice_missing",
    );
  });

  test("a fingerprint that is not the delivered bytes' keccak256: hash_mismatch", () => {
    const i = fixtureInput();
    const other = keccak256(stringToBytes("another file"));
    expect(codeOf(() => render({ ...i, chain: { ...i.chain, submittedDeliverable: other } }))).toBe(
      "hash_mismatch",
    );
  });

  test("one changed byte in the CSV flips hash_mismatch", () => {
    const i = fixtureInput();
    expect(codeOf(() => render(i))).toBeUndefined();
    const bytes = new Uint8Array(CSV);
    bytes[40] = bytes[40] === 0x31 ? 0x32 : 0x31;
    expect(codeOf(() => render({ ...i, deliverable: { ...i.deliverable, bytes } }))).toBe(
      "hash_mismatch",
    );
  });

  test("the fingerprint is compared in any letter case", () => {
    const i = fixtureInput();
    const upper = `0x${CSV_KECCAK.slice(2).toUpperCase()}` as Hex;
    expect(codeOf(() => render({ ...i, chain: { ...i.chain, submittedDeliverable: upper } }))).toBe(
      undefined,
    );
  });

  test("another extension, or bytes that are not UTF-8: binary_deliverable_unsupported", () => {
    expect(codeOf(() => render(withDelivered("a,b\n1,2\n", "pdf")))).toBe(
      "binary_deliverable_unsupported",
    );
    expect(codeOf(() => render(withDelivered(new Uint8Array([0x61, 0xff, 0xfe, 0x0a]))))).toBe(
      "binary_deliverable_unsupported",
    );
  });

  test("a record that is not active: record_not_active, on either side", () => {
    const i = fixtureInput();
    const inactive = withMessage(i.records.buyer, { standing: "inactive" });
    const pending = withMessage(i.records.seller, { standing: "pending" });
    expect(codeOf(() => render({ ...i, records: { ...i.records, buyer: inactive } }))).toBe(
      "record_not_active",
    );
    expect(codeOf(() => render({ ...i, records: { ...i.records, seller: pending } }))).toBe(
      "record_not_active",
    );
  });

  test("allowStanding lets exactly that standing through, printed as it is", () => {
    const i = fixtureInput();
    const records = { ...i.records, buyer: withMessage(i.records.buyer, { standing: "inactive" }) };
    expect(render({ ...i, records }, { allowStanding: "inactive" })).toContain(
      '"Novi Pilot Test Buyer DAO LLC" (test entity), a Wyoming DAO LLC, standing inactive, controlled',
    );
    expect(codeOf(() => render({ ...i, records }, { allowStanding: "pending" }))).toBe(
      "record_not_active",
    );
  });

  test("an answer with no legal body or no statement: record_not_active, whatever is allowed", () => {
    const i = fixtureInput();
    const none: ByAgentAnswer = {
      agentId: "1001",
      legalBody: false,
      standing: null,
      checkedAt: "2026-10-22T08:30:04.512Z",
    };
    const unknown: ByAgentAnswer = {
      agentId: "1002",
      legalBody: true,
      standing: "unknown",
      publicId: null,
      network: "testnet",
      links: { transparency: "https://example.invalid/transparency" },
      checkedAt: "2026-10-22T08:30:05.104Z",
      statement: null,
    };
    expect(codeOf(() => render({ ...i, records: { ...i.records, buyer: none } }))).toBe(
      "record_not_active",
    );
    expect(
      codeOf(() =>
        render({ ...i, records: { ...i.records, seller: unknown } }, { allowStanding: "unknown" }),
      ),
    ).toBe("record_not_active");
  });

  test("a refusal names the side, never the record's contents", () => {
    const i = fixtureInput();
    const buyer = withMessage(i.records.buyer, { standing: "inactive" });
    try {
      render({ ...i, records: { ...i.records, buyer } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceError);
      expect((e as Error).message).toContain("buyer");
      expect((e as Error).message).not.toContain("Novi Pilot Test Buyer DAO LLC");
      expect((e as Error).message).not.toContain("inactive");
    }
  });

  test("a 70 KiB reply: too_long", () => {
    const i = fixtureInput();
    const reply = "x".repeat(70 * 1024);
    expect(codeOf(() => render({ ...i, row: { ...i.row, contestReply: reply } }))).toBe("too_long");
  });

  test("both caps count UTF-8 bytes, not characters", () => {
    const i = fixtureInput();
    const base = renderEvidence(i).byteLength;
    // Two bytes per character: under the cap in characters, over it in bytes.
    const room = EVIDENCE_DESCRIPTION_MAX_BYTES - base;
    const reply = `${i.row.contestReply}${"é".repeat(Math.floor(room / 2) + 1)}`;
    expect(reply.length - i.row.contestReply!.length).toBeLessThan(room);
    expect(codeOf(() => render({ ...i, row: { ...i.row, contestReply: reply } }))).toBe("too_long");

    const label = "é".repeat(EVIDENCE_NAME_MAX_BYTES / 2);
    expect(`Job ${label}: the complete record (test data)`.length).toBeLessThan(
      EVIDENCE_NAME_MAX_BYTES,
    );
    expect(codeOf(() => render({ ...i, row: { ...i.row, label } }))).toBe("too_long");
  });

  test("a name of exactly 1024 UTF-8 bytes is accepted, 1025 refused", () => {
    const i = fixtureInput();
    const bytesOf = (s: string) => new TextEncoder().encode(s).length;
    const frame = bytesOf("Job : the complete record (test data)");
    // Three-byte and two-byte characters, then one-byte padding to the cap.
    const wide = `\u20ac${"\u00e9".repeat(200)}`;
    const label = `${wide}${"x".repeat(EVIDENCE_NAME_MAX_BYTES - frame - bytesOf(wide))}`;
    const ev = renderEvidence({ ...i, row: { ...i.row, label } });
    expect(bytesOf(ev.name)).toBe(EVIDENCE_NAME_MAX_BYTES);
    expect(codeOf(() => render({ ...i, row: { ...i.row, label: `${label}x` } }))).toBe("too_long");
  });

  test("a description exactly at the cap renders", () => {
    const i = fixtureInput();
    const base = renderEvidence(i).byteLength;
    const reply = `${i.row.contestReply}${"x".repeat(EVIDENCE_DESCRIPTION_MAX_BYTES - base)}`;
    expect(renderEvidence({ ...i, row: { ...i.row, contestReply: reply } }).byteLength).toBe(
      EVIDENCE_DESCRIPTION_MAX_BYTES,
    );
  });
});

describe("days: a later funding, a later contest, two snapshot days", () => {
  test("on one day each, the approved sentences are unchanged", () => {
    const d = render();
    expect(d).toContain(
      "and paid the price, 2.00 USDC (testnet), into the job's escrow. The provider agent submitted",
    );
    expect(d).toContain("The client agent contested it the same day. The job expires");
    expect(d).toContain(
      "(Novi Corpus records, snapshot taken when the case was created, 22 October 2026):",
    );
  });

  test("a job funded on a later day than it was created names the funding day", () => {
    const i = fixtureInput();
    const d = render({ ...i, row: { ...i.row, fundedBlockTime: at("2026-10-21T00:00:01Z") } });
    expect(d).toContain(
      "The client agent created a job on Arc Testnet on 20 October 2026 and paid the price, 2.00 USDC (testnet), into the job's escrow on 21 October 2026. The provider agent submitted its delivery on 21 October 2026. The client agent contested it the same day.",
    );
  });

  test("a contest on a later day than the delivery names the contest day", () => {
    const i = fixtureInput();
    const d = render({ ...i, row: { ...i.row, contestedAt: at("2026-10-22T00:00:01Z") } });
    expect(d).toContain(
      "The provider agent submitted its delivery on 21 October 2026. The client agent contested it on 22 October 2026. The job expires on 27 October 2026.",
    );
    expect(d).toContain("into the job's escrow. The provider agent");
    expect(d).toContain("The client's reason for contesting (22 October 2026):");
    expect(d).toContain("The provider's reply (22 October 2026):");
    expect(d).not.toContain("the same day");
  });

  test("two records checked on different days name both, the client's first", () => {
    const i = fixtureInput();
    const d = render({
      ...i,
      records: {
        buyer: { ...i.records.buyer, checkedAt: "2026-10-23T00:00:01.000Z" },
        seller: i.records.seller,
      },
    });
    expect(d).toContain(
      "**6. Who answers for each agent** (Novi Corpus records, snapshots taken when the case was created, 23 October 2026 and 22 October 2026):\n",
    );
    expect(d).not.toContain("snapshot taken");
  });
});

describe("rows and records the record cannot be rendered from are refused", () => {
  const i = fixtureInput();
  test.each([
    ["a row that is not contested yet", { ...i, row: { ...i.row, contestReason: null } }],
    ["a row with no submission", { ...i, row: { ...i.row, submitTxHash: null } }],
    ["a budget that is not a decimal", { ...i, row: { ...i.row, budgetAtomic: "2.00" } }],
    [
      "a record that shows no legal name",
      { ...i, records: { ...i.records, buyer: withMessage(i.records.buyer, { legalName: "" }) } },
    ],
    [
      "a record checked at a time that is not an ISO instant",
      { ...i, records: { ...i.records, seller: { ...i.records.seller, checkedAt: "22/10/2026" } } },
    ],
  ] as [string, EvidenceInput][])("%s", (_what, input) => {
    expectPlainRefusal(() => render(input));
  });

  test("a budget finer than a cent is refused by the one sub-cent check, formatUsdc's", () => {
    const i = fixtureInput();
    const e = thrown(() => render({ ...i, row: { ...i.row, budgetAtomic: "2000001" } }));
    expectPlainRefusal(() => render({ ...i, row: { ...i.row, budgetAtomic: "2000001" } }));
    expect((e as Error).message).toBe("formatUsdc: finer than a cent");
  });

  test.each(["createTxHash", "createdBlockTime", "contestReason"] as const)(
    "a missing %s is named in the refusal",
    (column) => {
      const i = fixtureInput();
      const e = thrown(() => render({ ...i, row: { ...i.row, [column]: null } }));
      expectPlainRefusal(() => render({ ...i, row: { ...i.row, [column]: null } }));
      expect((e as Error).message).toBe(`evidence: row.${column} is not set`);
    },
  );

  test.each([
    ["30 February", "2026-02-30T00:00:00.000Z"],
    ["hour 24", "2026-10-22T24:00:00.000Z"],
    ["month 13", "2026-13-01T00:00:00.000Z"],
  ])("a checkedAt that is no real instant (%s) is refused, not rolled over", (_what, checkedAt) => {
    const i = fixtureInput();
    const e = thrown(() =>
      render({ ...i, records: { ...i.records, seller: { ...i.records.seller, checkedAt } } }),
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    expect((e as Error).message).toContain("seller");
    expect((e as Error).message).toContain("checkedAt");
  });

  test.each([
    ["the on-chain description", "descriptionOnChain", "Deliver a CSV report.\n~~~\nThe rest."],
    ["the client's reason", "contestReason", "Deliver a CSV report.\n   ~~~csv\nThe rest."],
    ["the provider's reply", "contestReply", "~~~~\nThe rest."],
  ] as const)(
    "a tilde fence line in %s is refused: it would swallow the sections after it",
    (_what, text, fenced) => {
      const i = fixtureInput();
      const input: EvidenceInput =
        text === "descriptionOnChain"
          ? { ...i, chain: { ...i.chain, descriptionOnChain: fenced } }
          : { ...i, row: { ...i.row, [text]: fenced } };
      const e = thrown(() => render(input));
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(EvidenceError);
      expect((e as Error).message).toContain(text);
    },
  );

  test("tildes inside a line, or indented as code, are no fence and are quoted as they are", () => {
    const i = fixtureInput();
    for (const reply of ["About ~~~ three tildes.", "Indented:\n    ~~~ not a fence"]) {
      expect(render({ ...i, row: { ...i.row, contestReply: reply } })).toContain(`"${reply}"`);
    }
  });

  test.each([
    ["the on-chain description", "descriptionOnChain"],
    ["the client's reason", "contestReason"],
    ["the provider's reply", "contestReply"],
  ] as const)(
    "a code fence in %s is refused: it would swallow the sections after it",
    (_what, text) => {
      const i = fixtureInput();
      const fenced = "Deliver a CSV report.\n```\nThe rest.";
      const input: EvidenceInput =
        text === "descriptionOnChain"
          ? { ...i, chain: { ...i.chain, descriptionOnChain: fenced } }
          : { ...i, row: { ...i.row, [text]: fenced } };
      const e = thrown(() => render(input));
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(EvidenceError);
      expect((e as Error).message).toContain(text);
    },
  );
});

describe("the contest: no reply, and a box clock behind the chain's", () => {
  test("a row with no reply renders that the provider gave none, and nothing else changes", () => {
    const i = fixtureInput();
    const golden = readFileSync(join(FIXTURES, "test-case-1-evidence.txt"), "utf8");
    const replied = `**5. The provider's reply (21 October 2026):** "${i.row.contestReply}"\n`;
    expect(golden).toContain(replied);
    const d = render({ ...i, row: { ...i.row, contestReply: null } });
    expect(d).toBe(
      golden.replace(replied, "**5. The provider's reply:** The provider gave no reply.\n"),
    );
  });

  test("a contest 300 s before the delivery renders, dated as the delivery", () => {
    const i = fixtureInput();
    const contestedAt = i.row.submittedBlockTime! - 300;
    const d = render({ ...i, row: { ...i.row, contestedAt } });
    expect(d).toContain("The client agent contested it the same day.");
    expect(d).toContain("The client's reason for contesting (21 October 2026):");
  });

  test("a contest 301 s before the delivery is refused", () => {
    const i = fixtureInput();
    const contestedAt = i.row.submittedBlockTime! - 301;
    const e = thrown(() => render({ ...i, row: { ...i.row, contestedAt } }));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    expect((e as Error).message).toContain("row.contestedAt");
  });

  test("a skewed contest across midnight never names a day before the delivery", () => {
    const i = fixtureInput();
    const submittedBlockTime = at("2026-10-22T00:01:00Z");
    const d = render({
      ...i,
      row: { ...i.row, submittedBlockTime, contestedAt: at("2026-10-21T23:59:00Z") },
    });
    expect(d).toContain(
      "The provider agent submitted its delivery on 22 October 2026. The client agent contested it the same day.",
    );
    expect(d).toContain("The client's reason for contesting (22 October 2026):");
    expect(d).toContain("The provider's reply (22 October 2026):");
    expect(d).not.toContain("21 October 2026");
  });
});

describe("a row that would make the record say something false is refused", () => {
  const r = fixtureRow();
  test.each([
    [
      "funded before it was created",
      { fundedBlockTime: r.createdBlockTime! - 1 },
      "fundedBlockTime",
      "createdBlockTime",
    ],
    [
      "delivered before it was funded",
      { submittedBlockTime: r.fundedBlockTime! - 1 },
      "submittedBlockTime",
      "fundedBlockTime",
    ],
    [
      "contested more than 300 s before it was delivered",
      { contestedAt: r.submittedBlockTime! - 301 },
      "contestedAt",
      "submittedBlockTime",
    ],
    ["expiring when it was contested", { expiredAt: r.contestedAt! }, "expiredAt", "contestedAt"],
    [
      "expiring before it was contested",
      { expiredAt: r.contestedAt! - 1 },
      "expiredAt",
      "contestedAt",
    ],
  ] as [string, Partial<PilotCaseRecord>, string, string][])(
    "a job %s",
    (_what, patch, later, earlier) => {
      const i = fixtureInput();
      const e = thrown(() => render({ ...i, row: { ...i.row, ...patch } }));
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(EvidenceError);
      const message = (e as Error).message;
      expect(message).toContain(`row.${later}`);
      expect(message).toContain(`row.${earlier}`);
      // Names the columns, never their values.
      expect(message).not.toMatch(/\d/);
    },
  );

  test("a row on another chain than the configured one", () => {
    const i = fixtureInput();
    const e = thrown(() => render({ ...i, chain: { ...i.chain, chainId: 1234567 } }));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    expect((e as Error).message).toContain("row.chainId");
    expect((e as Error).message).not.toContain("1234567");
  });

  test("a row on another job contract than the configured one", () => {
    const i = fixtureInput();
    const other = "0x5555555555555555555555555555555555555555";
    const e = thrown(() => render({ ...i, chain: { ...i.chain, jobContract: other } }));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    expect((e as Error).message).toContain("row.jobContract");
    expect((e as Error).message).not.toContain(other);
  });

  test("the job contract is compared in any letter case and printed as configured", () => {
    const i = fixtureInput();
    const d = render({ ...i, row: { ...i.row, jobContract: JOB_CONTRACT.toLowerCase() } });
    expect(d).toContain(`Job contract (ERC-8183): ${JOB_CONTRACT}. `);
  });
});

describe("the records are the two parties' own, from the sandbox", () => {
  test("a record of another environment than the sandbox is refused", () => {
    const i = fixtureInput();
    const buyer = withMessage(i.records.buyer, { environment: "production" });
    const e = thrown(() => render({ ...i, records: { ...i.records, buyer } }));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    expect((e as Error).message).toContain("buyer");
    expect((e as Error).message).toContain("environment");
  });

  test("the two answers swapped are refused", () => {
    const i = fixtureInput();
    const e = thrown(() =>
      render({ ...i, records: { buyer: i.records.seller, seller: i.records.buyer } }),
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    expect((e as Error).message).toContain("agentId");
  });

  test("a statement signed for another agent is refused, naming the side and the field, not the ids", () => {
    const i = fixtureInput();
    const buyer = withMessage(i.records.buyer, { agentId: "9999" });
    const e = thrown(() => render({ ...i, records: { ...i.records, buyer } }));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    const message = (e as Error).message;
    expect(message).toContain("buyer");
    expect(message).toContain("statement.message.agentId");
    expect(message).not.toContain("9999");
    expect(message).not.toContain("1001");
  });

  test("an answer for another agent is refused, naming the side and the field, not the ids", () => {
    const i = fixtureInput();
    const e = thrown(() =>
      render({ ...i, records: { ...i.records, seller: { ...i.records.seller, agentId: "9999" } } }),
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(EvidenceError);
    const message = (e as Error).message;
    expect(message).toContain("seller");
    expect(message).toContain("agentId");
    expect(message).not.toContain("9999");
    expect(message).not.toContain("1002");
  });
});

describe("the lookup fixtures", () => {
  test("have the found answer's shape, every statement field and the test names", () => {
    for (const side of ["buyer", "seller"] as const) {
      const a = lookup(side) as FoundAnswer;
      expect(Object.keys(a).sort()).toEqual([
        "agentId",
        "checkedAt",
        "legalBody",
        "links",
        "network",
        "publicId",
        "standing",
        "statement",
      ]);
      expect(Object.keys(a.statement).sort()).toEqual([
        "attestor",
        "domain",
        "message",
        "primaryType",
        "signature",
      ]);
      expect(Object.keys(a.statement.message).sort()).toEqual(
        LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement.map((f) => f.name).sort(),
      );
      expect(a.statement.message.oaManifestHash).toBe(
        keccak256(stringToBytes(`SENTINEL-${side}-oaManifestHash`)),
      );
      expect(a.statement.message.environment).toBe("sandbox");
      const rowAgentId = side === "buyer" ? fixtureRow().buyerAgentId : fixtureRow().sellerAgentId;
      expect(a.agentId).toBe(rowAgentId);
      expect(a.statement.message.agentId).toBe(rowAgentId);
    }
    const buyer = (lookup("buyer") as FoundAnswer).statement.message;
    const seller = (lookup("seller") as FoundAnswer).statement.message;
    expect([buyer.legalName, buyer.filingNumber]).toEqual([
      "Novi Pilot Test Buyer DAO LLC",
      "TEST-PILOT-BUYER-01",
    ]);
    expect([seller.legalName, seller.filingNumber]).toEqual([
      "Novi Pilot Test Seller DAO LLC",
      "TEST-PILOT-SELLER-01",
    ]);
  });

  /** The answer's fields the record prints (legalName, standing and checkedAt; the two control
   *  flags are booleans), and those whose type is a fixed list of words, so no sentinel can stand
   *  in them. Every other string of a fixture answer is a value the output must not contain. */
  const PRINTED_OR_ENUMERATED = new Set([
    // Read to refuse a record for another agent, never printed; they hold the row's agent id,
    // which section 8 prints from the row.
    "agentId",
    "statement.message.agentId",
    "checkedAt",
    "statement.message.legalName",
    "statement.message.standing",
    "standing",
    "network",
    "statement.primaryType",
    "statement.message.bindingState",
    "statement.message.attestationState",
    "statement.message.jurisdiction",
    "statement.message.entityType",
    "statement.message.source",
    "statement.message.environment",
    "statement.message.filingStatus",
    "statement.message.lastFiledConfirmedBy",
  ]);
  const stringLeaves = (v: unknown, path: string): [string, string][] => {
    if (typeof v === "string") return [[path, v]];
    if (typeof v !== "object" || v === null) return [];
    return Object.entries(v).flatMap(([k, c]) => stringLeaves(c, path === "" ? k : `${path}.${k}`));
  };

  test("no field of an answer but the five named ones reaches the output", () => {
    const d = render().toLowerCase();
    for (const side of ["buyer", "seller"] as const) {
      const others = stringLeaves(lookup(side), "").filter(([p]) => !PRINTED_OR_ENUMERATED.has(p));
      // 3 at the top, 2 in the domain, 17 in the message, the attestor and the signature.
      expect(others).toHaveLength(24);
      expect(new Set(others.map(([, v]) => v)).size).toBe(24);
      for (const [path, value] of others) {
        expect(d, `${side} ${path}`).not.toContain(value.toLowerCase());
      }
    }
    // The control: the five named ones are there.
    expect(d).toContain('"novi pilot test buyer dao llc" (test entity)');
    expect(d).toContain('"novi pilot test seller dao llc" (test entity)');
    expect(d).toContain("standing active, controlled by a person verified as a unique human");
    expect(d).toContain("snapshot taken when the case was created, 22 october 2026)");
  });
});

describe("the source", () => {
  test("no file under src/ holds the test case's internal sections", () => {
    const files = readdirSync(SRC, { recursive: true, withFileTypes: true }).filter((f) =>
      f.isFile(),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(f.parentPath, f.name), "utf8");
      for (const heading of [
        "The ruling we expect",
        "How the policy leads",
        "The story in plain words",
        "What this test checks",
        "Appendix for Kleros",
      ]) {
        expect(text, f.name).not.toContain(heading);
      }
    }
  });

  test("the evidence module holds no literal date", () => {
    const source = readFileSync(join(SRC, "pilot", "evidence.ts"), "utf8");
    expect(source).not.toMatch(/\b(19|20)\d\d\b/);
    expect(source).not.toMatch(
      /\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)\b/,
    );
  });
});

describe("formatUtcDate", () => {
  test("renders D Month YYYY in UTC, whatever the hour", () => {
    expect(formatUtcDate(at("2026-10-09T00:00:00Z"))).toBe("9 October 2026");
    expect(formatUtcDate(at("2026-10-09T23:59:59Z"))).toBe("9 October 2026");
    expect(formatUtcDate(at("2028-02-29T12:00:00Z"))).toBe("29 February 2028");
    expect(formatUtcDate(at("2026-12-31T23:59:59Z"))).toBe("31 December 2026");
    expect(formatUtcDate(0)).toBe("1 January 1970");
  });

  test("names every month as an English UTC date does", () => {
    for (let m = 0; m < 12; m++) {
      const s = Date.UTC(2027, m, 15, 6) / 1000;
      expect(formatUtcDate(s)).toBe(
        new Date(s * 1000).toLocaleDateString("en-GB", {
          timeZone: "UTC",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
      );
    }
  });

  test("refuses a time that is not a whole, non-negative number of seconds", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatUtcDate(bad)).toThrow();
    }
  });
});

describe("formatUsdc", () => {
  test("prints atomic units (6 decimals) with exactly two decimals", () => {
    expect(formatUsdc(2_000_000n)).toBe("2.00");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(1_230_000n)).toBe("1.23");
    expect(formatUsdc(50_000n)).toBe("0.05");
    expect(formatUsdc(1_000_000_000_000n)).toBe("1000000.00");
  });

  test("refuses an amount it would have to round, or a negative one", () => {
    for (const bad of [1n, 12_345n, 2_000_001n]) {
      expect(() => formatUsdc(bad)).toThrow("formatUsdc: finer than a cent");
    }
    expect(() => formatUsdc(-1_000_000n)).toThrow("formatUsdc: a negative amount");
  });
});
