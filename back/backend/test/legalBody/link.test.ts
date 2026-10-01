import {
  type Address,
  type Hex,
  encodeAbiParameters,
  hashTypedData,
  hexToBigInt,
  keccak256,
  maxUint256,
  numberToHex,
  parseSignature,
  recoverAddress,
  serializeCompactSignature,
  serializeErc6492Signature,
  signatureToCompactSignature,
  stringToHex,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import {
  DEFAULT_LINK_TTL_SECONDS,
  LINK_DOMAIN_NAME,
  LINK_DOMAIN_VERSION,
  LINK_FIELDS,
  LINK_PRIMARY_TYPE,
  type LegalBodyLink,
  LinkShapeError,
  MAX_LINK_WINDOW_SECONDS,
  MAX_SERVED_LINK_TTL_SECONDS,
  MIN_LINK_REMAINING_SECONDS,
  buildLinkTypedData,
  canonicalLinkSignature,
  deadlineInWindow,
  isErc6492Wrapped,
  linkDeadline,
  linkDomain,
  linkFromWire,
  linkShapeProblem,
  linkTypedDataWire,
  linkVerifyTypes,
  offChainLinkDigest,
} from "../../src/legalBody/link";

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const owner = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const stranger = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const FACTORY = "0x00000000000000000000000000000000000fAc70" as Address;
const GUARDIAN = "0x00000000000000000000000000000000000A11cE" as Address;
const CHAIN_ID = 31_337;
const link: LegalBodyLink = {
  agentId: 42n,
  guardian: GUARDIAN,
  amendmentDelay: 172_800n,
  operatingAgreementHash: `0x${"ab".repeat(32)}` as Hex,
  deadline: 1_900_000_000n,
};
const p = { chainId: CHAIN_ID, factory: FACTORY, link };

/** The secp256k1 group order, written out here independently of the module under test. */
const SECP256K1_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

/** The same signature with its last byte replaced by a raw recovery bit (0 or 1). */
function withRecoveryBit(signature: Hex): Hex {
  const { yParity } = parseSignature(signature);
  return `${signature.slice(0, 130)}0${yParity}` as Hex;
}

/** The same signature in its 64-byte EIP-2098 compact form. */
function compact(signature: Hex): Hex {
  return serializeCompactSignature(signatureToCompactSignature(parseSignature(signature)));
}

/** The same signature with `s` replaced by its high twin `n - s` and the recovery bit flipped. */
function highS(signature: Hex): Hex {
  const { r, s, yParity } = parseSignature(signature);
  const twin = numberToHex(SECP256K1_N - hexToBigInt(s), { size: 32 });
  return `${r}${twin.slice(2)}${yParity === 0 ? "1c" : "1b"}` as Hex;
}

test("the off-chain digest equals an independent EIP-712 encoding of the contract's type strings", () => {
  const typeHash = keccak256(
    stringToHex(
      "LegalBodyLink(uint256 agentId,address guardian,uint256 amendmentDelay,bytes32 operatingAgreementHash,uint256 deadline)",
    ),
  );
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
        keccak256(
          stringToHex(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
          ),
        ),
        keccak256(stringToHex("Novi LegalBodyFactory")),
        keccak256(stringToHex("1")),
        BigInt(CHAIN_ID),
        FACTORY,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        typeHash,
        link.agentId,
        link.guardian,
        link.amendmentDelay,
        link.operatingAgreementHash,
        link.deadline,
      ],
    ),
  );
  const expected = keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);
  expect(offChainLinkDigest(p)).toBe(expected);
});

test("the constants are the names and the window the contract was deployed with", () => {
  expect(LINK_DOMAIN_NAME).toBe("Novi LegalBodyFactory");
  expect(LINK_DOMAIN_VERSION).toBe("1");
  expect(LINK_PRIMARY_TYPE).toBe("LegalBodyLink");
  expect(`${LINK_PRIMARY_TYPE}(${LINK_FIELDS.map((f) => `${f.type} ${f.name}`).join(",")})`).toBe(
    "LegalBodyLink(uint256 agentId,address guardian,uint256 amendmentDelay,bytes32 operatingAgreementHash,uint256 deadline)",
  );
  expect(linkDomain(CHAIN_ID, FACTORY)).toEqual({
    name: "Novi LegalBodyFactory",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: FACTORY,
  });
  expect(MAX_LINK_WINDOW_SECONDS).toBe(24n * 60n * 60n);
  expect(MAX_SERVED_LINK_TTL_SECONDS).toBe(24n * 60n * 60n - 10n * 60n);
  expect(DEFAULT_LINK_TTL_SECONDS).toBe(3_600n);
  expect(MIN_LINK_REMAINING_SECONDS).toBe(300n);
});

