import {
  type Address,
  type Hex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverAddress,
  serializeCompactSignature,
  serializeErc6492Signature,
  signatureToCompactSignature,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  STATEMENT_DOMAIN_NAME,
  STATEMENT_DOMAIN_VERSION,
  STATEMENT_MAX_AGE_SECONDS,
  STATEMENT_MAX_AHEAD_SECONDS,
  STATEMENT_PRIMARY_TYPE,
  type StatementMessage,
  buildStatementMessage,
  statementDigest,
  statementDomain,
  statementHash,
  statementTypedDataWire,
  verifyStatement,
} from "../../src/legalBody/statement";
import {
  STATEMENT_OF_AUTHORITY,
  type StatementFields,
} from "../../src/legalBody/texts/statementOfAuthority";

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const owner = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const stranger = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const FACTORY = "0x00000000000000000000000000000000000fAc70" as Address;
const OTHER_FACTORY = "0x00000000000000000000000000000000000A11cE" as Address;
const CHAIN_ID = 31_337;
/** The server's clock in the tests, in unix seconds. */
const NOW = 1_790_000_000n;

const STATEMENT_TYPE =
  "StatementOfAuthority(string statement,string declarantName,string declarantTitle,string companyName,string jurisdiction,string filingNumber,address guardian,string wordingVersion,uint256 issuedAt)";

/** Invented values only: no real person, company or filing number. */
function fieldsFor(guardian: Address): StatementFields {
  return {
    declarantName: "Ada Example",
    declarantTitle: "Manager",
    companyName: "Example Holdings LLC",
    jurisdiction: "WY",
    filingNumber: "TEST-0001",
    guardian,
  };
}
const FIELDS = fieldsFor(owner.address);

const messageAt = (issuedAt: bigint, fields: StatementFields = FIELDS): StatementMessage =>
  buildStatementMessage(fields, STATEMENT_OF_AUTHORITY, issuedAt);

/** What a wallet does: sign the served wire form exactly as it arrives over JSON. */
function signServed(
  m: StatementMessage,
  opts: { signer?: typeof owner; factory?: Address; chainId?: number } = {},
): Promise<Hex> {
  const served = statementTypedDataWire(opts.chainId ?? CHAIN_ID, opts.factory ?? FACTORY, m);
  return (opts.signer ?? owner).signTypedData(JSON.parse(JSON.stringify(served)));
}

type VerifyInput = Parameters<typeof verifyStatement>[0];

/** The owner's own statement, issued now, with any part of the call overridden. */
function verify(over: Partial<VerifyInput> & { signature: Hex }) {
  return verifyStatement({
    chainId: CHAIN_ID,
    factory: FACTORY,
    tenant: owner.address,
    text: STATEMENT_OF_AUTHORITY,
    fields: FIELDS,
    issuedAt: NOW,
    nowSeconds: NOW,
    ...over,
  });
}

/** The refusal's problem, or "accepted". */
async function outcome(over: Partial<VerifyInput> & { signature: Hex }): Promise<string> {
  const result = await verify(over);
  return result.ok ? "accepted" : result.problem;
}

afterEach(() => vi.restoreAllMocks());

test("the constants are the statement's domain, its type and its time window", () => {
  expect(STATEMENT_DOMAIN_NAME).toBe("Novi Corpus Statement of Authority");
  expect(STATEMENT_DOMAIN_VERSION).toBe("1");
  expect(STATEMENT_PRIMARY_TYPE).toBe("StatementOfAuthority");
  expect(STATEMENT_MAX_AGE_SECONDS).toBe(600n);
  expect(STATEMENT_MAX_AHEAD_SECONDS).toBe(60n);
  expect(statementDomain(CHAIN_ID, FACTORY)).toEqual({
    name: "Novi Corpus Statement of Authority",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: FACTORY,
  });
});

test("the digest equals an independent EIP-712 encoding of the statement's type string and domain", () => {
  const m = messageAt(NOW);
  const s = (value: string) => keccak256(stringToHex(value));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        s("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        s("Novi Corpus Statement of Authority"),
        s("1"),
        BigInt(CHAIN_ID),
        FACTORY,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        s(STATEMENT_TYPE),
        s(STATEMENT_OF_AUTHORITY.render(FIELDS)),
        s("Ada Example"),
        s("Manager"),
        s("Example Holdings LLC"),
        s("WY"),
        s("TEST-0001"),
        owner.address,
        s(STATEMENT_OF_AUTHORITY.version),
        NOW,
      ],
    ),
  );
  const expected = keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);
  expect(statementDigest(CHAIN_ID, FACTORY, m)).toBe(expected);
});

