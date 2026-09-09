import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type TransferAuthorization,
  type TransferAuthorizationDomain,
  verifyTransferAuthorization,
} from "../../src/payments/transferAuthorization";
import type { Address, Hex } from "../../src/types";

/**
 * The ONE EIP-3009 verifier both rails call (design 2026-08-26 §6.3).
 *
 * These are the checks that stand between a stranger's POST and the platform EOA broadcasting a
 * transfer on someone else's behalf, so each is asserted on its own rather than through a route.
 */

const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const stranger = privateKeyToAccount(`0x${"8".repeat(64)}`);
const REVENUE = "0x000000000000000000000000000000000000beef" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;

const domain: TransferAuthorizationDomain = {
  name: "USDC",
  version: "2",
  chainId: 5042002,
  verifyingContract: USDC,
};

const NOW_MS = 1_800_000_000_000;
const nowSec = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

function authorization(over: Partial<TransferAuthorization> = {}): TransferAuthorization {
  return {
    from: guardian.address as Address,
    to: REVENUE,
    value: "399000000",
    validAfter: "0",
    validBefore: String(nowSec + 1800),
    nonce: `0x${"a1".repeat(32)}` as Hex,
    ...over,
  };
}

async function sign(
  a: TransferAuthorization,
  signer = guardian,
  d: TransferAuthorizationDomain = domain,
): Promise<Hex> {
  return (await signer.signTypedData({
    domain: {
      name: d.name,
      version: d.version,
      chainId: d.chainId,
      verifyingContract: d.verifyingContract,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  })) as Hex;
}

describe("verifyTransferAuthorization", () => {
  test("accepts a genuine authorization in exact mode and returns its nonce", async () => {
    const a = authorization();
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a),
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: true, nonce: a.nonce });
  });

  test("refuses a recipient that is not the one the caller expected", async () => {
    // The signature is genuine — the signer simply chose a different payee. The recipient is
    // OURS to decide, never the signer's, or a valid signature pays somebody else.
    const a = authorization({ to: "0x00000000000000000000000000000000000000ff" as Address });
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a),
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "wrong recipient" });
  });

  test("exact mode refuses BOTH directions — under and over the quote", async () => {
    for (const value of ["398999999", "399000001"]) {
      const a = authorization({ value });
      const r = await verifyTransferAuthorization({
        authorization: a,
        signature: await sign(a),
        domain,
        payTo: REVENUE,
        value: 399_000_000n,
        mode: "exact",
        now,
      });
      expect(r).toEqual({ ok: false, reason: "wrong amount" });
    }
  });

  test("floor mode keeps the x402 rule: over-payment passes, under-payment is `underpriced`", async () => {
    const over = authorization({ value: "500000000" });
    expect(
      await verifyTransferAuthorization({
        authorization: over,
        signature: await sign(over),
        domain,
        payTo: REVENUE,
        value: 399_000_000n,
        mode: "floor",
        now,
      }),
    ).toEqual({ ok: true, nonce: over.nonce });

    const under = authorization({ value: "1" });
    expect(
      await verifyTransferAuthorization({
        authorization: under,
        signature: await sign(under),
        domain,
        payTo: REVENUE,
        value: 399_000_000n,
        mode: "floor",
        now,
      }),
    ).toEqual({ ok: false, reason: "underpriced" });
  });

  test("refuses an authorization that is not yet valid", async () => {
    const a = authorization({ validAfter: String(nowSec + 60) });
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a),
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  test("refuses an expired authorization, and treats validBefore == now as expired", async () => {
    for (const validBefore of [String(nowSec - 1), String(nowSec)]) {
      const a = authorization({ validBefore });
      const r = await verifyTransferAuthorization({
        authorization: a,
        signature: await sign(a),
        domain,
        payTo: REVENUE,
        value: 399_000_000n,
        mode: "exact",
        now,
      });
      expect(r).toEqual({ ok: false, reason: "expired" });
    }
  });

  test("refuses a signature by anyone but `from`", async () => {
    const a = authorization();
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a, stranger),
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("refuses a signature given under a DIFFERENT domain — the domain is the whole point", async () => {
    // A signature for the Gateway batching domain must not settle a token transfer, and vice
    // versa: same message, different domain separator, different meaning.
    const a = authorization();
    const elsewhere = { ...domain, name: "Circle Gateway", version: "1" };
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a, guardian, elsewhere),
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("refuses a malformed signature without throwing", async () => {
    const a = authorization();
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: "0xdeadbeef" as Hex,
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("refuses a malformed address without throwing", async () => {
    const a = authorization({ from: "not-an-address" as Address });
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: `0x${"11".repeat(65)}` as Hex,
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "malformed-address" });
  });

  test("comparison is checksum-insensitive: the same address in two casings is one address", async () => {
    // The wire carries whatever casing a client produced. Comparing the strings would refuse a
    // correct payment for a cosmetic difference, so both sides are normalised.
    const a = authorization({ to: getAddress(REVENUE) as Address });
    const r = await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a),
      domain,
      payTo: REVENUE, // all-lowercase
      value: 399_000_000n,
      mode: "exact",
      now,
    });
    expect(r.ok).toBe(true);
  });
});