test("the signing form declares EIP712Domain, the verifying form does not, and both hash to the same digest", () => {
  const td = buildLinkTypedData(p);
  expect(Object.keys(td.types)).toEqual(["EIP712Domain", "LegalBodyLink"]);
  expect(Object.keys(linkVerifyTypes())).toEqual(["LegalBodyLink"]);
  expect(td.primaryType).toBe("LegalBodyLink");
  expect(td.message).toEqual(link);
  expect(hashTypedData(td)).toBe(offChainLinkDigest(p));
});

test("a signature over the signing form verifies against the verifying form", async () => {
  const signature = await owner.signTypedData(buildLinkTypedData(p));
  await expect(
    verifyTypedData({
      address: owner.address,
      domain: linkDomain(CHAIN_ID, FACTORY),
      types: linkVerifyTypes(),
      primaryType: LINK_PRIMARY_TYPE,
      message: link,
      signature,
    }),
  ).resolves.toBe(true);
});

test("any changed field, chain id or factory changes the digest", () => {
  const base = offChainLinkDigest(p);
  const variants: LegalBodyLink[] = [
    { ...link, agentId: 43n },
    { ...link, guardian: FACTORY },
    { ...link, amendmentDelay: 172_801n },
    { ...link, operatingAgreementHash: `0x${"cd".repeat(32)}` as Hex },
    { ...link, deadline: link.deadline + 1n },
  ];
  for (const v of variants) expect(offChainLinkDigest({ ...p, link: v })).not.toBe(base);
  expect(offChainLinkDigest({ ...p, chainId: 1 })).not.toBe(base);
  expect(offChainLinkDigest({ ...p, factory: GUARDIAN })).not.toBe(base);
});

test("the wire form survives JSON, hashes to the off-chain digest, and a wallet signing it signs that digest", async () => {
  const served = linkTypedDataWire(p);
  const wire = JSON.parse(JSON.stringify(served));
  expect(wire).toEqual(served);
  expect(wire.domain).toEqual({
    name: "Novi LegalBodyFactory",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: FACTORY,
  });
  expect(Object.keys(wire.types)).toEqual(["EIP712Domain", "LegalBodyLink"]);
  expect(wire.primaryType).toBe("LegalBodyLink");
  expect(wire.message).toEqual({
    agentId: "42",
    guardian: GUARDIAN,
    amendmentDelay: "172800",
    operatingAgreementHash: link.operatingAgreementHash,
    deadline: "1900000000",
  });

  const digest = offChainLinkDigest(p);
  expect(hashTypedData(wire)).toBe(digest);
  const signature = await owner.signTypedData(wire);
  expect(await recoverAddress({ hash: digest, signature })).toBe(owner.address);
});

test("linkFromWire round-trips the served message and accepts the uint256 edges", () => {
  const message = linkTypedDataWire(p).message;
  expect(linkFromWire(message)).toEqual(link);
  expect(linkFromWire(JSON.parse(JSON.stringify(message)))).toEqual(link);
  expect(linkFromWire({ ...message, agentId: "0", deadline: maxUint256.toString() })).toEqual({
    ...link,
    agentId: 0n,
    deadline: maxUint256,
  });
});

test("linkFromWire returns the hash in lower case and the guardian checksummed", () => {
  const message = {
    ...linkTypedDataWire(p).message,
    guardian: GUARDIAN.toLowerCase(),
    operatingAgreementHash: `0x${"AB".repeat(32)}`,
  };
  const parsed = linkFromWire(message);
  expect(parsed.operatingAgreementHash).toBe(`0x${"ab".repeat(32)}`);
  expect(parsed.guardian).toBe(GUARDIAN);
  expect(parsed.guardian).not.toBe(message.guardian);
  expect(parsed).toEqual(link);
});

const servedMessage = linkTypedDataWire(p).message;
const { deadline: _deadline, ...withoutDeadline } = servedMessage;
test.each<[string, unknown]>([
  ["a JavaScript number, even an integer", { ...servedMessage, agentId: 42 }],
  ["a leading zero", { ...servedMessage, agentId: "042" }],
  ["a sign", { ...servedMessage, amendmentDelay: "-1" }],
  ["an exponent", { ...servedMessage, deadline: "1e3" }],
  ["a 79-digit value", { ...servedMessage, agentId: "1".repeat(79) }],
  ["2^256", { ...servedMessage, agentId: (2n ** 256n).toString() }],
  ["a missing field", withoutDeadline],
  ["an extra unknown field", { ...servedMessage, salt: "1" }],
  ["a malformed address", { ...servedMessage, guardian: "0x1234" }],
  ["an address with a wrong checksum", { ...servedMessage, guardian: GUARDIAN.replace("A", "a") }],
  ["a 31-byte hash", { ...servedMessage, operatingAgreementHash: `0x${"ab".repeat(31)}` }],
  ["something that is not an object", null],
])("linkFromWire refuses %s", (_name, message) => {
  expect(() => linkFromWire(message)).toThrow(LinkShapeError);
});

