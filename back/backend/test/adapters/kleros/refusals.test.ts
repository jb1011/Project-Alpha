/**
 * The refusal tables of the Kleros Dispute Service, pinned against its docs ("One dispute, from
 * creation to a ruling", section "When something goes wrong").
 *
 * A refusal carries no code field: the code is the leading `CODE:` phrase of the text, and the
 * docs give one closed list per write tool of the codes that mean nothing left the service.
 * Everything outside a list is "maybe", because a filing or a submission retried on a guess can
 * pay a second fee or record a second document. These tests pin the three lists verbatim, the
 * per-tool reading (a code safe on one tool is not safe on another), and the parse of the code.
 */
import { describe, expect, it } from "vitest";
import {
  CREATE_NOT_SENT,
  KlerosHttpError,
  KlerosRefusal,
  KlerosTransportError,
  KlerosWrongDeploymentError,
  PIN_NOT_PUBLISHED,
  PRESET_SIMULATES,
  SUBMIT_NOT_SENT,
  type WriteTool,
  leadingCode,
  sentOf,
} from "../../../src/adapters/kleros/errors";

const TOOLS: WriteTool[] = ["dispute_create", "evidence_pin", "evidence_submit"];

describe("leadingCode", () => {
  it.each([
    ["INSUFFICIENT_BALANCE: the wallet cannot cover the arbitration fee", "INSUFFICIENT_BALANCE"],
    ["WRITE_IN_PROGRESS: another write on this key is still running", "WRITE_IN_PROGRESS"],
    ["TRANSACTION_REVERTED: mined and failed (tx 0xabc)", "TRANSACTION_REVERTED"],
    ["KEY_FILE_MISSING: the signer is missing", "KEY_FILE_MISSING"],
    ["UNKNOWN: preset misconfigured", "UNKNOWN"],
    ["PRESET_SIMULATES: the service answered simulated", PRESET_SIMULATES],
    ["  FILE_TOO_LARGE: the limit is 10 MiB", "FILE_TOO_LARGE"],
    ["\nDISPUTE_NOT_FOUND: no such dispute", "DISPUTE_NOT_FOUND"],
    ["ERC8183_THING: a code with digits", "ERC8183_THING"],
    ["ABC: the shortest code the pattern admits", "ABC"],
  ])("reads the code of %j", (text, code) => {
    expect(leadingCode(text)).toBe(code);
  });

  it.each([
    ["The filing did not finish in three minutes and was stopped."],
    ["The content needs repinning. IPFS_UNAVAILABLE: try again"],
    ["Insufficient_Balance: mixed case is prose"],
    ["insufficient_balance: lower case is prose"],
    ["INSUFFICIENT_BALANCE the wallet is empty (no colon)"],
    ["INSUFFICIENT_BALANCE : a space before the colon"],
    ["AB: two letters are too short"],
    ["1ABC: a code never starts with a digit"],
    ["_ABC: a code never starts with an underscore"],
    [""],
  ])("finds no code in %j", (text) => {
    expect(leadingCode(text)).toBeNull();
  });
});

describe("KlerosRefusal", () => {
  it("keeps the tool and the text, and reads the code from the text", () => {
    const r = new KlerosRefusal(
      "dispute_create",
      "COST_CEILING_EXCEEDED: the fee is above the ceiling",
    );
    expect(r).toBeInstanceOf(Error);
    expect(r.name).toBe("KlerosRefusal");
    expect(r.tool).toBe("dispute_create");
    expect(r.text).toBe("COST_CEILING_EXCEEDED: the fee is above the ceiling");
    expect(r.message).toBe("COST_CEILING_EXCEEDED: the fee is above the ceiling");
    expect(r.code).toBe("COST_CEILING_EXCEEDED");
  });

  it("has a null code when the text is prose", () => {
    const r = new KlerosRefusal("evidence_pin", "Something went wrong while pinning.");
    expect(r.code).toBeNull();
    expect(sentOf("evidence_pin", r.code)).toBe("maybe");
  });
});

describe("the three lists, verbatim from the docs", () => {
  it("dispute_create: nothing was sent", () => {
    expect(CREATE_NOT_SENT).toEqual([
      "INSUFFICIENT_BALANCE",
      "COST_CEILING_EXCEEDED",
      "ZERO_ADDRESS_ALIAS",
      "ALIASES_REQUIRED",
      "UNKNOWN_ALIAS_SLOT",
      "INVALID_ALIASES",
      "TEMPLATE_INVALID",
      "POLICY_URI_INVALID",
      "RULING_OPTIONS_INVALID",
      "COURT_OUT_OF_RANGE",
      "JURORS_INVALID",
      "CHAIN_NOT_SUPPORTED",
      "UNKNOWN",
      "VALIDATION_ERROR",
      "KEY_FILE_MISSING",
      "KEY_FILE_PERMISSIONS",
      "WRITE_IN_PROGRESS",
    ]);
  });

  it("evidence_submit: nothing was sent", () => {
    expect(SUBMIT_NOT_SENT).toEqual([
      "DISPUTE_INVALID",
      "NAME_INVALID",
      "DESCRIPTION_INVALID",
      "FILE_URI_INVALID",
      "EXTENSION_INVALID",
      "EVIDENCE_INVALID",
      "DISPUTE_NOT_FOUND",
      "DISPUTE_NOT_ADDRESSABLE",
      "SIMULATION_REVERTED",
      "INSUFFICIENT_BALANCE",
      "WRONG_CHAIN",
      "NUMBER_INVALID",
      "CHAIN_NOT_SUPPORTED",
      "UNKNOWN",
      "VALIDATION_ERROR",
      "KEY_FILE_MISSING",
      "KEY_FILE_PERMISSIONS",
      "KEY_FILE_UNREADABLE",
      "KEY_FILE_INVALID",
      "WRITE_IN_PROGRESS",
    ]);
  });

  it("evidence_pin: nothing was published", () => {
    expect(PIN_NOT_PUBLISHED).toEqual([
      "ATTACHMENT_INVALID",
      "EXTENSION_INVALID",
      "FILE_UNREADABLE",
      "FILE_EMPTY",
      "FILE_TOO_LARGE",
      "UNKNOWN",
      "VALIDATION_ERROR",
    ]);
  });

  it("cannot be changed at run time", () => {
    for (const list of [CREATE_NOT_SENT, SUBMIT_NOT_SENT, PIN_NOT_PUBLISHED]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => (list as string[]).push("TRANSACTION_REVERTED")).toThrow(TypeError);
    }
  });
});

