import {
  type Address,
  type Hex,
  HttpRequestError,
  InternalRpcError,
  parseSignature,
  serializeCompactSignature,
  serializeErc6492Signature,
  signatureToCompactSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import {
  type LegalBodyChain,
  LegalBodyChainFaultError,
  LegalBodyGasTooHighError,
} from "../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { type LinkChainPort, checkLink } from "../../src/legalBody/checkLink";
import {
  type LegalBodyLink,
  buildLinkTypedData,
  offChainLinkDigest,
} from "../../src/legalBody/link";

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const owner = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const stranger = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);

const CHAIN_ID = 31_337;
const FACTORY = "0x00000000000000000000000000000000000fAc70" as Address;
const TENANT = "0x00000000000000000000000000000000000A11cE" as Address;
const BODY = "0x00000000000000000000000000000000000B0d1E" as Address;
/** A placeholder owner that is a smart account. */
const WALLET = "0x000000000000000000000000000000000005Afe1" as Address;
const OA = `0x${"ab".repeat(32)}` as Hex;
/** The head every check reads: its number pins the reads, its timestamp is chain time. */
const HEAD = { number: 7_777n, timestamp: 1_800_000_000n };
const GAS_LIMIT = 362_500n;
/** A signature no ECDSA reading fits: a smart account's own encoding. */
const WALLET_SIGNATURE = `0x${"5a".repeat(100)}` as Hex;

const link: LegalBodyLink = {
  agentId: 42n,
  guardian: TENANT,
  amendmentDelay: 172_800n,
  operatingAgreementHash: OA,
  deadline: HEAD.timestamp + 3_600n,
};
const expected = { tenant: TENANT, operatingAgreementHash: OA, amendmentDelay: 172_800n };
const DIGEST = offChainLinkDigest({ chainId: CHAIN_ID, factory: FACTORY, link });

function sign(by = owner, l: LegalBodyLink = link): Promise<Hex> {
  return by.signTypedData(buildLinkTypedData({ chainId: CHAIN_ID, factory: FACTORY, link: l }));
}

/** The same signature with its last byte replaced by a raw recovery bit (0 or 1). */
function withRecoveryBit(signature: Hex): Hex {
  const { yParity } = parseSignature(signature);
  return `${signature.slice(0, 130)}0${yParity}` as Hex;
}

/** The same signature in its 64-byte EIP-2098 compact form. */
function compact(signature: Hex): Hex {
  return serializeCompactSignature(signatureToCompactSignature(parseSignature(signature)));
}

/** The factory's refusal of a signature, as the relayed create's simulation reports it. */
function badSignature(): ContractRevertError {
  return new ContractRevertError("createLegalBody reverted: BadSignature()", "BadSignature");
}

/** A chain on which the link is valid, the identity owned by `owner` and no body created yet. */
function fakeChain() {
  return {
    chainId: CHAIN_ID,
    factory: FACTORY,
    head: vi.fn<LinkChainPort["head"]>(async () => HEAD),
    identityOwner: vi.fn<LinkChainPort["identityOwner"]>(async () => owner.address),
    hasCode: vi.fn<LinkChainPort["hasCode"]>(async () => false),
    linkDigest: vi.fn<LinkChainPort["linkDigest"]>(async (l) =>
      offChainLinkDigest({ chainId: CHAIN_ID, factory: FACTORY, link: l }),
    ),
    predictLegalBody: vi.fn<LinkChainPort["predictLegalBody"]>(async () => BODY),
    bodyCreator: vi.fn<LinkChainPort["bodyCreator"]>(async () => undefined),
    estimateCreate: vi.fn<LinkChainPort["estimateCreate"]>(async () => GAS_LIMIT),
  } satisfies LinkChainPort;
}

type FakeChain = ReturnType<typeof fakeChain>;
const CHAIN_METHODS = [
  "head",
  "identityOwner",
  "hasCode",
  "linkDigest",
  "predictLegalBody",
  "bodyCreator",
  "estimateCreate",
] as const;

function chainCalls(chain: FakeChain): number {
  return CHAIN_METHODS.reduce((n, m) => n + chain[m].mock.calls.length, 0);
}