test("linkShapeProblem accepts a well-formed link with any whole-bytes signature, an empty one included", async () => {
  const signature = await owner.sign({ hash: offChainLinkDigest(p) });
  expect(linkShapeProblem(link, signature)).toBeUndefined();
  expect(linkShapeProblem(link, "0x")).toBeUndefined();
  // The uint256 range is this function's rule; the factory's own bounds on the delay are not.
  expect(linkShapeProblem({ ...link, amendmentDelay: 0n }, "0x")).toBeUndefined();
  expect(linkShapeProblem({ ...link, amendmentDelay: maxUint256 }, "0x")).toBeUndefined();
});

test("linkShapeProblem names a malformed signature, a value outside uint256, a short hash and a bad guardian", () => {
  for (const signature of ["0x123", "0xzz", "1234"])
    expect(linkShapeProblem(link, signature as Hex)).toMatch(/signature/);
  for (const field of ["agentId", "amendmentDelay", "deadline"] as const)
    for (const value of [-1n, 2n ** 256n])
      expect(linkShapeProblem({ ...link, [field]: value }, "0x")).toMatch(field);
  expect(
    linkShapeProblem({ ...link, operatingAgreementHash: `0x${"ab".repeat(31)}` as Hex }, "0x"),
  ).toMatch(/operatingAgreementHash/);
  expect(linkShapeProblem({ ...link, guardian: "0x1234" as Address }, "0x")).toMatch(/guardian/);
});

test("linkDeadline adds a lifetime to chain time and refuses one the backend must not serve", () => {
  expect(linkDeadline(1_000n)).toBe(4_600n);
  expect(linkDeadline(1_000n, 85_800n)).toBe(86_800n);
  expect(() => linkDeadline(1_000n, 85_801n)).toThrow(/85800/);
  expect(() => linkDeadline(1_000n, 0n)).toThrow(/positive/);
});

test("deadlineInWindow: at least 300 s left, and never beyond the factory's 24 hours", () => {
  const now = 1_000_000n;
  expect(deadlineInWindow(now + 300n, now)).toBe(true);
  expect(deadlineInWindow(now + 299n, now)).toBe(false);
  expect(deadlineInWindow(now + 86_400n, now)).toBe(true);
  expect(deadlineInWindow(now + 86_401n, now)).toBe(false);
  expect(deadlineInWindow(now - 1n, now)).toBe(false);
});

test("canonicalLinkSignature keeps the owner's canonical signature and rewrites its other forms to it", async () => {
  // Cover both recovery bits: v = 27 and v = 28.
  const covered = new Set<number>();
  for (let i = 0n; covered.size < 2 && i < 32n; i++) {
    const digest = offChainLinkDigest({ ...p, link: { ...link, deadline: link.deadline + i } });
    const canonical = await owner.sign({ hash: digest });
    const { yParity } = parseSignature(canonical);
    if (yParity === undefined || covered.has(yParity)) continue;
    covered.add(yParity);

    expect(
      await canonicalLinkSignature({ digest, owner: owner.address, signature: canonical }),
    ).toBe(canonical);
    const high = highS(canonical);
    // The high-s twin is a genuine signature of the owner's, so a rewrite is the right answer.
    expect(await recoverAddress({ hash: digest, signature: high })).toBe(owner.address);
    for (const form of [withRecoveryBit(canonical), compact(canonical), high]) {
      expect(form).not.toBe(canonical);
      expect(await canonicalLinkSignature({ digest, owner: owner.address, signature: form })).toBe(
        canonical,
      );
    }
  }
  expect(covered.size).toBe(2);
});

test("canonicalLinkSignature returns, byte for byte, a signature that recovers to the owner in no form", async () => {
  const digest = offChainLinkDigest(p);
  const theirs = await stranger.sign({ hash: digest });
  const untouched: Hex[] = [
    theirs,
    withRecoveryBit(theirs),
    compact(theirs),
    highS(theirs),
    // 65 bytes whose last byte is 0 or 1: a contract wallet's own encoding, not a recovery bit.
    `0x${"AB".repeat(64)}00`,
    `0x${"AB".repeat(64)}01`,
    // ...and one whose rewritten form recovers no key at all (r is not on the curve).
    `0x${"11".repeat(64)}00`,
    "0x",
    `0x${"cd".repeat(100)}`,
  ];
  for (const signature of untouched)
    expect(await canonicalLinkSignature({ digest, owner: owner.address, signature })).toBe(
      signature,
    );
});

test("isErc6492Wrapped spots the ERC-6492 suffix", async () => {
  const plain = await owner.sign({ hash: offChainLinkDigest(p) });
  const wrapped = serializeErc6492Signature({
    address: "0x000000000000000000000000000000000000dEaD",
    data: "0xdeadbeef",
    signature: plain,
  });
  expect(isErc6492Wrapped(wrapped)).toBe(true);
  expect(isErc6492Wrapped(plain)).toBe(false);
  expect(isErc6492Wrapped("0x")).toBe(false);
});
