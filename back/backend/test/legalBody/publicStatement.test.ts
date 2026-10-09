/**
 * The public legal-body statement: its assembly from one block's chain facts and the recorded
 * facts, its JSON form, its claims hash, its EIP-712 signature and its verification.
 *
 * THE KEYS BELOW ARE TEST VECTORS, not secrets: anvil's published accounts 0 and 1, printed in
 * Foundry's own documentation and funded on nothing. Every address is a placeholder and every
 * company an invention.
 */
import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  getAddress,
  hashStruct,
  keccak256,
  recoverAddress,
  recoverTypedDataAddress,
  stringToBytes,
  toHex,
  verifyTypedData,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import type { AgentSnapshot, BodySnapshot, CodeKind } from "../../src/adapters/arc/legalBodyChain";
import { ATTESTATION_STATES, type Attestation } from "../../src/legalBody/attestation";
import { FILING_STATUSES, type FilingFacts, filingFacts } from "../../src/legalBody/filings";
import {
  LEGAL_BODY_STATEMENT_TYPES,
  LEGAL_BODY_STATEMENT_TYPE_STRING,
  type LegalBodyStatement,
  type LegalBodyStatementJson,
  PUBLIC_STATEMENT_CLOCK_SKEW_SECONDS,
  PUBLIC_STATEMENT_DOMAIN_NAME,
  PUBLIC_STATEMENT_DOMAIN_VERSION,
  PUBLIC_STATEMENT_ENTITY_TYPE,
  PUBLIC_STATEMENT_JURISDICTION,
  PUBLIC_STATEMENT_PRIMARY_TYPE,
  PUBLIC_STATEMENT_TTL_SECONDS,
  type SignedStatementJson,
  type StatementInputs,
  StatementIntegrityError,
  assembleStatement,
  claimsHash,
  publicStatementDomain,
  signStatement,
  statementFromJson,
  statementJson,
  statementMessage,
  verifyPublicStatement,
} from "../../src/legalBody/publicStatement";
import {
  PUBLIC_BINDING_STATES,
  STANDINGS,
  type Standing,
  type StandingReason,
} from "../../src/legalBody/standing";
import { canonicalizeJcs } from "../../src/oa/manifest";

/** anvil's published account 0: the golden vector's signer. */
const ANVIL_0 = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
/** anvil's published account 1: another key. */
const ANVIL_1 = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const CHAIN_ID = 5042002;
/** Another chain: anvil's own. */
const OTHER_CHAIN_ID = 31337;
// Placeholders, in their EIP-55 form.
const REGISTRY: Address = "0x0000000000000000000000000000000000008004";
const FACTORY: Address = "0x00000000000000000000000000000000000fAc70";
const BODY: Address = "0x00000000000000000000000000000000000B0d1E";
const WALLET: Address = "0x00000000000000000000000000000000000A11e7";
const OWNER: Address = "0x00000000000000000000000000000000000a0001";
const OTHER_BODY = getAddress("0x00000000000000000000000000000000000b0d1f");
const OTHER_OWNER = getAddress("0x00000000000000000000000000000000000a0002");

/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const FROZEN = H("ab");
const upper = (hex: string) => `0x${hex.slice(2).toUpperCase()}` as Hex;
const lower = (a: Address) => a.toLowerCase() as Address;
const ISSUED_AT = 1_800_000_000;

/** The statement's type, verbatim: what a verifier hashes. */
const TYPE_STRING =
  "LegalBodyStatement(uint256 chainId,address identityRegistry,address factory,address legalBody,uint256 agentId,address agentWallet,address identityOwnerAtCreation,string bindingState,bool identityOwnerIsContract,bool agentWalletIsContract,string standing,string attestationState,string jurisdiction,string entityType,string legalName,string filingNumber,string source,string environment,bool controlVerified,uint256 existenceCheckedAt,string filedAt,bool einIssued,string filingStatus,uint256 lastFiledPeriod,string lastFiledAt,string lastFiledConfirmedBy,string nextDue,bytes32 oaManifestHash,uint256 oaManifestVersion,bool guardianHumanVerified,uint256 observedAtBlock,uint256 issuedAt,uint256 expiresAt)";

/** The 33 fields, in their fixed order. */
const FIELDS: [string, string][] = [
  ["chainId", "uint256"],
  ["identityRegistry", "address"],
  ["factory", "address"],
  ["legalBody", "address"],
  ["agentId", "uint256"],
  ["agentWallet", "address"],
  ["identityOwnerAtCreation", "address"],
  ["bindingState", "string"],
  ["identityOwnerIsContract", "bool"],
  ["agentWalletIsContract", "bool"],
  ["standing", "string"],
  ["attestationState", "string"],
  ["jurisdiction", "string"],
  ["entityType", "string"],
  ["legalName", "string"],
  ["filingNumber", "string"],
  ["source", "string"],
  ["environment", "string"],
  ["controlVerified", "bool"],
  ["existenceCheckedAt", "uint256"],
  ["filedAt", "string"],
  ["einIssued", "bool"],
  ["filingStatus", "string"],
  ["lastFiledPeriod", "uint256"],
  ["lastFiledAt", "string"],
  ["lastFiledConfirmedBy", "string"],
  ["nextDue", "string"],
  ["oaManifestHash", "bytes32"],
  ["oaManifestVersion", "uint256"],
  ["guardianHumanVerified", "bool"],
  ["observedAtBlock", "uint256"],
  ["issuedAt", "uint256"],
  ["expiresAt", "uint256"],
];

/** The fields that say when the statement was read and issued, not what it claims. */
const TIME_FIELDS: readonly string[] = ["observedAtBlock", "issuedAt", "expiresAt"];

/** The enumerations, each with every value it allows. */
const ENUMERATIONS: Record<string, readonly string[]> = {
  bindingState: ["linked", "broken"],
  standing: ["pending", "active", "unknown", "inactive"],
  attestationState: ["pending", "active", "revoked"],
  jurisdiction: ["WY"],
  entityType: ["LLC"],
  source: ["customer", "novi"],
  environment: ["sandbox", "production"],
  filingStatus: ["not_yet_due", "filed", "past_due_unverified", "unverified"],
  lastFiledConfirmedBy: ["", "operator"],
};
const DATE_FIELDS: readonly string[] = ["filedAt", "lastFiledAt", "nextDue"];

