/**
 * The two typed data a person signs in the legal-body flow, checked before a wallet opens: the
 * link and the statement of authority. Both are written out here by hand, in the shapes the
 * backend serves, for the live testnet deployment (chain 5042002, its factory, agent 897126) with
 * anvil's first account as the guardian. Then: one refusing case per rule and per clause of a
 * rule, the order the rules are checked in, the clock windows at their edges, the declared text's
 * spaces, and the converted forms against the served digests.
 */
import { describe, expect, test } from "vitest";
import { hashTypedData } from "viem";
import type { UseSignTypedDataReturnType } from "wagmi";
import {
  assertLinkTypedData,
  assertStatementTypedData,
  CLOCK_SKEW_SECONDS,
  LINK_DOMAIN_NAME,
  MIN_LINK_REMAINING_SECONDS,
  normaliseDeclaredText,
  STATEMENT_DOMAIN_NAME,
  STATEMENT_FIELDS,
  STATEMENT_MAX_AGE_SECONDS,
  STATEMENT_MAX_AHEAD_SECONDS,
  toWagmiLinkTypedData,
  toWagmiStatementTypedData,
} from "@/lib/legalBody/typedData";
import {
  EIP712_DOMAIN_FIELDS,
  LINK_FIELDS,
  type LegalBodyOrderView,
  type LinkMessageResult,
  type LinkTypedDataWire,
  type StatementMessageAnswer,
  type StatementTypedDataWire,
} from "@/lib/api/types";

/** The public testnet factory and the live test body's identity. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_AGENT = "897126";
const CHAIN = 5042002;
/** Two of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** Inventions. */
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const MANIFEST = `0x${"9c".repeat(32)}` as const;
/** The chain's clock when the link was served, and the server's when the statement was. */
const CHAIN_NOW = 1_791_000_000;
const SERVER_NOW = 1_791_000_000;
/** `/config.legalBodies.linkTtl.max`. */
const TTL_MAX = 85_800;

const lower = (a: string) => a.toLowerCase();

// ---------------------------------------------------------------------------------------------
// The served forms, by hand
// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

