/**
 * The one way a sign screen gets typed data for the wallet: the gate runs the field-by-field check
 * on the served answer and converts only what passed. A spy stands in for the wallet's
 * `signTypedDataAsync` and pins that typed data the check refused never reaches it, and that what
 * passed reaches it exactly once, as converted.
 *
 * The served statement is written out by hand for the live testnet deployment (chain 5042002, its
 * public factory), with anvil's first published account as the guardian and an invented test
 * company.
 */
import { describe, expect, test, vi } from "vitest";
import type { Hex, StatementMessageAnswer } from "@/lib/api/types";
import { signThroughGate, statementSignGate, type SignGate } from "@/lib/legalBody/signGate";
import { toWagmiStatementTypedData, type WagmiStatementTypedData } from "@/lib/legalBody/typedData";

const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const CHAIN = 5042002;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const SERVER_NOW = 1_791_000_000;
const COMPANY = "Example Test Holdings LLC";
const NUMBER = "TEST-0001";
const WORDING = "2026-10-draft-1";
const SIGNATURE = `0x${"ab".repeat(65)}` as Hex;

type Loose = Record<string, unknown>;
type Parts = { served: Loose; domain: Loose; message: Loose };

const sentence = (company: string, number: string, guardian: string) =>
  `I, "Novi Sandbox Declarant", "Manager" of "${company}", a Wyoming limited liability company ` +
  `with filing number "${number}", declare that I am authorised to bind that company, and that ` +
  `the wallet ${guardian} acts as its guardian for this legal body.`;

/** The statement-message door's answer on a sandbox, bent by `bend` when given. */
function served(bend?: (p: Parts) => void): StatementMessageAnswer {
  const domain: Loose = {
    name: "Novi Corpus Statement of Authority",
    version: "1",
    chainId: CHAIN,
    verifyingContract: FACTORY,
  };
  const message: Loose = {
    statement: sentence(COMPANY, NUMBER, GUARDIAN),
    declarantName: "Novi Sandbox Declarant",
    declarantTitle: "Manager",
    companyName: COMPANY,
    jurisdiction: "WY",
    filingNumber: NUMBER,
    guardian: GUARDIAN,
    wordingVersion: WORDING,
    issuedAt: String(SERVER_NOW),
  };
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    StatementOfAuthority: [
      { name: "statement", type: "string" },
      { name: "declarantName", type: "string" },
      { name: "declarantTitle", type: "string" },
      { name: "companyName", type: "string" },
      { name: "jurisdiction", type: "string" },
      { name: "filingNumber", type: "string" },
      { name: "guardian", type: "address" },
      { name: "wordingVersion", type: "string" },
      { name: "issuedAt", type: "uint256" },
    ],
  };
  const out: Loose = {
    typedData: { domain, types, primaryType: "StatementOfAuthority", message },
    wordingVersion: WORDING,
    textStatus: "draft",
  };
  bend?.({ served: out, domain, message });
  return out as unknown as StatementMessageAnswer;
}

const ctx = {
  config: { chainId: CHAIN, factory: FACTORY },
  sessionAddress: GUARDIAN,
  typed: { companyName: COMPANY, filingNumber: NUMBER, synthetic: true },
  nowSeconds: SERVER_NOW,
};

/** A wallet that signs whatever it is handed. */
const wallet = () => vi.fn<(typedData: WagmiStatementTypedData) => Promise<Hex>>(async () => SIGNATURE);

describe("statementSignGate", () => {
  test("a statement that passes the check comes out converted for wagmi", () => {
    const answer = served();
    const gate = statementSignGate(answer, ctx);
    expect(gate).toEqual({ ok: true, typedData: toWagmiStatementTypedData(answer.typedData) });
    if (!gate.ok) throw new Error("unreachable");
    expect(gate.typedData.message.issuedAt).toBe(BigInt(SERVER_NOW));
    expect(Object.keys(gate.typedData.types)).toEqual(["StatementOfAuthority"]);
  });

  test("a statement the check refuses comes out as the refusal, with no typed data", () => {
    const gate = statementSignGate(served(({ domain }) => (domain.verifyingContract = ANOTHER_FACTORY)), ctx);
    expect(gate).toEqual({ ok: false, problem: "domain_factory" });
    expect("typedData" in gate).toBe(false);
  });

  test("a served answer that is not even an object is a refusal, never a throw", () => {
    expect(statementSignGate(null as unknown as StatementMessageAnswer, ctx)).toEqual({
      ok: false,
      problem: "primary_type",
    });
  });
});

describe("signThroughGate: refused typed data never reaches the wallet", () => {
  const refusals: [string, StatementMessageAnswer, typeof ctx, string][] = [
    ["another verifying contract", served(({ domain }) => (domain.verifyingContract = ANOTHER_FACTORY)), ctx, "domain_factory"],
    ["another chain", served(({ domain }) => (domain.chainId = 5042)), ctx, "domain_chain"],
    [
      "another guardian",
      served(({ message }) => {
        message.guardian = OTHER_WALLET;
        message.statement = sentence(COMPANY, NUMBER, OTHER_WALLET);
      }),
      ctx,
      "guardian",
    ],
    ["another company than the one typed", served(), { ...ctx, typed: { ...ctx.typed, companyName: "Other Test LLC" } }, "company_name"],
    ["another number than the one typed", served(), { ...ctx, typed: { ...ctx.typed, filingNumber: "TEST-0002" } }, "filing_number"],
    ["a statement issued eleven minutes ago", served(), { ...ctx, nowSeconds: SERVER_NOW + 660 }, "issued_at_window"],
    ["a wording version the answer does not name", served(({ served: s }) => (s.wordingVersion = "2026-10-draft-2")), ctx, "wording_version"],
    ["a sentence about another wallet", served(({ message }) => (message.statement = sentence(COMPANY, NUMBER, OTHER_WALLET))), ctx, "sentence"],
  ];

  test.each(refusals)("%s: the wallet is never called", async (_name, answer, context, problem) => {
    const sign = wallet();
    const outcome = await signThroughGate(statementSignGate(answer, context), sign);
    expect(outcome).toEqual({ kind: "refused", problem });
    expect(sign).not.toHaveBeenCalled();
  });

  test("a statement that passes reaches the wallet once, exactly as converted", async () => {
    const answer = served();
    const sign = wallet();
    const gate = statementSignGate(answer, ctx);
    const outcome = await signThroughGate(gate, sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toEqual(toWagmiStatementTypedData(answer.typedData));
    expect(outcome).toEqual({
      kind: "signed",
      typedData: toWagmiStatementTypedData(answer.typedData),
      signature: SIGNATURE,
    });
  });

  test("a wallet that does not sign is a decline, and nothing is thrown", async () => {
    const sign = vi.fn(async (): Promise<Hex> => {
      throw new Error("User rejected the request.");
    });
    const outcome = await signThroughGate(statementSignGate(served(), ctx), sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "declined" });
  });

  test("the gate's shape carries any typed data: a refused gate of another kind is refused the same way", async () => {
    const gate: SignGate<{ anything: true }> = { ok: false, problem: "agent_id" };
    const sign = vi.fn(async (): Promise<Hex> => SIGNATURE);
    expect(await signThroughGate(gate, sign)).toEqual({ kind: "refused", problem: "agent_id" });
    expect(sign).not.toHaveBeenCalled();
  });
});