// ── the inputs ────────────────────────────────────────────────────────────────────────────────

const BODY_SNAPSHOT: BodySnapshot = {
  body: BODY,
  creator: OWNER,
  status: "active",
  metaAgentId: 42n,
  oaHash: FROZEN,
};
const AGENT: AgentSnapshot = {
  agentId: 42n,
  linked: BODY,
  agentWallet: WALLET,
  bodies: [BODY_SNAPSHOT],
};
/** A customer company whose latest check passed, and which is paid. */
const ACTIVE: Attestation = {
  state: "active",
  established: true,
  controlVerified: true,
  existenceCheckedAt: 1_790_000_000,
};
const NAMES = { legalName: "Example Holdings LLC", filingNumber: "TEST-0001" };
/** Formed on 2026-01-15: its first report falls due on 2027-01-01. */
const NOT_YET_DUE: FilingFacts = filingFacts({
  formationDate: "2026-01-15",
  lastReport: null,
  today: "2026-10-07",
});

type Over = Partial<Omit<StatementInputs, "row">> & { row?: Partial<StatementInputs["row"]> };

function inputs(over: Over = {}): StatementInputs {
  const { row, ...rest } = over;
  return {
    chainId: CHAIN_ID,
    identityRegistry: REGISTRY,
    factory: FACTORY,
    row: {
      bodyAddress: BODY,
      agentId: "42",
      identityOwner: OWNER,
      oaManifestHash: FROZEN,
      oaManifestVersion: 1,
      ...row,
    },
    agent: AGENT,
    body: BODY_SNAPSHOT,
    observedAtBlock: 77n,
    ownerCode: "none",
    walletCode: "none",
    provider: "customer",
    attestation: ACTIVE,
    names: NAMES,
    filing: NOT_YET_DUE,
    guardianHumanVerified: true,
    environment: "sandbox",
    issuedAt: ISSUED_AT,
    ...rest,
  };
}

const statementOf = (over: Over = {}) => assembleStatement(inputs(over)).statement;

/** The problem `assembleStatement` refuses the inputs with, or "none". */
function problemOf(over: Over): string {
  try {
    assembleStatement(inputs(over));
    return "none";
  } catch (e) {
    if (e instanceof StatementIntegrityError) return e.problem;
    throw e;
  }
}

// ── the golden vector ─────────────────────────────────────────────────────────────────────────

/** The fixed statement of the golden vector, every field written out. */
const GOLDEN: LegalBodyStatement = {
  chainId: 5042002n,
  identityRegistry: REGISTRY,
  factory: FACTORY,
  legalBody: BODY,
  agentId: 42n,
  agentWallet: WALLET,
  identityOwnerAtCreation: OWNER,
  bindingState: "linked",
  identityOwnerIsContract: false,
  agentWalletIsContract: false,
  standing: "active",
  attestationState: "active",
  jurisdiction: "WY",
  entityType: "LLC",
  legalName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  source: "customer",
  environment: "sandbox",
  controlVerified: true,
  existenceCheckedAt: 1_790_000_000n,
  filedAt: "2026-01-15",
  einIssued: false,
  filingStatus: "not_yet_due",
  lastFiledPeriod: 0n,
  lastFiledAt: "",
  lastFiledConfirmedBy: "",
  nextDue: "2027-01-01",
  oaManifestHash: FROZEN,
  oaManifestVersion: 1n,
  guardianHumanVerified: true,
  observedAtBlock: 77n,
  issuedAt: 1_800_000_000n,
  expiresAt: 1_800_000_300n,
};

/** Its JSON form, as served: what a third party verifies from. */
const GOLDEN_JSON: LegalBodyStatementJson = {
  chainId: "5042002",
  identityRegistry: "0x0000000000000000000000000000000000008004",
  factory: "0x00000000000000000000000000000000000fAc70",
  legalBody: "0x00000000000000000000000000000000000B0d1E",
  agentId: "42",
  agentWallet: "0x00000000000000000000000000000000000A11e7",
  identityOwnerAtCreation: "0x00000000000000000000000000000000000a0001",
  bindingState: "linked",
  identityOwnerIsContract: false,
  agentWalletIsContract: false,
  standing: "active",
  attestationState: "active",
  jurisdiction: "WY",
  entityType: "LLC",
  legalName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  source: "customer",
  environment: "sandbox",
  controlVerified: true,
  existenceCheckedAt: "1790000000",
  filedAt: "2026-01-15",
  einIssued: false,
  filingStatus: "not_yet_due",
  lastFiledPeriod: "0",
  lastFiledAt: "",
  lastFiledConfirmedBy: "",
  nextDue: "2027-01-01",
  oaManifestHash: "0xabababababababababababababababababababababababababababababababab",
  oaManifestVersion: "1",
  guardianHumanVerified: true,
  observedAtBlock: "77",
  issuedAt: "1800000000",
  expiresAt: "1800000300",
};

const GOLDEN_SIGNER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Also produced by Foundry's `cast wallet sign --data` over GOLDEN_JSON, with an `EIP712Domain` of
// `name`, `version` and `chainId`: a third party reproduces it from the served JSON alone.
const GOLDEN_SIGNATURE: Hex =
  "0x20f6985b0757d580cb053af7f1abfb27534468496b1a83a7d94e5a29280957485b4c3e5bf2c37f68e3ad8b7fb33a9f5436e69c221273a6aa7b4fccdad1e1f3e21b";
const GOLDEN_CLAIMS_HASH: Hex =
  "0xf30e7ca289ed3675d20059b9c93bb62ad042009bddb8b240b401ef9d499e64d7";

// ── helpers of the encoding ───────────────────────────────────────────────────────────────────

/** The served form: through JSON text and back. */
const wireOf = (signed: SignedStatementJson): SignedStatementJson =>
  JSON.parse(JSON.stringify(signed)) as SignedStatementJson;