describe("sentOf", () => {
  it.each(CREATE_NOT_SENT.map((c) => [c]))("dispute_create %s is no", (code) => {
    expect(sentOf("dispute_create", code)).toBe("no");
  });

  it.each(SUBMIT_NOT_SENT.map((c) => [c]))("evidence_submit %s is no", (code) => {
    expect(sentOf("evidence_submit", code)).toBe("no");
  });

  it.each(PIN_NOT_PUBLISHED.map((c) => [c]))("evidence_pin %s is no", (code) => {
    expect(sentOf("evidence_pin", code)).toBe("no");
  });

  it.each(TOOLS.map((t) => [t]))("WRITE_IN_PROGRESS and PRESET_SIMULATES are no on %s", (tool) => {
    expect(sentOf(tool, "WRITE_IN_PROGRESS")).toBe("no");
    expect(sentOf(tool, PRESET_SIMULATES)).toBe("no");
  });

  it("TRANSACTION_REVERTED is maybe on both chain writes, on purpose", () => {
    // No dispute and no document exist after a revert, but a second attempt is a human's call
    // once they have read why it reverted, so the code never reads it as safe to repeat.
    expect(sentOf("dispute_create", "TRANSACTION_REVERTED")).toBe("maybe");
    expect(sentOf("evidence_submit", "TRANSACTION_REVERTED")).toBe("maybe");
  });

  it.each([
    ["dispute_create", "FILING_TIMED_OUT"],
    ["dispute_create", "FILING_CHILD_FAILED"],
    ["dispute_create", "FILING_FAILED"],
    ["evidence_submit", "BROADCAST_FAILED"],
    ["evidence_submit", "RPC_ERROR"],
    ["evidence_submit", "SUBMISSION_TIMED_OUT"],
    ["evidence_submit", "SUBMISSION_CHILD_FAILED"],
    ["evidence_submit", "SUBMISSION_FAILED"],
    ["evidence_pin", "UPLOAD_FAILED"],
    ["evidence_pin", "UPLOAD_MISMATCH"],
    ["evidence_pin", "PIN_TIMED_OUT"],
    ["evidence_pin", "PIN_CHILD_FAILED"],
    ["evidence_pin", "PIN_FAILED"],
  ] as [WriteTool, string][])("the documented in-doubt %s %s is maybe", (tool, code) => {
    expect(sentOf(tool, code)).toBe("maybe");
  });

  it.each(TOOLS.map((t) => [t]))("an unlisted code and a missing code are maybe on %s", (tool) => {
    expect(sentOf(tool, "A_CODE_NEVER_DOCUMENTED")).toBe("maybe");
    expect(sentOf(tool, null)).toBe("maybe");
  });

  it.each([
    // The docs ask for the tables to be read per step, not as one vocabulary.
    ["evidence_submit", "COST_CEILING_EXCEEDED"],
    ["evidence_submit", "ZERO_ADDRESS_ALIAS"],
    ["dispute_create", "DISPUTE_NOT_FOUND"],
    ["dispute_create", "KEY_FILE_UNREADABLE"],
    ["dispute_create", "EXTENSION_INVALID"],
    ["evidence_submit", "FILE_TOO_LARGE"],
    ["evidence_pin", "INSUFFICIENT_BALANCE"],
    ["evidence_pin", "KEY_FILE_MISSING"],
    ["evidence_pin", "CHAIN_NOT_SUPPORTED"],
  ] as [WriteTool, string][])("%s %s is maybe: listed for another tool only", (tool, code) => {
    expect(sentOf(tool, code)).toBe("maybe");
  });

  it("matches the whole code, never a prefix or a lower-case spelling", () => {
    expect(sentOf("dispute_create", "INSUFFICIENT_BALANCE_SOON")).toBe("maybe");
    expect(sentOf("dispute_create", "insufficient_balance")).toBe("maybe");
  });
});

describe("the other errors", () => {
  it("KlerosWrongDeploymentError names both chains", () => {
    const e = new KlerosWrongDeploymentError("arbitrum-sepolia-testnet", "fake");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("KlerosWrongDeploymentError");
    expect(e.expected).toBe("arbitrum-sepolia-testnet");
    expect(e.got).toBe("fake");
    expect(e.message).toContain("arbitrum-sepolia-testnet");
    expect(e.message).toContain("fake");
  });

  it("KlerosHttpError keeps the status and the body", () => {
    const e = new KlerosHttpError(429, '{"error":"rate limited"}');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("KlerosHttpError");
    expect(e.status).toBe(429);
    expect(e.body).toBe('{"error":"rate limited"}');
    expect(e.message).toContain("429");
  });

  it("KlerosTransportError is a named Error that can carry a cause", () => {
    const cause = new Error("socket hang up");
    const e = new KlerosTransportError("dispute_get did not answer within 30000ms", { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("KlerosTransportError");
    expect(e.message).toBe("dispute_get did not answer within 30000ms");
    expect(e.cause).toBe(cause);
  });
});