/** Fresh each call, so a case can bend its own copy. */
const domainFields = () => [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const linkFields = () => [
  { name: "agentId", type: "uint256" },
  { name: "guardian", type: "address" },
  { name: "amendmentDelay", type: "uint256" },
  { name: "operatingAgreementHash", type: "bytes32" },
  { name: "deadline", type: "uint256" },
];
const statementFields = () => [
  { name: "statement", type: "string" },
  { name: "declarantName", type: "string" },
  { name: "declarantTitle", type: "string" },
  { name: "companyName", type: "string" },
  { name: "jurisdiction", type: "string" },
  { name: "filingNumber", type: "string" },
  { name: "guardian", type: "address" },
  { name: "wordingVersion", type: "string" },
  { name: "issuedAt", type: "uint256" },
];

type Parts = { served: Loose; typedData: Loose; domain: Loose; types: Loose; message: Loose };

/** The link door's answer for agent 897126, a one-hour deadline by the chain's clock. */
function linkServed(bend?: (p: Parts) => void, deadline = CHAIN_NOW + 3_600): LinkMessageResult {
  const domain: Loose = {
    name: "Novi LegalBodyFactory",
    version: "1",
    chainId: CHAIN,
    verifyingContract: FACTORY,
  };
  const types: Loose = { EIP712Domain: domainFields(), LegalBodyLink: linkFields() };
  const message: Loose = {
    agentId: LIVE_AGENT,
    guardian: GUARDIAN,
    amendmentDelay: "172800",
    operatingAgreementHash: MANIFEST,
    deadline: String(deadline),
  };
  const typedData: Loose = { domain, types, primaryType: "LegalBodyLink", message };
  const served: Loose = { typedData, identityOwner: GUARDIAN, deadline };
  bend?.({ served, typedData, domain, types, message });
  return served as unknown as LinkMessageResult;
}

/** A draft order on the live deployment, before its reservation: the identity is the person's
 *  local pick until the link is submitted. */
const draftOrder = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lb_a",
  publicId: "pub_a",
  companyId: "co_a",
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: MANIFEST, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: "2026-10-12T10:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

type LinkCtx = Parameters<typeof assertLinkTypedData>[1];
const linkCtx = (over: Partial<LinkCtx> = {}): LinkCtx => ({
  order: draftOrder(),
  agreement: { manifestHash: MANIFEST },
  sessionAddress: GUARDIAN,
  agentId: LIVE_AGENT,
  nowSeconds: CHAIN_NOW,
  linkTtlMax: TTL_MAX,
  ...over,
});

/** The statement's wording "2026-10-draft-1" with the sandbox declarant, rendered by hand. */
const sentence = (company: string, number: string, guardian: string) =>
  `I, "Novi Sandbox Declarant", "Manager" of "${company}", a Wyoming limited liability company ` +
  `with filing number "${number}", declare that I am authorised to bind that company, and that ` +
  `the wallet ${guardian} acts as its guardian for this legal body.`;
const COMPANY = "Example Test Holdings LLC";
const NUMBER = "TEST-0001";
const WORDING = "2026-10-draft-1";

/** The statement-message door's answer on a sandbox, issued at `issuedAt` by the server's clock. */
function statementServed(bend?: (p: Parts) => void, issuedAt = SERVER_NOW): StatementMessageAnswer {
  const domain: Loose = {
    name: "Novi Corpus Statement of Authority",
    version: "1",
    chainId: CHAIN,
    verifyingContract: FACTORY,
  };
  const types: Loose = { EIP712Domain: domainFields(), StatementOfAuthority: statementFields() };
  const message: Loose = {
    statement: sentence(COMPANY, NUMBER, GUARDIAN),
    declarantName: "Novi Sandbox Declarant",
    declarantTitle: "Manager",
    companyName: COMPANY,
    jurisdiction: "WY",
    filingNumber: NUMBER,
    guardian: GUARDIAN,
    wordingVersion: WORDING,
    issuedAt: String(issuedAt),
  };
  const typedData: Loose = { domain, types, primaryType: "StatementOfAuthority", message };
  const served: Loose = { typedData, wordingVersion: WORDING, textStatus: "draft" };
  bend?.({ served, typedData, domain, types, message });
  return served as unknown as StatementMessageAnswer;
}

type StatementCtx = Parameters<typeof assertStatementTypedData>[1];
const statementCtx = (over: Partial<StatementCtx> = {}): StatementCtx => ({
  config: { chainId: CHAIN, factory: FACTORY },
  sessionAddress: GUARDIAN,
  typed: { companyName: COMPANY, filingNumber: NUMBER, synthetic: true },
  nowSeconds: SERVER_NOW,
  ...over,
});

const refused = (problem: string) => ({ ok: false, problem });

// ---------------------------------------------------------------------------------------------
// The pinned values
// ---------------------------------------------------------------------------------------------

describe("the pinned values", () => {
  test("the two domain names", () => {
    expect(LINK_DOMAIN_NAME).toBe("Novi LegalBodyFactory");
    expect(STATEMENT_DOMAIN_NAME).toBe("Novi Corpus Statement of Authority");
  });
  test("the field lists the checks compare against are the served ones, in order", () => {
    expect(STATEMENT_FIELDS).toEqual(statementFields());
    expect(LINK_FIELDS).toEqual(linkFields());
    expect(EIP712_DOMAIN_FIELDS).toEqual(domainFields());
  });
  test("the windows", () => {
    expect(MIN_LINK_REMAINING_SECONDS).toBe(300);
    expect(CLOCK_SKEW_SECONDS).toBe(120);
    expect(STATEMENT_MAX_AGE_SECONDS).toBe(600);
    expect(STATEMENT_MAX_AHEAD_SECONDS).toBe(60);
  });
});

// ---------------------------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------------------------

describe("assertLinkTypedData", () => {
  test("the served link passes", () => {
    expect(assertLinkTypedData(linkServed(), linkCtx())).toEqual({ ok: true });
  });

  test("addresses compare in any case, and the agreement hash in any hex case", () => {
    const served = linkServed(({ domain, message }) => {
      domain.verifyingContract = lower(FACTORY);
      message.guardian = lower(GUARDIAN);
      message.operatingAgreementHash = `0x${"9C".repeat(32)}`;
    });
    expect(assertLinkTypedData(served, linkCtx())).toEqual({ ok: true });
  });

  test("an order with no frozen agreement yet is checked against the agreement read", () => {
    expect(assertLinkTypedData(linkServed(), linkCtx({ order: draftOrder({ agreement: null }) }))).toEqual({
      ok: true,
    });
  });

  const cases: [string, LinkMessageResult, string][] = [
    ["another primary type", linkServed(({ typedData }) => (typedData.primaryType = "Permit")), "primary_type"],
    ["no typed data at all", linkServed(({ served }) => (served.typedData = null)), "primary_type"],
    ["an extra key beside the four", linkServed(({ typedData }) => (typedData.extra = 1)), "typed_data_keys"],
    ["an extra type", linkServed(({ types }) => (types.Permit = [])), "types_keys"],
    ["no EIP712Domain type", linkServed(({ types }) => delete types.EIP712Domain), "types_keys"],
    ["the link fields reordered", linkServed(({ types }) => (types.LegalBodyLink = linkFields().reverse())), "link_fields"],
    [
      "a sixth link field",
      linkServed(({ types }) => (types.LegalBodyLink = [...linkFields(), { name: "nonce", type: "uint256" }])),
      "link_fields",
    ],
    [
      "a link field with an extra property",
      linkServed(({ types }) => (types.LegalBodyLink = linkFields().map((f, i) => (i === 0 ? { ...f, indexed: true } : f)))),
      "link_fields",
    ],
    [
      "a link field of another type",
      linkServed(({ types }) => (types.LegalBodyLink = linkFields().map((f) => (f.name === "deadline" ? { ...f, type: "uint64" } : f)))),
      "link_fields",
    ],
    [
      "a domain type without verifyingContract",
      linkServed(({ types }) => (types.EIP712Domain = domainFields().slice(0, 3))),
      "domain_fields",
    ],
    [
      "a domain type with a salt",
      linkServed(({ types }) => (types.EIP712Domain = [...domainFields(), { name: "salt", type: "bytes32" }])),
      "domain_fields",
    ],
    ["a salt in the domain", linkServed(({ domain }) => (domain.salt = MANIFEST)), "domain_keys"],
    ["a domain without its version", linkServed(({ domain }) => delete domain.version), "domain_keys"],
    ["another domain name", linkServed(({ domain }) => (domain.name = "Permit2")), "domain_name"],
    ["another domain version", linkServed(({ domain }) => (domain.version = "2")), "domain_name"],
    ["another chain", linkServed(({ domain }) => (domain.chainId = 5042)), "domain_chain"],
    ["the chain id as text", linkServed(({ domain }) => (domain.chainId = String(CHAIN))), "domain_chain"],
    ["another verifying contract", linkServed(({ domain }) => (domain.verifyingContract = ANOTHER_FACTORY)), "domain_factory"],
    ["an extra message field", linkServed(({ message }) => (message.spender = OTHER_WALLET)), "message_keys"],
    ["a message without its deadline", linkServed(({ message }) => delete message.deadline), "message_keys"],
    ["another agentId than the one picked", linkServed(({ message }) => (message.agentId = "1")), "agent_id"],
    ["a non-canonical agentId", linkServed(({ message }) => (message.agentId = "0897126")), "agent_id"],
    ["an agentId as a number", linkServed(({ message }) => (message.agentId = 897126)), "agent_id"],
    ["another guardian", linkServed(({ message }) => (message.guardian = OTHER_WALLET)), "guardian"],
    [
      "another agreement hash",
      linkServed(({ message }) => (message.operatingAgreementHash = `0x${"00".repeat(32)}`)),
      "agreement_hash",
    ],
    ["an agreement hash that is not text", linkServed(({ message }) => (message.operatingAgreementHash = 7)), "agreement_hash"],
    ["another amendment delay", linkServed(({ message }) => (message.amendmentDelay = "1")), "amendment_delay"],
    ["a non-canonical amendment delay", linkServed(({ message }) => (message.amendmentDelay = "0172800")), "amendment_delay"],
    [
      "a deadline that is not the served one",
      linkServed(({ message }) => (message.deadline = String(CHAIN_NOW + 3_601))),
      "deadline",
    ],
    [
      "a non-canonical deadline",
      linkServed(({ message }) => (message.deadline = `0${CHAIN_NOW + 3_600}`)),
      "deadline",
    ],
    [
      "a served deadline written as text, even the same text",
      linkServed(({ served }) => (served.deadline = String(CHAIN_NOW + 3_600))),
      "deadline",
    ],
  ];
  test.each(cases)("refuses %s", (_name, served, problem) => {
    expect(assertLinkTypedData(served, linkCtx())).toEqual(refused(problem));
  });

  test("refuses when the order's frozen hash differs from the agreement read", () => {
    const order = draftOrder({ agreement: { hash: `0x${"11".repeat(32)}`, version: 1 } });
    expect(assertLinkTypedData(linkServed(), linkCtx({ order }))).toEqual(refused("agreement_hash"));
  });

  test("refuses an agreement hash that is not 32 bytes, even when everything else agrees with it", () => {
    const short = `0x${"9c".repeat(31)}` as const;
    const served = linkServed(({ message }) => (message.operatingAgreementHash = short));
    const ctx = linkCtx({ agreement: { manifestHash: short }, order: draftOrder({ agreement: null }) });
    expect(assertLinkTypedData(served, ctx)).toEqual(refused("agreement_hash"));
  });

  test("refuses, without throwing, when the agreement read carries no hash", () => {
    const ctx = linkCtx({ agreement: { manifestHash: undefined as unknown as `0x${string}` } });
    expect(assertLinkTypedData(linkServed(), ctx)).toEqual(refused("agreement_hash"));
  });

  test("refuses another session than the guardian the link names", () => {
    expect(assertLinkTypedData(linkServed(), linkCtx({ sessionAddress: OTHER_WALLET }))).toEqual(refused("guardian"));
  });

  test("refuses a link served for another identity than the one picked", () => {
    expect(assertLinkTypedData(linkServed(), linkCtx({ agentId: "897127" }))).toEqual(refused("agent_id"));
  });

  test("refuses an order on another deployment", () => {
    expect(assertLinkTypedData(linkServed(), linkCtx({ order: draftOrder({ chainId: 5042 }) }))).toEqual(
      refused("domain_chain"),
    );
    expect(assertLinkTypedData(linkServed(), linkCtx({ order: draftOrder({ factory: ANOTHER_FACTORY }) }))).toEqual(
      refused("domain_factory"),
    );
  });

  test("names the first rule broken, in the order of the checks", () => {
    const twice = (bend: (p: Parts) => void, deadline?: number) => assertLinkTypedData(linkServed(bend, deadline), linkCtx());
    expect(
      twice(({ typedData }) => {
        typedData.primaryType = "Permit";
        typedData.extra = 1;
      }),
    ).toEqual(refused("primary_type"));
    expect(
      twice(({ domain, message }) => {
        domain.chainId = 1;
        message.guardian = OTHER_WALLET;
      }),
    ).toEqual(refused("domain_chain"));
    expect(
      twice(({ message }) => {
        message.agentId = "1";
        message.guardian = OTHER_WALLET;
      }),
    ).toEqual(refused("agent_id"));
    expect(twice(({ message }) => (message.guardian = OTHER_WALLET), CHAIN_NOW + 10)).toEqual(refused("guardian"));
  });
});

describe("the link's deadline against this browser's clock", () => {
  const at = (nowSeconds: number, deadline = CHAIN_NOW + 3_600) =>
    assertLinkTypedData(linkServed(undefined, deadline), linkCtx({ nowSeconds }));

  test("a one-hour deadline with the local clock three minutes ahead of the chain's", () => {
    expect(at(CHAIN_NOW + 180)).toEqual({ ok: true });
  });
  test("a one-hour deadline with the local clock three minutes behind the chain's", () => {
    expect(at(CHAIN_NOW - 180)).toEqual({ ok: true });
  });
  test("301 s and 300 s before expiry pass; 299 s does not", () => {
    const deadline = CHAIN_NOW + 3_600;
    expect(at(deadline - 301)).toEqual({ ok: true });
    expect(at(deadline - 300)).toEqual({ ok: true });
    expect(at(deadline - 299)).toEqual(refused("deadline_window"));
  });
  test("an expired deadline is refused", () => {
    expect(at(CHAIN_NOW + 3_601)).toEqual(refused("deadline_window"));
  });
  test("the served ceiling plus the skew passes; one second more does not", () => {
    expect(at(CHAIN_NOW, CHAIN_NOW + TTL_MAX + 120)).toEqual({ ok: true });
    expect(at(CHAIN_NOW, CHAIN_NOW + TTL_MAX + 121)).toEqual(refused("deadline_window"));
  });
  test("the paste branch's six hours pass", () => {
    expect(at(CHAIN_NOW, CHAIN_NOW + 21_600)).toEqual({ ok: true });
  });
  test("a clock that cannot be read refuses", () => {
    expect(at(Number.NaN)).toEqual(refused("deadline_window"));
  });
});

// ---------------------------------------------------------------------------------------------
// The statement of authority
// ---------------------------------------------------------------------------------------------

describe("assertStatementTypedData", () => {
  test("the served statement passes", () => {
    expect(assertStatementTypedData(statementServed(), statementCtx())).toEqual({ ok: true });
  });

  test("addresses compare in any case", () => {
    const served = statementServed(({ domain }) => (domain.verifyingContract = lower(FACTORY)));
    const ctx = statementCtx({ sessionAddress: lower(GUARDIAN) as `0x${string}` });
    expect(assertStatementTypedData(served, ctx)).toEqual({ ok: true });
  });

  const cases: [string, StatementMessageAnswer, string][] = [
    // The structure, as for the link.
    ["another primary type", statementServed(({ typedData }) => (typedData.primaryType = "Permit")), "primary_type"],
    ["an extra key beside the four", statementServed(({ typedData }) => (typedData.extra = 1)), "typed_data_keys"],
    ["an extra type", statementServed(({ types }) => (types.Permit = [])), "types_keys"],
    [
      "the statement fields reordered",
      statementServed(({ types }) => (types.StatementOfAuthority = statementFields().reverse())),
      "statement_fields",
    ],
    [
      "a tenth statement field",
      statementServed(({ types }) => (types.StatementOfAuthority = [...statementFields(), { name: "fee", type: "uint256" }])),
      "statement_fields",
    ],
    [
      "a statement field with an extra property",
      statementServed(({ types }) => (types.StatementOfAuthority = statementFields().map((f, i) => (i === 8 ? { ...f, indexed: true } : f)))),
      "statement_fields",
    ],
    [
      "a domain type without verifyingContract",
      statementServed(({ types }) => (types.EIP712Domain = domainFields().slice(0, 3))),
      "domain_fields",
    ],
    ["a salt in the domain", statementServed(({ domain }) => (domain.salt = MANIFEST)), "domain_keys"],
    ["the link's domain name", statementServed(({ domain }) => (domain.name = "Novi LegalBodyFactory")), "domain_name"],
    ["another domain version", statementServed(({ domain }) => (domain.version = "2")), "domain_name"],
    ["an extra message field", statementServed(({ message }) => (message.spender = OTHER_WALLET)), "message_keys"],
    // The statement's own rules.
    ["another chain", statementServed(({ domain }) => (domain.chainId = 5042)), "domain_chain"],
    ["another verifying contract", statementServed(({ domain }) => (domain.verifyingContract = ANOTHER_FACTORY)), "domain_factory"],
    [
      "another guardian",
      statementServed(({ message }) => {
        message.guardian = OTHER_WALLET;
        message.statement = sentence(COMPANY, NUMBER, OTHER_WALLET);
      }),
      "guardian",
    ],
    [
      "another company than the one typed",
      statementServed(({ message }) => {
        message.companyName = "Example Test Holding LLC";
        message.statement = sentence("Example Test Holding LLC", NUMBER, GUARDIAN);
      }),
      "company_name",
    ],
    [
      "another filing number than the one typed",
      statementServed(({ message }) => {
        message.filingNumber = "TEST-0002";
        message.statement = sentence(COMPANY, "TEST-0002", GUARDIAN);
      }),
      "filing_number",
    ],
    ["another jurisdiction", statementServed(({ message }) => (message.jurisdiction = "DE")), "jurisdiction"],
    [
      "a wording version other than the one answered",
      statementServed(({ message }) => (message.wordingVersion = "2026-10-draft-2")),
      "wording_version",
    ],
    [
      "a sentence that does not quote the company",
      statementServed(({ message }) => (message.statement = sentence(COMPANY, NUMBER, GUARDIAN).replace(`"${COMPANY}"`, COMPANY))),
      "sentence",
    ],
    [
      "a sentence about another filing number",
      statementServed(({ message }) => (message.statement = sentence(COMPANY, "TEST-0002", GUARDIAN))),
      "sentence",
    ],
    [
      "a sentence naming another wallet",
      statementServed(({ message }) => (message.statement = sentence(COMPANY, NUMBER, OTHER_WALLET))),
      "sentence",
    ],
    ["a sentence that is not text", statementServed(({ message }) => (message.statement = 1)), "sentence"],
    [
      "a non-canonical issuedAt",
      statementServed(({ message }) => (message.issuedAt = `0${SERVER_NOW}`)),
      "issued_at_window",
    ],
    ["a stale issuedAt", statementServed(undefined, SERVER_NOW - 700), "issued_at_window"],
    ["an issuedAt far ahead", statementServed(undefined, SERVER_NOW + 700), "issued_at_window"],
  ];
  test.each(cases)("refuses %s", (_name, served, problem) => {
    expect(assertStatementTypedData(served, statementCtx())).toEqual(refused(problem));
  });

  test("refuses another session than the guardian the statement names", () => {
    expect(assertStatementTypedData(statementServed(), statementCtx({ sessionAddress: OTHER_WALLET }))).toEqual(
      refused("guardian"),
    );
  });

  test("refuses a deployment other than the configured one", () => {
    expect(
      assertStatementTypedData(statementServed(), statementCtx({ config: { chainId: CHAIN, factory: ANOTHER_FACTORY } })),
    ).toEqual(refused("domain_factory"));
  });

  test("names the first rule broken, in the order of the checks", () => {
    const twice = (bend: (p: Parts) => void, issuedAt?: number) =>
      assertStatementTypedData(statementServed(bend, issuedAt), statementCtx());
    expect(
      twice(({ domain, message }) => {
        domain.chainId = 1;
        message.jurisdiction = "DE";
      }),
    ).toEqual(refused("domain_chain"));
    expect(
      twice(({ message }) => {
        message.companyName = "Other Test LLC";
        message.filingNumber = "TEST-0002";
      }),
    ).toEqual(refused("company_name"));
    expect(twice(({ message }) => (message.statement = "I approve."), SERVER_NOW - 700)).toEqual(refused("sentence"));
  });
});

describe("the statement's issuedAt against this browser's clock", () => {
  const at = (nowSeconds: number) => assertStatementTypedData(statementServed(), statementCtx({ nowSeconds }));

  test("the local clock three minutes ahead of the server's", () => {
    expect(at(SERVER_NOW + 180)).toEqual({ ok: true });
  });
  test("the local clock three minutes behind the server's, the edge, passes; one second more does not", () => {
    expect(at(SERVER_NOW - 180)).toEqual({ ok: true });
    expect(at(SERVER_NOW - 181)).toEqual(refused("issued_at_window"));
  });
  test("issued 600 s ago, the edge, passes; 601 s does not", () => {
    expect(at(SERVER_NOW + 600)).toEqual({ ok: true });
    expect(at(SERVER_NOW + 601)).toEqual(refused("issued_at_window"));
  });
  test("a clock that cannot be read refuses", () => {
    expect(at(Number.NaN)).toEqual(refused("issued_at_window"));
  });
});

describe("the declared text, typed against served", () => {
  const typed = (companyName: string, filingNumber = NUMBER) =>
    assertStatementTypedData(statementServed(), statementCtx({ typed: { companyName, filingNumber, synthetic: true } }));

  test("a name typed with doubled spaces equals the served, collapsed name", () => {
    expect(typed("Example  Test  Holdings  LLC")).toEqual({ ok: true });
  });
  test("spaces at the ends of the name and the number are the backend's to strip", () => {
    expect(typed("  Example Test Holdings LLC ", " TEST-0001  ")).toEqual({ ok: true });
  });
  test("a different name still refuses", () => {
    expect(typed("Example Test Holding LLC")).toEqual(refused("company_name"));
  });
  test("a different number still refuses", () => {
    expect(typed(COMPANY, "TEST-0002")).toEqual(refused("filing_number"));
  });

  test("normaliseDeclaredText: NFC, the plain spaces at the ends stripped, runs of them collapsed", () => {
    expect(normaliseDeclaredText("  Example   Test Holdings  LLC  ")).toBe("Example Test Holdings LLC");
    expect(normaliseDeclaredText("Café")).toBe("Café");
    expect(normaliseDeclaredText("TEST-0001")).toBe("TEST-0001");
  });
});

// ---------------------------------------------------------------------------------------------
// The converted forms
// ---------------------------------------------------------------------------------------------

/** Bigints written as their decimal text, for a deep comparison with the served JSON. */
const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_key, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));