/** Never called: this compiles only while the real chain adapter satisfies the port. */
function realChainIsALinkChainPort(chain: LegalBodyChain): LinkChainPort {
  return chain;
}

test("a valid link is accepted, with the signature, the block it was observed at and the gas limit", async () => {
  const chain = fakeChain();
  const signature = await sign();
  const check = await checkLink(chain, { link, signature, expected });
  expect(check).toStrictEqual({
    ok: true,
    identityOwner: owner.address,
    linkDigest: DIGEST,
    bodyAddress: BODY,
    signature,
    observedAtBlock: 7_777,
    gasLimit: GAS_LIMIT,
  });
  expect(chain.estimateCreate).toHaveBeenCalledOnce();
  expect(chain.estimateCreate).toHaveBeenCalledWith(link, signature);
  expect(chain.hasCode).not.toHaveBeenCalled();
});

test("the shape and the backend's own rules answer without a single chain call", async () => {
  const signature = await sign();
  const cases: [string, LegalBodyLink, Hex, typeof expected, string][] = [
    ["a negative agentId", { ...link, agentId: -1n }, signature, expected, "malformed_link"],
    [
      "a guardian that is not an address",
      { ...link, guardian: "0x1234" as Address },
      signature,
      expected,
      "malformed_link",
    ],
    ["a signature with half a byte", link, "0xabc" as Hex, expected, "malformed_link"],
    [
      "a bad signature shape and a wrong tenant",
      link,
      "0xabc" as Hex,
      { ...expected, tenant: WALLET },
      "malformed_link",
    ],
    ["another tenant", link, signature, { ...expected, tenant: WALLET }, "guardian_mismatch"],
    [
      "another agreement",
      link,
      signature,
      { ...expected, operatingAgreementHash: `0x${"cd".repeat(32)}` as Hex },
      "agreement_mismatch",
    ],
    [
      "another tenant and another agreement",
      link,
      signature,
      { ...expected, tenant: WALLET, operatingAgreementHash: `0x${"cd".repeat(32)}` as Hex },
      "guardian_mismatch",
    ],
    ["another delay", link, signature, { ...expected, amendmentDelay: 259_200n }, "delay_mismatch"],
  ];
  for (const [what, l, sig, exp, code] of cases) {
    const chain = fakeChain();
    const check = await checkLink(chain, { link: l, signature: sig, expected: exp });
    expect(check, what).toStrictEqual({ ok: false, code });
    expect(chainCalls(chain), what).toBe(0);
  }
});

test("the agreement hash is compared whatever its letter case", async () => {
  const upper = `0x${"AB".repeat(32)}` as Hex;
  const upperExpected = await checkLink(fakeChain(), {
    link,
    signature: await sign(),
    expected: { ...expected, operatingAgreementHash: upper },
  });
  expect(upperExpected.ok).toBe(true);

  const upperLink = { ...link, operatingAgreementHash: upper };
  const upperSigned = await checkLink(fakeChain(), {
    link: upperLink,
    signature: await sign(owner, upperLink),
    expected,
  });
  expect(upperSigned.ok).toBe(true);
});

test("a guardian that is the tenant in another letter case is accepted", async () => {
  const lower = TENANT.toLowerCase() as Address;
  expect(lower).not.toBe(TENANT);

  const lowerLink = { ...link, guardian: lower };
  const lowerGuardian = await checkLink(fakeChain(), {
    link: lowerLink,
    signature: await sign(owner, lowerLink),
    expected,
  });
  expect(lowerGuardian.ok).toBe(true);

  const lowerTenant = await checkLink(fakeChain(), {
    link,
    signature: await sign(),
    expected: { ...expected, tenant: lower },
  });
  expect(lowerTenant.ok).toBe(true);
});