test("the message is built from the fields and the server's text, never from a sentence the caller holds", () => {
  expect(messageAt(NOW)).toEqual({
    statement: STATEMENT_OF_AUTHORITY.render(FIELDS),
    ...FIELDS,
    wordingVersion: STATEMENT_OF_AUTHORITY.version,
    issuedAt: NOW,
  });
  // A sentence or a version smuggled in beside the fields is ignored: both come from the text.
  const smuggled = {
    ...FIELDS,
    statement: "Some other sentence.",
    wordingVersion: "another-version",
  } as StatementFields;
  expect(buildStatementMessage(smuggled, STATEMENT_OF_AUTHORITY, NOW)).toEqual(messageAt(NOW));
});

test("the digest of the parsed wire form, signed by a test key, recovers to that key", async () => {
  const m = messageAt(NOW);
  const served = statementTypedDataWire(CHAIN_ID, FACTORY, m);
  const wire = JSON.parse(JSON.stringify(served));
  expect(wire).toEqual(served);

  expect(wire.domain).toEqual(statementDomain(CHAIN_ID, FACTORY));
  expect(wire.domain.chainId).toBe(CHAIN_ID);
  expect(Object.keys(wire.types)).toEqual(["EIP712Domain", "StatementOfAuthority"]);
  expect(wire.types.EIP712Domain).toEqual([
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  expect(wire.primaryType).toBe("StatementOfAuthority");
  const fields = wire.types.StatementOfAuthority as { name: string; type: string }[];
  expect(`${wire.primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`).toBe(
    STATEMENT_TYPE,
  );
  // issuedAt travels as a canonical decimal string, so the object is JSON.
  expect(wire.message).toEqual({
    statement: m.statement,
    ...FIELDS,
    wordingVersion: STATEMENT_OF_AUTHORITY.version,
    issuedAt: "1790000000",
  });

  const digest = statementDigest(CHAIN_ID, FACTORY, m);
  expect(hashTypedData(wire)).toBe(digest);
  const signature = await owner.signTypedData(wire);
  expect(await recoverAddress({ hash: digest, signature })).toBe(owner.address);
});

test("statementHash is the keccak256 of the sentence's UTF-8 bytes", () => {
  const m = messageAt(NOW, { ...FIELDS, declarantName: "Zoë Exämple" });
  const utf8 = new TextEncoder().encode(m.statement);
  // The accented letters take two bytes each in UTF-8.
  expect(utf8.length).toBe(m.statement.length + 2);
  expect(statementHash(m)).toBe(keccak256(utf8));
  expect(statementHash(messageAt(NOW))).toBe(
    keccak256(new TextEncoder().encode(STATEMENT_OF_AUTHORITY.render(FIELDS))),
  );
});

test("two guardians with the same other fields give two different sentences and two different digests", () => {
  const mine = messageAt(NOW, fieldsFor(owner.address));
  const theirs = messageAt(NOW, fieldsFor(stranger.address));
  expect(mine.statement).toContain(owner.address);
  expect(theirs.statement).toContain(stranger.address);
  expect(mine.statement).not.toBe(theirs.statement);
  expect(statementHash(mine)).not.toBe(statementHash(theirs));
  expect(statementDigest(CHAIN_ID, FACTORY, mine)).not.toBe(
    statementDigest(CHAIN_ID, FACTORY, theirs),
  );
});

test("any changed field, issuedAt, chain id or factory changes the digest", () => {
  const m = messageAt(NOW);
  const base = statementDigest(CHAIN_ID, FACTORY, m);
  const variants: StatementMessage[] = [
    messageAt(NOW, { ...FIELDS, declarantName: "Ada Examples" }),
    messageAt(NOW, { ...FIELDS, declarantTitle: "Member" }),
    messageAt(NOW, { ...FIELDS, companyName: "Example Holdings II LLC" }),
    messageAt(NOW, { ...FIELDS, filingNumber: "TEST-0002" }),
    messageAt(NOW + 1n),
    { ...m, wordingVersion: "another-version" },
  ];
  for (const v of variants) expect(statementDigest(CHAIN_ID, FACTORY, v)).not.toBe(base);
  expect(statementDigest(1, FACTORY, m)).not.toBe(base);
  expect(statementDigest(CHAIN_ID, OTHER_FACTORY, m)).not.toBe(base);
});

describe("verifyStatement", () => {
  test("accepts the tenant's signature and returns the message and the digest, with no client and no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const m = messageAt(NOW);
    const result = await verify({ signature: await signServed(m) });
    expect(result).toEqual({ ok: true, message: m, digest: statementDigest(CHAIN_ID, FACTORY, m) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("refuses a signature over the sentence with one word changed", async () => {
    const m = messageAt(NOW);
    const changed = { ...m, statement: m.statement.replace("authorised", "authorized") };
    expect(changed.statement).not.toBe(m.statement);
    expect(await outcome({ signature: await signServed(changed) })).toBe("bad_signature");
  });

  test("refuses a signature over another wording version", async () => {
    const otherText = { ...STATEMENT_OF_AUTHORITY, version: "2026-10-draft-0" };
    const signature = await signServed(buildStatementMessage(FIELDS, otherText, NOW));
    expect(await outcome({ signature })).toBe("bad_signature");
    // The same signature stands under the version it was made for: only the version differs.
    expect(await outcome({ signature, text: otherText })).toBe("accepted");
  });

  test("refuses a signature made for another factory", async () => {
    const signature = await signServed(messageAt(NOW), { factory: OTHER_FACTORY });
    expect(await outcome({ signature })).toBe("bad_signature");
    expect(await outcome({ signature, factory: OTHER_FACTORY })).toBe("accepted");
  });

  test("refuses a signature from another key", async () => {
    const signature = await signServed(messageAt(NOW), { signer: stranger });
    expect(await outcome({ signature })).toBe("bad_signature");
  });

  test("refuses a statement whose guardian is not the tenant, whoever signed it", async () => {
    const theirs = fieldsFor(stranger.address);
    const signedByTenant = await signServed(messageAt(NOW, theirs));
    expect(await outcome({ fields: theirs, signature: signedByTenant })).toBe("wrong_wording");
    const signedByGuardian = await signServed(messageAt(NOW, theirs), { signer: stranger });
    expect(await outcome({ fields: theirs, signature: signedByGuardian })).toBe("wrong_wording");
    // The guardian is the tenant as the session spells it, checksummed.
    const lowerCase = fieldsFor(owner.address.toLowerCase() as Address);
    const signedLowerCase = await signServed(messageAt(NOW, lowerCase));
    expect(await outcome({ fields: lowerCase, signature: signedLowerCase })).toBe("wrong_wording");
  });

  test("refuses a 64-byte and a 66-byte signature as an unsupported signer", async () => {
    const signature = await signServed(messageAt(NOW));
    const compact = serializeCompactSignature(
      signatureToCompactSignature(parseSignature(signature)),
    );
    expect((compact.length - 2) / 2).toBe(64);
    expect(await outcome({ signature: compact })).toBe("unsupported_signer");
    const longer = `${signature}00` as Hex;
    expect((longer.length - 2) / 2).toBe(66);
    expect(await outcome({ signature: longer })).toBe("unsupported_signer");
    // A contract wallet's wrapped signature, and no signature at all, are other lengths too.
    const wrapped = serializeErc6492Signature({ address: FACTORY, data: "0x", signature });
    expect(await outcome({ signature: wrapped })).toBe("unsupported_signer");
    expect(await outcome({ signature: "0x" })).toBe("unsupported_signer");
  });

  test("refuses 65 bytes that recover to no key, and text that is not hex, without throwing", async () => {
    expect(await outcome({ signature: `0x${"00".repeat(65)}` })).toBe("bad_signature");
    expect(await outcome({ signature: `0x${"zz".repeat(65)}` as Hex })).toBe("bad_signature");
    expect(await outcome({ signature: "not a signature" as Hex })).toBe("bad_signature");
  });

  test.each<[string, bigint, string]>([
    ["600 seconds old is accepted", NOW - 600n, "accepted"],
    ["601 seconds old is stale", NOW - 601n, "stale"],
    ["60 seconds ahead is accepted", NOW + 60n, "accepted"],
    ["61 seconds ahead is stale", NOW + 61n, "stale"],
  ])("issuedAt %s", async (_name, issuedAt, expected) => {
    const signature = await signServed(messageAt(issuedAt));
    expect(await outcome({ issuedAt, signature })).toBe(expected);
  });
});