/** viem hashes the served form as it is, with its declared `EIP712Domain` and its uint256 text. */
const servedDigest = (td: LinkTypedDataWire | StatementTypedDataWire) =>
  hashTypedData(td as unknown as Parameters<typeof hashTypedData>[0]);

describe("the converted link", () => {
  const td = linkServed().typedData;

  test("hashes to the served form's digest", () => {
    expect(hashTypedData(toWagmiLinkTypedData(td))).toBe(servedDigest(td));
  });

  test("hashes to the digest of the verifying form, written out by hand", () => {
    const reference = hashTypedData({
      domain: { name: "Novi LegalBodyFactory", version: "1", chainId: CHAIN, verifyingContract: FACTORY },
      types: {
        LegalBodyLink: [
          { name: "agentId", type: "uint256" },
          { name: "guardian", type: "address" },
          { name: "amendmentDelay", type: "uint256" },
          { name: "operatingAgreementHash", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "LegalBodyLink",
      message: {
        agentId: BigInt("897126"),
        guardian: GUARDIAN,
        amendmentDelay: BigInt("172800"),
        operatingAgreementHash: MANIFEST,
        deadline: BigInt(String(CHAIN_NOW + 3_600)),
      },
    });
    expect(hashTypedData(toWagmiLinkTypedData(td))).toBe(reference);
    expect(servedDigest(td)).toBe(reference);
  });

  test("a digest that moves with the message: one more second of deadline is another digest", () => {
    const later = linkServed(undefined, CHAIN_NOW + 3_601).typedData;
    expect(hashTypedData(toWagmiLinkTypedData(later))).not.toBe(servedDigest(td));
  });

  test("copies every field: the served form without EIP712Domain, its uint256 values as bigints", () => {
    const w = toWagmiLinkTypedData(td);
    expect(plain(w)).toEqual({
      domain: td.domain,
      types: { LegalBodyLink: td.types.LegalBodyLink },
      primaryType: "LegalBodyLink",
      message: td.message,
    });
    expect([typeof w.message.agentId, typeof w.message.amendmentDelay, typeof w.message.deadline]).toEqual([
      "bigint",
      "bigint",
      "bigint",
    ]);
  });
});

describe("the converted statement", () => {
  const td = statementServed().typedData;

  test("hashes to the served form's digest", () => {
    expect(hashTypedData(toWagmiStatementTypedData(td))).toBe(servedDigest(td));
  });

  test("a digest that moves with the message: one second later is another digest", () => {
    const later = statementServed(undefined, SERVER_NOW + 1).typedData;
    expect(hashTypedData(toWagmiStatementTypedData(later))).not.toBe(servedDigest(td));
  });

  test("copies every field: the served form without EIP712Domain, issuedAt as a bigint", () => {
    const w = toWagmiStatementTypedData(td);
    expect(plain(w)).toEqual({
      domain: td.domain,
      types: { StatementOfAuthority: td.types.StatementOfAuthority },
      primaryType: "StatementOfAuthority",
      message: td.message,
    });
    expect(typeof w.message.issuedAt).toBe("bigint");
  });
});

// ---------------------------------------------------------------------------------------------
// Type level: run by `tsc --noEmit`, never called
// ---------------------------------------------------------------------------------------------

declare const sign: UseSignTypedDataReturnType["signTypedDataAsync"];

/** wagmi's `signTypedDataAsync` takes both converted forms as they are returned. */
export async function convertedFormsAreSignable(link: LinkTypedDataWire, statement: StatementTypedDataWire) {
  await sign(toWagmiLinkTypedData(link));
  await sign(toWagmiStatementTypedData(statement));
}

test("type level only: wagmi takes both converted forms, which tsc checks", () => {
  expect(typeof convertedFormsAreSignable).toBe("function");
});