test("the deadline is judged against the head's time: 299 s left, 24 h + 1 s and already past are refused", async () => {
  for (const [what, deadline] of [
    ["299 s left", HEAD.timestamp + 299n],
    ["24 h + 1 s ahead", HEAD.timestamp + 86_401n],
    ["already past", HEAD.timestamp - 1n],
  ] as const) {
    const chain = fakeChain();
    const l = { ...link, deadline };
    const check = await checkLink(chain, { link: l, signature: await sign(owner, l), expected });
    expect(check, what).toStrictEqual({ ok: false, code: "deadline_out_of_window" });
    expect(chain.head, what).toHaveBeenCalledOnce();
    expect(chain.identityOwner, what).not.toHaveBeenCalled();
  }
  for (const [what, deadline] of [
    ["300 s left", HEAD.timestamp + 300n],
    ["exactly 24 h ahead", HEAD.timestamp + 86_400n],
  ] as const) {
    const l = { ...link, deadline };
    const check = await checkLink(fakeChain(), {
      link: l,
      signature: await sign(owner, l),
      expected,
    });
    expect(check.ok, what).toBe(true);
  }
});

test("an identity that does not exist is refused before the factory is asked anything", async () => {
  const chain = fakeChain();
  chain.identityOwner.mockResolvedValue(undefined);
  const check = await checkLink(chain, { link, signature: await sign(), expected });
  expect(check).toStrictEqual({ ok: false, code: "identity_not_found" });
  expect(chain.linkDigest).not.toHaveBeenCalled();
  expect(chain.estimateCreate).not.toHaveBeenCalled();
});

test("a factory digest that differs from the one computed here throws, before any verdict on the signature", async () => {
  const chain = fakeChain();
  chain.linkDigest.mockResolvedValue(`0x${"00".repeat(32)}`);
  // Were the check to go on, the simulation would answer a signature verdict.
  chain.estimateCreate.mockRejectedValue(badSignature());
  await expect(checkLink(chain, { link, signature: await sign(), expected })).rejects.toThrow(
    /digest/,
  );
  expect(chain.predictLegalBody).not.toHaveBeenCalled();
  expect(chain.bodyCreator).not.toHaveBeenCalled();
  expect(chain.estimateCreate).not.toHaveBeenCalled();
  expect(chain.hasCode).not.toHaveBeenCalled();
});

test("the factory's digest in upper-case hex is the same digest", async () => {
  const chain = fakeChain();
  chain.linkDigest.mockResolvedValue(`0x${DIGEST.slice(2).toUpperCase()}`);
  const check = await checkLink(chain, { link, signature: await sign(), expected });
  expect(check.ok).toBe(true);
});

test("a body that already exists carries who it was created for, and the simulation is not called", async () => {
  const chain = fakeChain();
  chain.bodyCreator.mockResolvedValue(stranger.address);
  const check = await checkLink(chain, { link, signature: await sign(), expected });
  expect(check).toStrictEqual({
    ok: false,
    code: "already_created",
    identityOwner: owner.address,
    linkDigest: DIGEST,
    bodyAddress: BODY,
    createdFor: stranger.address,
  });
  expect(chain.predictLegalBody).toHaveBeenCalledWith(DIGEST, HEAD.number);
  expect(chain.bodyCreator).toHaveBeenCalledWith(BODY, HEAD.number);
  expect(chain.estimateCreate).not.toHaveBeenCalled();
});

test("the true owner's signature with v as 0 or 1 is accepted, and the 27/28 form is simulated and returned", async () => {
  const chain = fakeChain();
  const signature = await sign();
  const recoveryBitForm = withRecoveryBit(signature);
  expect(recoveryBitForm).not.toBe(signature);
  const check = await checkLink(chain, { link, signature: recoveryBitForm, expected });
  expect(check).toMatchObject({ ok: true, signature });
  expect(chain.estimateCreate).toHaveBeenCalledWith(link, signature);
});

test("a signature from another key is simulated, and the contract's BadSignature answers bad_signature", async () => {
  const chain = fakeChain();
  chain.estimateCreate.mockRejectedValue(badSignature());
  const signature = await sign(stranger);
  const check = await checkLink(chain, { link, signature, expected });
  expect(check).toStrictEqual({
    ok: false,
    code: "bad_signature",
    identityOwner: owner.address,
    linkDigest: DIGEST,
    bodyAddress: BODY,
  });
  expect(chain.estimateCreate).toHaveBeenCalledOnce();
  expect(chain.estimateCreate).toHaveBeenCalledWith(link, signature);
});