const verify = (
  signed: unknown,
  over: Partial<{ attestor: Address; expectedChainId: number; nowSeconds: number }> = {},
) =>
  verifyPublicStatement(signed, {
    attestor: ANVIL_0.address,
    expectedChainId: CHAIN_ID,
    nowSeconds: ISSUED_AT + 10,
    ...over,
  });

/** The signature checked by viem alone, over a JSON message as it is: no strict reading. */
const signatureCovers = (wire: SignedStatementJson, message: Record<string, unknown>) =>
  verifyTypedData({
    address: ANVIL_0.address,
    domain: wire.domain,
    types: LEGAL_BODY_STATEMENT_TYPES,
    primaryType: "LegalBodyStatement",
    message,
    signature: wire.signature,
  });

/** The order of secp256k1's group (SEC 2). A signature's `s` and n - s, each with its own `v`,
 *  recover the same signer from the same digest. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** A 65-byte signature's `s` (bytes 32 to 63, big-endian) and `v` (its last byte). */
const sAndV = (signature: Hex): { s: bigint; v: number } => ({
  s: BigInt(`0x${signature.slice(66, 130)}`),
  v: Number.parseInt(signature.slice(130), 16),
});

/** The same signature's `r`, with another `s` and `v`. */
const respelled = (signature: Hex, s: bigint, v: number): Hex =>
  `0x${signature.slice(2, 66)}${s.toString(16).padStart(64, "0")}${v.toString(16).padStart(2, "0")}`;

/** The golden statement at the first block from its own whose signature ends in `v`. */
async function signedEndingIn(v: 27 | 28): Promise<SignedStatementJson> {
  for (let block = GOLDEN.observedAtBlock; block < GOLDEN.observedAtBlock + 16n; block += 1n) {
    const signed = wireOf(await signStatement({ ...GOLDEN, observedAtBlock: block }, ANVIL_0));
    if (sAndV(signed.signature).v === v) return signed;
  }
  throw new Error(`no signature ending in v ${v} within 16 blocks`);
}

/** Another value for a field of the golden JSON form, in its canonical form for the field's type.
 *  The jurisdiction and the entity type allow one value each: theirs is outside the list. */
function another(name: string, type: string, value: unknown): unknown {
  switch (type) {
    case "uint256":
      return (BigInt(value as string) + 1n).toString();
    case "address":
      return value === WALLET ? OWNER : WALLET;
    case "bytes32":
      return H("ee");
    case "bool":
      return !value;
  }
  const strings: Record<string, string> = {
    bindingState: "broken",
    standing: "pending",
    attestationState: "pending",
    jurisdiction: "DE",
    entityType: "INC",
    legalName: "Example Holdings Two LLC",
    filingNumber: "TEST-0002",
    source: "novi",
    environment: "production",
    filedAt: "2026-01-16",
    filingStatus: "filed",
    lastFiledAt: "2026-01-20",
    lastFiledConfirmedBy: "operator",
    nextDue: "2027-01-02",
  };
  const alternative = strings[name];
  if (alternative === undefined) throw new Error(`no other value for ${name}`);
  return alternative;
}

/** The error `statementFromJson` throws for `j`. */
function refusal(j: unknown): unknown {
  try {
    statementFromJson(j);
  } catch (e) {
    return e;
  }
  throw new Error("statementFromJson accepted it");
}

// ── the tests ─────────────────────────────────────────────────────────────────────────────────

describe("the type and the domain", () => {
  test("the constants", () => {
    expect(PUBLIC_STATEMENT_DOMAIN_NAME).toBe("Novi Corpus Attestation");
    expect(PUBLIC_STATEMENT_DOMAIN_VERSION).toBe("2");
    expect(PUBLIC_STATEMENT_PRIMARY_TYPE).toBe("LegalBodyStatement");
    expect(PUBLIC_STATEMENT_TTL_SECONDS).toBe(300);
    expect(PUBLIC_STATEMENT_CLOCK_SKEW_SECONDS).toBe(60);
    expect(PUBLIC_STATEMENT_JURISDICTION).toBe("WY");
    expect(PUBLIC_STATEMENT_ENTITY_TYPE).toBe("LLC");
  });

  test("the domain: the name, version 2 and the chain id, and no verifying contract", () => {
    expect(publicStatementDomain(CHAIN_ID)).toStrictEqual({
      name: "Novi Corpus Attestation",
      version: "2",
      chainId: 5042002,
    });
    expect(Object.keys(publicStatementDomain(OTHER_CHAIN_ID))).toEqual([
      "name",
      "version",
      "chainId",
    ]);
  });

  test("one primary type of 33 fields in their fixed order, which produce the exact type string", () => {
    expect(Object.keys(LEGAL_BODY_STATEMENT_TYPES)).toEqual(["LegalBodyStatement"]);
    const fields = LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement;
    expect(fields.map((f) => [f.name, f.type])).toEqual(FIELDS);
    expect(fields).toHaveLength(33);
    expect(`LegalBodyStatement(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`).toBe(
      LEGAL_BODY_STATEMENT_TYPE_STRING,
    );
    expect(LEGAL_BODY_STATEMENT_TYPE_STRING).toBe(TYPE_STRING);
  });

  test("the flattener and the JSON form list the 33 fields in the type's order", () => {
    const names = FIELDS.map(([name]) => name);
    expect(Object.keys(statementMessage(GOLDEN))).toEqual(names);
    expect(Object.keys(statementJson(GOLDEN))).toEqual(names);
  });

  test("the flattener carries every value as it is", () => {
    expect(statementMessage(GOLDEN)).toStrictEqual({ ...GOLDEN });
  });

  test("viem hashes exactly this type, and the domain names no contract: the digest recomputed by hand recovers the golden signer", async () => {
    const fields = LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement;
    const message = statementMessage(GOLDEN);
    // EIP-712 encodes a string as the keccak256 of its UTF-8 bytes, every other field as itself.
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          ...fields.map((f) => ({ type: f.type === "string" ? "bytes32" : f.type })),
        ],
        [
          keccak256(toHex(TYPE_STRING)),
          ...fields.map((f) =>
            f.type === "string" ? keccak256(toHex(message[f.name] as string)) : message[f.name],
          ),
        ],
      ),
    );
    expect(
      hashStruct({
        data: message,
        primaryType: "LegalBodyStatement",
        types: LEGAL_BODY_STATEMENT_TYPES,
      }),
    ).toBe(structHash);
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [
          keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId)")),
          keccak256(toHex("Novi Corpus Attestation")),
          keccak256(toHex("2")),
          5042002n,
        ],
      ),
    );
    const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
    await expect(recoverAddress({ hash: digest, signature: GOLDEN_SIGNATURE })).resolves.toBe(
      GOLDEN_SIGNER,
    );
  });
});

