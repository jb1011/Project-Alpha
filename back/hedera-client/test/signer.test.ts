// The spike's step 0 (`hedera-signer-spike/src/00-signwith-proof.ts`) as a test, offline.
// The claim: a signer that only ever sees a 32-byte digest produces a Hedera signature
// byte-identical to the one the SDK produces from the PrivateKey object, on the same
// frozen body. That equality is the whole custody boundary (D1).
import { PrivateKey, PublicKey, Transaction } from "@hiero-ledger/sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { custodyAgnosticSigner, localRawSigner } from "../src/signer.js";

// A throwaway test key. Never a real key, never printed.
const TEST_PRIV_HEX = `0x${"11".repeat(32)}`;
const AGENT_ACCOUNT = "0.0.10450558";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  payTo: "0.0.10412694",
  asset: "0.0.429274",
  amount: "1000",
  maxTimeoutSeconds: 60,
  extra: { feePayer: "0.0.7162784" },
};

/** First signature in a transaction's sigmap, as raw bytes. */
function onlySignature(tx: Transaction): Uint8Array {
  const removed = tx.removeAllSignatures();
  const first = [...removed.values()][0];
  if (!first) throw new Error("no signature on the transaction");
  return Array.isArray(first) ? (first[0] as Uint8Array) : first;
}

describe("custodyAgnosticSigner", () => {
  it("signs a transfer the SDK accepts, from a 32-byte digest alone", async () => {
    const { pub, rawSign } = localRawSigner(TEST_PRIV_HEX);
    const signer = custodyAgnosticSigner(AGENT_ACCOUNT, pub, rawSign);

    const base64 = await signer.createPartiallySignedTransferTransaction(requirements);
    const bytes = Buffer.from(base64, "base64");

    // The SDK verifies our signature against the agent's public key.
    const decoded = Transaction.fromBytes(bytes);
    expect(pub.verifyTransaction(decoded)).toBe(true);

    // …and it is the same 64 bytes `tx.sign(PrivateKey)` writes on the identical body.
    const ours = onlySignature(Transaction.fromBytes(bytes));
    const copy = Transaction.fromBytes(bytes);
    copy.removeAllSignatures();
    await copy.sign(PrivateKey.fromStringECDSA(TEST_PRIV_HEX));
    const sdk = onlySignature(copy);

    expect(ours.length).toBe(64);
    expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(sdk).toString("hex"));
  });

  it("reports the payer account id it was built with", () => {
    const { pub, rawSign } = localRawSigner(TEST_PRIV_HEX);
    expect(custodyAgnosticSigner(AGENT_ACCOUNT, pub, rawSign).accountId).toBe(AGENT_ACCOUNT);
  });

  it("refuses requirements with no facilitator fee payer", async () => {
    const { pub, rawSign } = localRawSigner(TEST_PRIV_HEX);
    const signer = custodyAgnosticSigner(AGENT_ACCOUNT, pub, rawSign);
    await expect(
      signer.createPartiallySignedTransferTransaction({ ...requirements, extra: {} }),
    ).rejects.toThrow(/feePayer missing/);
  });

  it("derives the public key the spike's EVM alias flow uses", () => {
    const { pub } = localRawSigner(TEST_PRIV_HEX);
    expect(pub).toBeInstanceOf(PublicKey);
    expect(pub.toStringRaw()).toBe(
      PrivateKey.fromStringECDSA(TEST_PRIV_HEX).publicKey.toStringRaw(),
    );
  });
});