test("an owner reported with no code and a 100-byte signature the simulation accepts is accepted, without reading its code", async () => {
  // A node one block behind can report no code for a smart account deployed a moment ago. The
  // contract, asked through the simulation, is the judge; that read is not.
  const chain = fakeChain();
  chain.identityOwner.mockResolvedValue(WALLET);
  chain.hasCode.mockResolvedValue(false);
  const check = await checkLink(chain, { link, signature: WALLET_SIGNATURE, expected });
  expect(check).toStrictEqual({
    ok: true,
    identityOwner: WALLET,
    linkDigest: DIGEST,
    bodyAddress: BODY,
    signature: WALLET_SIGNATURE,
    observedAtBlock: 7_777,
    gasLimit: GAS_LIMIT,
  });
  expect(chain.estimateCreate).toHaveBeenCalledWith(link, WALLET_SIGNATURE);
  expect(chain.hasCode).not.toHaveBeenCalled();
});

test("after a BadSignature, an ERC-6492 wrapped signature is an unsupported signer, named without reading any code", async () => {
  const chain = fakeChain();
  chain.identityOwner.mockResolvedValue(WALLET);
  chain.estimateCreate.mockRejectedValue(badSignature());
  const wrapped = serializeErc6492Signature({
    address: "0x000000000000000000000000000000000000dEaD",
    data: "0xdeadbeef",
    signature: await sign(),
  });
  const check = await checkLink(chain, { link, signature: wrapped, expected });
  expect(check).toStrictEqual({
    ok: false,
    code: "unsupported_signer",
    identityOwner: WALLET,
    linkDigest: DIGEST,
    bodyAddress: BODY,
  });
  expect(chain.estimateCreate).toHaveBeenCalledWith(link, wrapped);
  expect(chain.hasCode).not.toHaveBeenCalled();
});

test("after a BadSignature, an owner with no code and a signature neither 64 nor 65 bytes long is an unsupported signer", async () => {
  for (const [what, signature] of [
    ["100 bytes", WALLET_SIGNATURE],
    ["empty", "0x"],
  ] as const) {
    const chain = fakeChain();
    chain.identityOwner.mockResolvedValue(WALLET);
    chain.hasCode.mockResolvedValue(false);
    chain.estimateCreate.mockRejectedValue(badSignature());
    const check = await checkLink(chain, { link, signature, expected });
    expect(check, what).toStrictEqual({
      ok: false,
      code: "unsupported_signer",
      identityOwner: WALLET,
      linkDigest: DIGEST,
      bodyAddress: BODY,
    });
    expect(chain.hasCode, what).toHaveBeenCalledWith(WALLET, HEAD.number);
  }
});

test("after a BadSignature, an owner with code is a bad signature, and so is a compact signature from a wrong key", async () => {
  const withCode = fakeChain();
  withCode.identityOwner.mockResolvedValue(WALLET);
  withCode.hasCode.mockResolvedValue(true);
  withCode.estimateCreate.mockRejectedValue(badSignature());
  const check = await checkLink(withCode, { link, signature: WALLET_SIGNATURE, expected });
  expect(check).toStrictEqual({
    ok: false,
    code: "bad_signature",
    identityOwner: WALLET,
    linkDigest: DIGEST,
    bodyAddress: BODY,
  });
  expect(withCode.hasCode).toHaveBeenCalledWith(WALLET, HEAD.number);

  const noCode = fakeChain();
  noCode.estimateCreate.mockRejectedValue(badSignature());
  const wrongKeyCompact = compact(await sign(stranger));
  const compactCheck = await checkLink(noCode, { link, signature: wrongKeyCompact, expected });
  expect(compactCheck).toStrictEqual({
    ok: false,
    code: "bad_signature",
    identityOwner: owner.address,
    linkDigest: DIGEST,
    bodyAddress: BODY,
  });
  expect(noCode.estimateCreate).toHaveBeenCalledWith(link, wrongKeyCompact);
});

