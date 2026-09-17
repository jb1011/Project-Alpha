// `submit` reads a transaction's outcome without letting the SDK's throw-on-failure hide it.
// Offline: the transaction response is a fake, and no client is ever executed against.
import {
  AccountId,
  Client,
  PrecheckStatusError,
  ReceiptStatusError,
  Status,
  TransactionId,
} from "@hiero-ledger/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { submit } from "../src/commands/provision.js";

const client = Client.forTestnet();
const txId = TransactionId.generate(AccountId.fromString("0.0.10412145"));

afterAll(() => {
  client.close();
});

/** A `TransactionResponse` stand-in whose receipt does whatever the test needs. */
function response(getReceipt: () => Promise<{ status: { toString(): string } }>) {
  return { transactionId: txId, getReceipt };
}

describe("submit", () => {
  it("returns the status and the transaction id when the receipt succeeds", async () => {
    const result = await submit(
      async () => response(async () => ({ status: Status.Success })),
      client,
    );
    expect(result).toEqual({ status: "SUCCESS", txId: txId.toString() });
  });

  it("returns a consensus failure as a status instead of throwing", async () => {
    // This is the whole point: `getReceipt` raises rather than handing back the status, so
    // `provision`'s dust fallback would be unreachable without this branch.
    const result = await submit(
      async () =>
        response(async () => {
          throw new ReceiptStatusError({
            status: Status.InvalidSignature,
            transactionId: txId,
            // The receipt is stored and never read by this path.
            transactionReceipt: { status: Status.InvalidSignature } as never,
          });
        }),
      client,
    );
    expect(result).toEqual({ status: "INVALID_SIGNATURE", txId: txId.toString() });
  });

  it("returns a precheck refusal as a status, with no transaction id", async () => {
    const result = await submit(async () => {
      throw new PrecheckStatusError({
        status: Status.InvalidSignature,
        transactionId: txId,
        nodeId: AccountId.fromString("0.0.3"),
        contractFunctionResult: null,
      });
    }, client);
    expect(result).toEqual({ status: "INVALID_SIGNATURE", txId: "" });
  });

  it("lets anything that is not a status error through", async () => {
    await expect(
      submit(async () => {
        throw new Error("socket hang up");
      }, client),
    ).rejects.toThrow("socket hang up");
  });
});
