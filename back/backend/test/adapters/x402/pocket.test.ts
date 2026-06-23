// backend/test/adapters/x402/pocket.test.ts
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { pocketSignerFromKey } from "../../../src/adapters/x402/pocket";

const KEY = `0x${"2".repeat(64)}` as const;

test("pocketSignerFromKey exposes the pocket address and signs typed data", async () => {
  const signer = pocketSignerFromKey(KEY);
  expect(signer.address).toBe(privateKeyToAccount(KEY).address);

  const sig = await signer.signTypedData({
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: 5042002,
      verifyingContract: `0x${"00".repeat(20)}`,
    },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: signer.address },
  });
  expect(sig).toMatch(/^0x[0-9a-f]+$/);
});