test("test_checkLink_rpcFailureThrows: a port method that could not answer makes checkLink throw", async () => {
  const failures = [
    () =>
      new HttpRequestError({
        url: "https://rpc.example.com",
        status: 503,
        details: "service unavailable",
        body: { method: "eth_call" },
      }),
    () => new InternalRpcError(new Error("internal error")),
  ];
  for (const method of CHAIN_METHODS) {
    for (const failure of failures) {
      const chain = fakeChain();
      // The route that reaches every method, `hasCode` included: a contract owner whose own
      // signature encoding the simulation refuses.
      chain.identityOwner.mockResolvedValue(WALLET);
      chain.estimateCreate.mockRejectedValue(badSignature());
      const err = failure();
      chain[method].mockRejectedValue(err);
      await expect(
        checkLink(chain, { link, signature: WALLET_SIGNATURE, expected }),
        method,
      ).rejects.toBe(err);
    }
  }
});

test("test_checkLink_platformFaultThrows: a fault in the platform's setup throws and is never create_would_revert", async () => {
  const chain = fakeChain();
  const fault = new LegalBodyChainFaultError("NotAuthorized", {
    cause: new ContractRevertError("createLegalBody reverted: NotAuthorized()", "NotAuthorized"),
  });
  chain.estimateCreate.mockRejectedValue(fault);
  await expect(checkLink(chain, { link, signature: await sign(), expected })).rejects.toBe(fault);
  expect(chain.hasCode).not.toHaveBeenCalled();
});

test("the simulation's refusals are mapped by name, and gas_too_high carries the estimate", async () => {
  const signature = await sign();
  const known = { identityOwner: owner.address, linkDigest: DIGEST, bodyAddress: BODY };
  const cases: [Error, object][] = [
    [
      new ContractRevertError("reverted: LegalBodyExists()", "LegalBodyExists"),
      { ok: false, code: "already_created", ...known },
    ],
    [
      new ContractRevertError("reverted: BadDeadline()", "BadDeadline"),
      { ok: false, code: "deadline_out_of_window", ...known },
    ],
    [
      new ContractRevertError("reverted: BadGuardian()", "BadGuardian"),
      { ok: false, code: "create_would_revert", ...known, errorName: "BadGuardian" },
    ],
    [
      new ContractRevertError("reverted: BadDelay()", "BadDelay"),
      { ok: false, code: "create_would_revert", ...known, errorName: "BadDelay" },
    ],
    [
      new ContractRevertError("reverted with undecodable data", ""),
      { ok: false, code: "create_would_revert", ...known },
    ],
    [
      new ContractRevertError("reverted with no data", undefined),
      { ok: false, code: "create_would_revert", ...known },
    ],
    [
      new LegalBodyGasTooHighError(500_000n),
      { ok: false, code: "gas_too_high", ...known, gasEstimate: 500_000n },
    ],
  ];
  for (const [err, want] of cases) {
    const chain = fakeChain();
    chain.estimateCreate.mockRejectedValue(err);
    await expect(
      checkLink(chain, { link, signature, expected }),
      err.message,
    ).resolves.toStrictEqual(want);
    expect(chain.hasCode, err.message).not.toHaveBeenCalled();
  }
});

test("every chain read after head() is pinned to the head's block number", async () => {
  const chain = fakeChain();
  chain.identityOwner.mockResolvedValue(WALLET);
  chain.estimateCreate.mockRejectedValue(badSignature());
  await checkLink(chain, { link, signature: WALLET_SIGNATURE, expected });
  expect(chain.head).toHaveBeenCalledOnce();
  expect(chain.identityOwner.mock.calls).toStrictEqual([[link.agentId, HEAD.number]]);
  expect(chain.linkDigest.mock.calls).toStrictEqual([[link, HEAD.number]]);
  expect(chain.predictLegalBody.mock.calls).toStrictEqual([[DIGEST, HEAD.number]]);
  expect(chain.bodyCreator.mock.calls).toStrictEqual([[BODY, HEAD.number]]);
  expect(chain.hasCode.mock.calls).toStrictEqual([[WALLET, HEAD.number]]);
});