describe("assembleStatement", () => {
  test("a linked body of a checked, paid company: every field as the rules say", () => {
    expect(assembleStatement(inputs())).toStrictEqual({ statement: GOLDEN, reasons: [] });
  });

  test("the placeholders are in their EIP-55 form", () => {
    for (const a of [REGISTRY, FACTORY, BODY, WALLET, OWNER, GOLDEN_SIGNER])
      expect(getAddress(a)).toBe(a);
  });

  describe("the binding", () => {
    test("linked when the agent's pointer is the row's body, in any letter case", () => {
      expect(statementOf({ agent: { ...AGENT, linked: lower(BODY) } }).bindingState).toBe("linked");
    });

    test.each<[string, Address | undefined]>([
      ["no pointer", undefined],
      ["a pointer to another body", OTHER_BODY],
    ])("broken with %s: inactive", (_name, linked) => {
      const { statement, reasons } = assembleStatement(inputs({ agent: { ...AGENT, linked } }));
      expect([statement.bindingState, statement.standing, reasons]).toEqual([
        "broken",
        "inactive",
        ["binding_broken"],
      ]);
    });
  });

  test.each<[string, Over, [string, string]]>([
    ["linked, with a passed check", {}, ["Example Holdings LLC", "TEST-0001"]],
    [
      "linked, with a passed check of a company not yet paid",
      { attestation: { ...ACTIVE, state: "pending" } },
      ["Example Holdings LLC", "TEST-0001"],
    ],
    ["broken: no pointer", { agent: { ...AGENT, linked: undefined } }, ["", ""]],
    ["broken: a pointer to another body", { agent: { ...AGENT, linked: OTHER_BODY } }, ["", ""]],
    ["revoked", { attestation: { ...ACTIVE, state: "revoked" } }, ["", ""]],
    ["no names to show", { names: null }, ["", ""]],
  ])("the names rule: %s", (_name, over, names) => {
    const statement = statementOf(over);
    expect([statement.legalName, statement.filingNumber]).toEqual(names);
  });

  describe("the flags", () => {
    test.each<[CodeKind, boolean]>([
      ["none", false],
      ["delegated", false],
      ["contract", true],
    ])("an address whose code is %s reads %s", (code, flag) => {
      const owner = statementOf({ ownerCode: code });
      expect([owner.identityOwnerIsContract, owner.agentWalletIsContract]).toEqual([flag, false]);
      const wallet = statementOf({ walletCode: code });
      expect([wallet.identityOwnerIsContract, wallet.agentWalletIsContract]).toEqual([false, flag]);
    });

    test.each<CodeKind>(["none", "delegated", "contract"])(
      "the zero wallet reads false whatever its code reads (%s)",
      (walletCode) => {
        const statement = statementOf({
          agent: { ...AGENT, agentWallet: zeroAddress },
          walletCode,
          ownerCode: "contract",
        });
        expect(statement.agentWallet).toBe(zeroAddress);
        expect(statement.agentWalletIsContract).toBe(false);
        expect(statement.identityOwnerIsContract).toBe(true);
      },
    );
  });

  describe("the integrity refusals", () => {
    test.each<[string, Over, string]>([
      [
        "the chain's body is not the row's",
        { body: { ...BODY_SNAPSHOT, body: OTHER_BODY } },
        "body_mismatch",
      ],
      [
        "the factory recorded no creator for the body",
        { body: { ...BODY_SNAPSHOT, creator: undefined } },
        "not_ours",
      ],
      [
        "the body was created by another identity owner",
        { body: { ...BODY_SNAPSHOT, creator: OTHER_OWNER } },
        "not_ours",
      ],
      [
        "the snapshot's agent is not the row's",
        { agent: { ...AGENT, agentId: 43n } },
        "agent_mismatch",
      ],
      [
        "the body names another agent",
        { body: { ...BODY_SNAPSHOT, metaAgentId: 43n } },
        "agent_mismatch",
      ],
      [
        "the row's agent id is not a canonical decimal",
        { row: { agentId: "042" } },
        "agent_mismatch",
      ],
      ["the row's agent id is empty", { row: { agentId: "" } }, "agent_mismatch"],
      [
        "the company is not a customer's",
        { provider: "example-formation-provider" },
        "unsupported_provider",
      ],
    ])("%s: %s", (_name, over, problem) => {
      expect(problemOf(over)).toBe(problem);
    });

    test("checked in order: the body, then its creator, then the agent, then the provider", () => {
      const allWrong: Over = {
        body: { ...BODY_SNAPSHOT, body: OTHER_BODY, creator: OTHER_OWNER, metaAgentId: 43n },
        agent: { ...AGENT, agentId: 43n },
        provider: "example-formation-provider",
      };
      expect(problemOf(allWrong)).toBe("body_mismatch");
      expect(
        problemOf({
          body: { ...BODY_SNAPSHOT, creator: undefined, metaAgentId: 43n },
          agent: { ...AGENT, agentId: 43n },
          provider: "example-formation-provider",
        }),
      ).toBe("not_ours");
      expect(
        problemOf({
          body: { ...BODY_SNAPSHOT, metaAgentId: 43n },
          provider: "example-formation-provider",
        }),
      ).toBe("agent_mismatch");
    });

    test("addresses are compared in any letter case", () => {
      expect(
        problemOf({
          row: { bodyAddress: lower(BODY), identityOwner: lower(OWNER) },
          body: { ...BODY_SNAPSHOT, creator: upper(OWNER) as Address },
        }),
      ).toBe("none");
    });

    test("a refusal is a StatementIntegrityError whose message names the problem and no address", () => {
      let caught: unknown;
      try {
        assembleStatement(inputs({ body: { ...BODY_SNAPSHOT, creator: OTHER_OWNER } }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StatementIntegrityError);
      const e = caught as StatementIntegrityError;
      expect(e.name).toBe("StatementIntegrityError");
      expect(e.problem).toBe("not_ours");
      expect(e.message).toContain("not_ours");
      expect(e.message).not.toMatch(/0x/i);
    });
  });

  test.each<[string, Over, Standing, StandingReason[]]>([
    [
      "a winding-down body",
      { body: { ...BODY_SNAPSHOT, status: "winding_down" } },
      "inactive",
      ["status_not_active"],
    ],
    [
      "a revoked attestation",
      { attestation: { ...ACTIVE, state: "revoked" } },
      "inactive",
      ["attestation_revoked"],
    ],
    [
      "a company not yet checked",
      {
        attestation: {
          state: "pending",
          established: false,
          controlVerified: false,
          existenceCheckedAt: null,
        },
        names: null,
      },
      "pending",
      ["attestation_pending"],
    ],
    [
      "another agreement hash on chain",
      { body: { ...BODY_SNAPSHOT, oaHash: H("cd") } },
      "unknown",
      ["agreement_mismatch"],
    ],
    [
      "no formation date recorded",
      { filing: filingFacts({ formationDate: null, lastReport: null, today: "2026-10-07" }) },
      "unknown",
      ["filing_unverified"],
    ],
    [
      "a report past due beyond grace",
      {
        filing: filingFacts({ formationDate: "2023-03-10", lastReport: null, today: "2026-10-07" }),
      },
      "unknown",
      ["filing_past_grace"],
    ],
  ])("the standing from the snapshot and the facts: %s", (_name, over, standing, reasons) => {
    const out = assembleStatement(inputs(over));
    expect([out.statement.standing, out.reasons]).toEqual([standing, reasons]);
    expect(out.statement.attestationState).toBe((over.attestation ?? ACTIVE).state);
  });

  test("the agreement stated is the frozen one, not the chain's", () => {
    expect(statementOf({ body: { ...BODY_SNAPSHOT, oaHash: H("cd") } }).oaManifestHash).toBe(
      FROZEN,
    );
  });

  test("the sentinels: the zero wallet, 0 for no check time and no report, an empty string for absent names and dates", () => {
    const statement = statementOf({
      agent: { ...AGENT, agentWallet: zeroAddress },
      attestation: {
        state: "pending",
        established: false,
        controlVerified: false,
        existenceCheckedAt: null,
      },
      names: null,
      filing: filingFacts({ formationDate: null, lastReport: null, today: "2026-10-07" }),
    });
    expect(statement).toMatchObject({
      agentWallet: zeroAddress,
      agentWalletIsContract: false,
      controlVerified: false,
      existenceCheckedAt: 0n,
      legalName: "",
      filingNumber: "",
      filedAt: "",
      filingStatus: "unverified",
      lastFiledPeriod: 0n,
      lastFiledAt: "",
      lastFiledConfirmedBy: "",
      nextDue: "",
      einIssued: false,
    });
    // Every sentinel is a canonical JSON value: the zero address is its own EIP-55 form.
    expect(statementFromJson(JSON.parse(JSON.stringify(statementJson(statement))))).toStrictEqual(
      statement,
    );
  });

  test("the filing fields come from the filing facts", () => {
    const statement = statementOf({
      filing: filingFacts({
        formationDate: "2023-03-10",
        lastReport: { period: 2026, filedOn: "2026-02-20" },
        today: "2026-10-07",
      }),
    });
    expect(statement).toMatchObject({
      filedAt: "2023-03-10",
      filingStatus: "filed",
      lastFiledPeriod: 2026n,
      lastFiledAt: "2026-02-20",
      lastFiledConfirmedBy: "operator",
      nextDue: "2027-03-01",
      standing: "active",
    });
  });

  test("einIssued is false, even over an established company with an active attestation", () => {
    expect(statementOf().einIssued).toBe(false);
    expect(statementOf({ ownerCode: "contract", walletCode: "contract" }).einIssued).toBe(false);
  });

  test("the expiry: 300 seconds after issue", () => {
    const statement = statementOf({ issuedAt: 1_800_000_123 });
    expect([statement.issuedAt, statement.expiresAt]).toEqual([1_800_000_123n, 1_800_000_423n]);
  });

  test("the source is the customer's; the jurisdiction and the entity type are fixed; the environment as given", () => {
    expect(statementOf({ environment: "production" })).toMatchObject({
      source: "customer",
      jurisdiction: "WY",
      entityType: "LLC",
      environment: "production",
    });
  });

  test("the statement is in its canonical form whatever the letter case of its inputs", () => {
    const { statement } = assembleStatement(
      inputs({
        identityRegistry: lower(REGISTRY),
        factory: lower(FACTORY),
        row: {
          bodyAddress: lower(BODY),
          identityOwner: lower(OWNER),
          oaManifestHash: upper(FROZEN),
        },
        agent: { ...AGENT, linked: lower(BODY), agentWallet: lower(WALLET) },
        body: { ...BODY_SNAPSHOT, body: lower(BODY), creator: lower(OWNER) },
      }),
    );
    expect(statement).toStrictEqual(GOLDEN);
  });
});

describe("the JSON form", () => {
  test("the lists kept beside the unions hold exactly the values each enumeration allows", () => {
    expect(STANDINGS).toEqual(ENUMERATIONS.standing);
    expect(PUBLIC_BINDING_STATES).toEqual(ENUMERATIONS.bindingState);
    expect(ATTESTATION_STATES).toEqual(ENUMERATIONS.attestationState);
    expect(FILING_STATUSES).toEqual(ENUMERATIONS.filingStatus);
  });

  test("every uint256 a canonical decimal string, addresses EIP-55, bytes32 lower case", () => {
    expect(statementJson(GOLDEN)).toStrictEqual(GOLDEN_JSON);
    const json = statementJson({
      ...GOLDEN,
      factory: lower(FACTORY),
      legalBody: lower(BODY),
      oaManifestHash: upper(FROZEN),
    });
    expect([json.factory, json.legalBody, json.oaManifestHash]).toEqual([FACTORY, BODY, FROZEN]);
  });

  test("statementFromJson reverses it, through JSON text", () => {
    expect(statementFromJson(JSON.parse(JSON.stringify(statementJson(GOLDEN))))).toStrictEqual(
      GOLDEN,
    );
  });

  test("canonicalizeJcs takes the JSON form as it is", () => {
    const text = canonicalizeJcs(statementJson(GOLDEN));
    expect(JSON.parse(text)).toStrictEqual(GOLDEN_JSON);
  });

  test("statementFromJson accepts every value of each enumeration, an empty date, and both ends of uint256", () => {
    const base: Record<string, unknown> = { ...GOLDEN_JSON };
    for (const [field, values] of Object.entries(ENUMERATIONS))
      for (const value of values)
        expect(
          (statementFromJson({ ...base, [field]: value }) as unknown as Record<string, unknown>)[
            field
          ],
          `${field} ${value}`,
        ).toBe(value);
    for (const field of DATE_FIELDS)
      for (const value of ["", "2028-02-29"])
        expect(
          (statementFromJson({ ...base, [field]: value }) as unknown as Record<string, unknown>)[
            field
          ],
          `${field} ${value}`,
        ).toBe(value);
    const max = (2n ** 256n - 1n).toString();
    expect(statementFromJson({ ...base, observedAtBlock: "0", agentId: max })).toMatchObject({
      observedAtBlock: 0n,
      agentId: 2n ** 256n - 1n,
    });
  });

  const base: Record<string, unknown> = { ...GOLDEN_JSON };
  const without = (key: string) =>
    Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
  test.each<[string, unknown]>([
    ["a field missing", without("nextDue")],
    ["a field added", { ...base, verifiedBy: "" }],
    ["a decimal with a leading zero", { ...base, agentId: "042" }],
    ["a decimal written as a JSON number", { ...base, chainId: 5042002 }],
    ["a decimal written in hex", { ...base, agentId: "0x2a" }],
    ["a negative decimal", { ...base, observedAtBlock: "-1" }],
    ["a decimal with a space", { ...base, issuedAt: " 1800000000" }],
    ["an empty decimal", { ...base, lastFiledPeriod: "" }],
    ["a decimal above 2^256 - 1", { ...base, agentId: (2n ** 256n).toString() }],
    ["a decimal of 79 digits", { ...base, agentId: `1${"0".repeat(78)}` }],
    ["an address in lower case", { ...base, legalBody: lower(BODY) }],
    [
      "an address with a wrong checksum",
      { ...base, legalBody: "0x00000000000000000000000000000000000b0d1E" },
    ],
    ["a value that is not an address", { ...base, agentWallet: "0x1234" }],
    ["a bytes32 in upper case", { ...base, oaManifestHash: upper(FROZEN) }],
    ["a bytes32 of 31 bytes", { ...base, oaManifestHash: `0x${"ab".repeat(31)}` }],
    ["a bytes32 without its 0x", { ...base, oaManifestHash: "ab".repeat(32) }],
    ["a boolean written as text", { ...base, einIssued: "false" }],
    ["a boolean written as a number", { ...base, controlVerified: 1 }],
    ["a string written as a number", { ...base, legalName: 1 }],
    ["a null", { ...base, filingNumber: null }],
    ["a binding state outside its list", { ...base, bindingState: "unlinked" }],
    ["a standing outside its list", { ...base, standing: "good" }],
    ["an attestation state outside its list", { ...base, attestationState: "established" }],
    ["another jurisdiction", { ...base, jurisdiction: "DE" }],
    ["another entity type", { ...base, entityType: "INC" }],
    ["a source outside its list", { ...base, source: "formation" }],
    ["an environment outside its list", { ...base, environment: "staging" }],
    ["a filing status outside its list", { ...base, filingStatus: "late" }],
    ["a confirmation outside its list", { ...base, lastFiledConfirmedBy: "registry" }],
    ["an enumerated value in another letter case", { ...base, standing: "Active" }],
    ["a date that is not on the calendar", { ...base, filedAt: "2026-02-30" }],
    ["a date in another form", { ...base, lastFiledAt: "2026-1-20" }],
    ["a date with a time", { ...base, nextDue: "2027-01-01T00:00:00Z" }],
    ["null", null],
    ["an array", [base]],
    ["a JSON text", JSON.stringify(base)],
    ["a number", 42],
  ])("statementFromJson refuses %s, with a plain Error", (_name, j) => {
    const e = refusal(j);
    expect(e).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
  });
});

describe("claimsHash", () => {
  test("keccak256 over the canonical JSON of the claims: the JSON form without observedAtBlock, issuedAt and expiresAt", () => {
    const json: Record<string, string | boolean> = statementJson(GOLDEN);
    const names = Object.keys(json)
      .filter((name) => !TIME_FIELDS.includes(name))
      .sort();
    // A flat object of strings and booleans: its canonical JSON sorts the keys and has no space.
    const text = `{${names.map((name) => `${JSON.stringify(name)}:${JSON.stringify(json[name])}`).join(",")}}`;
    expect(
      text.startsWith(
        '{"agentId":"42","agentWallet":"0x00000000000000000000000000000000000A11e7",',
      ),
    ).toBe(true);
    expect(claimsHash(GOLDEN)).toBe(keccak256(stringToBytes(text)));
  });

  test("does not change with observedAtBlock, issuedAt or expiresAt, and changes with each of the 30 other fields", () => {
    const hash = claimsHash(GOLDEN);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      claimsHash({
        ...GOLDEN,
        observedAtBlock: 78n,
        issuedAt: 1_900_000_000n,
        expiresAt: 1_900_000_300n,
      }),
    ).toBe(hash);
    const json: Record<string, unknown> = statementJson(GOLDEN);
    let changed = 0;
    for (const { name, type } of LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement) {
      if (TIME_FIELDS.includes(name)) continue;
      const value = another(name, type, json[name]);
      const tampered = {
        ...GOLDEN,
        [name]: type === "uint256" ? BigInt(value as string) : value,
      } as LegalBodyStatement;
      expect(claimsHash(tampered), name).not.toBe(hash);
      changed += 1;
    }
    expect(changed).toBe(30);
  });
});

describe("signing and verifying", () => {
  test("a golden vector, pinned: the fixed statement signed with anvil's account 0", async () => {
    const signed = await signStatement(GOLDEN, ANVIL_0);
    expect(signed.signature).toBe(GOLDEN_SIGNATURE);
    expect(signed.attestor).toBe(GOLDEN_SIGNER);
    expect(signed.message).toStrictEqual(GOLDEN_JSON);
    expect(claimsHash(GOLDEN)).toBe(GOLDEN_CLAIMS_HASH);
    await expect(verify(wireOf(signed))).resolves.toBe(true);
  });

  test("a round trip through viem: signed, served as JSON text, recovered and verified", async () => {
    const signed = await signStatement(GOLDEN, ANVIL_0);
    expect(Object.keys(signed).sort()).toEqual([
      "attestor",
      "domain",
      "message",
      "primaryType",
      "signature",
    ]);
    expect(signed.domain).toStrictEqual(publicStatementDomain(CHAIN_ID));
    expect(signed.primaryType).toBe("LegalBodyStatement");
    expect(signed.message).toStrictEqual(statementJson(GOLDEN));
    expect(signed.attestor).toBe(ANVIL_0.address);
    const wire = wireOf(signed);
    expect(wire).toStrictEqual(signed);
    await expect(
      recoverTypedDataAddress({
        domain: wire.domain,
        types: LEGAL_BODY_STATEMENT_TYPES,
        primaryType: "LegalBodyStatement",
        message: statementMessage(statementFromJson(wire.message)),
        signature: wire.signature,
      }),
    ).resolves.toBe(ANVIL_0.address);
    // viem takes the served message as it is, decimal strings included.
    await expect(signatureCovers(wire, wire.message)).resolves.toBe(true);
    await expect(verify(wire)).resolves.toBe(true);
  });

  test("tampering with each of the 33 fields fails, and the count equals the type's length", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    const message: Record<string, unknown> = wire.message;
    let tampered = 0;
    for (const { name, type } of LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement) {
      const changed = { ...message, [name]: another(name, type, message[name]) };
      await expect(verify({ ...wire, message: changed }), name).resolves.toBe(false);
      // The signature itself binds the field, whatever the other rules say.
      await expect(signatureCovers(wire, changed), name).resolves.toBe(false);
      tampered += 1;
    }
    expect(tampered).toBe(LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement.length);
    expect(tampered).toBe(33);
  });

  test("another chain id fails", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    await expect(verify(wire, { expectedChainId: OTHER_CHAIN_ID })).resolves.toBe(false);
    const other = wireOf(
      await signStatement({ ...GOLDEN, chainId: BigInt(OTHER_CHAIN_ID) }, ANVIL_0),
    );
    expect(other.domain.chainId).toBe(OTHER_CHAIN_ID);
    await expect(verify(other, { expectedChainId: OTHER_CHAIN_ID })).resolves.toBe(true);
    await expect(verify(other)).resolves.toBe(false);
    // The domain and the message must both name the expected chain.
    await expect(verify({ ...other, domain: wire.domain })).resolves.toBe(false);
    await expect(
      verify({ ...other, message: { ...other.message, chainId: String(CHAIN_ID) } }),
    ).resolves.toBe(false);
    // Even signed so: the expected chain's domain over a message that names another chain.
    const elsewhere = { ...GOLDEN, chainId: BigInt(OTHER_CHAIN_ID) };
    const handSigned: SignedStatementJson = {
      ...wire,
      message: statementJson(elsewhere),
      signature: await ANVIL_0.signTypedData({
        domain: publicStatementDomain(CHAIN_ID),
        types: LEGAL_BODY_STATEMENT_TYPES,
        primaryType: "LegalBodyStatement",
        message: statementMessage(elsewhere),
      }),
    };
    await expect(signatureCovers(handSigned, handSigned.message)).resolves.toBe(true);
    await expect(verify(handSigned)).resolves.toBe(false);
  });

  test("the window: from 60 seconds before issuedAt to expiresAt, both included; a time after expiresAt, or more than 60 seconds before issuedAt, fails", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    // The 60 seconds are for a verifier whose clock runs behind the attestor's; none after expiry.
    await expect(verify(wire, { nowSeconds: ISSUED_AT - 61 })).resolves.toBe(false);
    await expect(verify(wire, { nowSeconds: ISSUED_AT - 60 })).resolves.toBe(true);
    await expect(verify(wire, { nowSeconds: ISSUED_AT })).resolves.toBe(true);
    await expect(verify(wire, { nowSeconds: ISSUED_AT + 300 })).resolves.toBe(true);
    await expect(verify(wire, { nowSeconds: ISSUED_AT + 301 })).resolves.toBe(false);
  });

  test("a time with a fraction of a second, as Date.now() / 1000 gives, counts as its whole second", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    await expect(verify(wire, { nowSeconds: ISSUED_AT + 0.5 })).resolves.toBe(true);
    // Rounded down, never to the nearest second: 60.5 seconds before issue counts as 61 and is
    // outside the window, 59.5 counts as 60 and is inside it, and the last half second of the
    // window is still inside it.
    await expect(verify(wire, { nowSeconds: ISSUED_AT - 60.5 })).resolves.toBe(false);
    await expect(verify(wire, { nowSeconds: ISSUED_AT - 59.5 })).resolves.toBe(true);
    await expect(verify(wire, { nowSeconds: ISSUED_AT + 300.5 })).resolves.toBe(true);
  });

  test("a lifetime other than 300 seconds fails, even when signed so", async () => {
    for (const expiresAt of [GOLDEN.expiresAt + 1n, GOLDEN.expiresAt - 1n, GOLDEN.issuedAt]) {
      const wire = wireOf(await signStatement({ ...GOLDEN, expiresAt }, ANVIL_0));
      await expect(verify(wire, { nowSeconds: ISSUED_AT }), String(expiresAt)).resolves.toBe(false);
    }
  });

  test("another key fails", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    await expect(verify(wire, { attestor: ANVIL_1.address })).resolves.toBe(false);
    await expect(verify(wireOf(await signStatement(GOLDEN, ANVIL_1)))).resolves.toBe(false);
  });

  test("the attestor is the caller's: signed by one key, its attestor rewritten to another, it fails against the other; the served field is never used", async () => {
    const byOne = wireOf(await signStatement(GOLDEN, ANVIL_1));
    const rewritten = { ...byOne, attestor: ANVIL_0.address };
    await expect(verify(rewritten, { attestor: ANVIL_0.address })).resolves.toBe(false);
    await expect(verify(rewritten, { attestor: ANVIL_1.address })).resolves.toBe(true);
  });

  test("the message is read in its canonical form only: a value the signature still covers fails when it is not canonical", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    for (const [name, message] of [
      ["an agent id with a leading zero", { ...wire.message, agentId: "042" }],
      ["an address in lower case", { ...wire.message, legalBody: lower(BODY) }],
      ["a hash in upper case", { ...wire.message, oaManifestHash: upper(FROZEN) }],
    ] as const) {
      await expect(signatureCovers(wire, message), name).resolves.toBe(true);
      await expect(verify({ ...wire, message }), name).resolves.toBe(false);
    }
  });

  test("the signature is read in its canonical form only, a low s and v 27 or 28: the signer's other forms over the same digest fail", async () => {
    const golden = wireOf(await signStatement(GOLDEN, ANVIL_0));
    expect(golden.signature).toBe(GOLDEN_SIGNATURE);
    expect(sAndV(golden.signature).v).toBe(27);
    // A signature that ends in v 28 as well, so that v written 1 is tried over a low s too.
    const endingIn28 = await signedEndingIn(28);
    for (const signed of [golden, endingIn28]) {
      const { s, v } = sAndV(signed.signature);
      // What signStatement writes, and what verifies: s at most n/2.
      expect(s <= SECP256K1_N / 2n).toBe(true);
      await expect(verify(signed)).resolves.toBe(true);
      for (const [name, signature] of [
        [
          `the twin: n - s, v ${v} written ${55 - v}`,
          respelled(signed.signature, SECP256K1_N - s, 55 - v),
        ],
        [`v ${v} written ${v - 27}`, respelled(signed.signature, s, v - 27)],
      ] as const) {
        // viem alone recovers the same signer from it: the refusal is the verifier's own rule.
        await expect(signatureCovers({ ...signed, signature }, signed.message), name).resolves.toBe(
          true,
        );
        await expect(verify({ ...signed, signature }), name).resolves.toBe(false);
      }
      // The same signature in upper-case hex: viem reads it, the verifier refuses the other text.
      const upper = `0x${signed.signature.slice(2).toUpperCase()}` as const;
      await expect(signatureCovers({ ...signed, signature: upper }, signed.message)).resolves.toBe(
        true,
      );
      await expect(verify({ ...signed, signature: upper })).resolves.toBe(false);
    }
  });

  test("the envelope: exactly its five keys, and a domain of exactly its three", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    await expect(verify(wire)).resolves.toBe(true);
    const { attestor: _attestor, ...noAttestor } = wire;
    const { version: _version, ...noVersion } = wire.domain;
    const cases: [string, unknown][] = [
      ["a key missing", noAttestor],
      ["a key added", { ...wire, issuer: "Novi Corpus" }],
      [
        "a domain with a verifying contract",
        { ...wire, domain: { ...wire.domain, verifyingContract: FACTORY } },
      ],
      ["a domain without its version", { ...wire, domain: noVersion }],
      [
        "a domain whose chain id is text",
        { ...wire, domain: { ...wire.domain, chainId: String(CHAIN_ID) } },
      ],
      ["a domain of another name", { ...wire, domain: { ...wire.domain, name: "Novi Corpus" } }],
      ["a domain of version 1", { ...wire, domain: { ...wire.domain, version: "1" } }],
      ["a domain that is not an object", { ...wire, domain: null }],
      ["another primary type", { ...wire, primaryType: "LegalBodyAttestation" }],
      ["an attestor that is not an address", { ...wire, attestor: "0x1234" }],
      ["an attestor that is not text", { ...wire, attestor: 7 }],
      ["a signature that is not 65 bytes", { ...wire, signature: wire.signature.slice(0, -2) }],
      ["a signature that is not hex", { ...wire, signature: `0x${"zz".repeat(65)}` }],
      ["a signature that is not text", { ...wire, signature: 7 }],
      ["a message written as JSON text", { ...wire, message: JSON.stringify(wire.message) }],
    ];
    for (const [name, envelope] of cases) await expect(verify(envelope), name).resolves.toBe(false);
  });

  test("malformed input answers false and never throws", async () => {
    const wire = wireOf(await signStatement(GOLDEN, ANVIL_0));
    for (const malformed of [undefined, null, "", '{"domain":', 42, true, [], {}, [wire]])
      await expect(verify(malformed), JSON.stringify(malformed) ?? "undefined").resolves.toBe(
        false,
      );
    const throwing = { ...wire };
    Object.defineProperty(throwing, "domain", {
      enumerable: true,
      get() {
        throw new Error("unreadable");
      },
    });
    await expect(verify(throwing)).resolves.toBe(false);
    for (const nowSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      await expect(verify(wire, { nowSeconds }), String(nowSeconds)).resolves.toBe(false);
    await expect(verify(wire, { expectedChainId: Number.NaN })).resolves.toBe(false);
    await expect(verify(wire, { attestor: "0x1234" as Address })).resolves.toBe(false);
  });
});