// ── ERC-1271: verifying the way the TOKEN verifies (B1 gate A6) ────────────────────────────
//
// The token checks EIP-3009 signatures with an ECDSA recovery AND, failing that, an on-chain
// `isValidSignature` call. An offline-only check therefore refuses signatures the token would
// accept — every smart-account guardian, which on Arc is most of them — and tells the guardian
// their own wallet is wrong.

const SMART_ACCOUNT = "0x000000000000000000000000000000000000C0DE" as Address;

/** A client that answers like a node: ERC-1271 for the contract account, code where there is
 *  code. `verifyTypedData` on a real client already does the ECDSA half itself. */
function clientAcceptingContractSignature(opts: { accepts: boolean; hasCode?: boolean }) {
  return {
    verifyTypedData: async ({ address }: { address: string }) =>
      address.toLowerCase() === SMART_ACCOUNT.toLowerCase() ? opts.accepts : false,
    getCode: async () => ((opts.hasCode ?? true) ? "0x60006000" : undefined),
    // biome-ignore lint/suspicious/noExplicitAny: a two-method stub of viem's PublicClient
  } as any;
}

test("a SMART ACCOUNT's signature is accepted through the client, as the token would", async () => {
  const a = authorization({ from: SMART_ACCOUNT });
  const verdict = await verifyTransferAuthorization({
    authorization: a,
    // Not 65 bytes: a contract account's signature is whatever its own validator understands.
    signature: `0x${"cd".repeat(100)}` as Hex,
    domain,
    payTo: REVENUE,
    value: 399_000_000n,
    mode: "exact",
    client: clientAcceptingContractSignature({ accepts: true }),
    now,
  });
  expect(verdict).toMatchObject({ ok: true });
});

test("a smart account whose validator says NO is a bad signature, not an unsupported one", async () => {
  // There IS code, so the question was asked and answered. Blaming our own gap here would hide a
  // genuinely invalid signature behind a shrug.
  const verdict = await verifyTransferAuthorization({
    authorization: authorization({ from: SMART_ACCOUNT }),
    signature: `0x${"cd".repeat(100)}` as Hex,
    domain,
    payTo: REVENUE,
    value: 399_000_000n,
    mode: "exact",
    client: clientAcceptingContractSignature({ accepts: false }),
    now,
  });
  expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
});

test("⚠ a non-ECDSA signature from an account with NO CODE is `unsupported-signer`", async () => {
  // Nothing could have checked this: it is not 65 bytes, and there is no contract to ask. Calling
  // it `bad-signature` would tell a guardian their wallet produced a wrong signature, when what
  // happened is that we cannot verify this KIND of signature — an undeployed smart account, or an
  // ERC-6492 wrapper we could not unwrap. Those are different sentences and only one is true.
  const verdict = await verifyTransferAuthorization({
    authorization: authorization({ from: SMART_ACCOUNT }),
    signature: `0x${"cd".repeat(100)}` as Hex,
    domain,
    payTo: REVENUE,
    value: 399_000_000n,
    mode: "exact",
    client: clientAcceptingContractSignature({ accepts: false, hasCode: false }),
    now,
  });
  expect(verdict).toEqual({ ok: false, reason: "unsupported-signer" });
});

test("with no client, a malformed signature keeps its old answer — the x402 rail is untouched", async () => {
  // The `unsupported-signer` claim needs a client to make it: without one we cannot know whether
  // the signer has code, and guessing would change a refusal this rail has always given.
  expect(
    await verifyTransferAuthorization({
      authorization: authorization(),
      signature: "0xdeadbeef" as Hex,
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    }),
  ).toEqual({ ok: false, reason: "bad-signature" });
});

test("a WRONG 65-byte signature stays `bad-signature` — the ordinary EOA mistake", async () => {
  const a = authorization();
  const verdict = await verifyTransferAuthorization({
    authorization: a,
    signature: await sign(a, stranger),
    domain,
    payTo: REVENUE,
    value: 399_000_000n,
    mode: "exact",
    now,
  });
  expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
});

test("with NO client the offline path is unchanged — the x402 rail keeps what it had", async () => {
  const a = authorization();
  expect(
    await verifyTransferAuthorization({
      authorization: a,
      signature: await sign(a),
      domain,
      payTo: REVENUE,
      value: 399_000_000n,
      mode: "exact",
      now,
    }),
  ).toMatchObject({ ok: true });
});
