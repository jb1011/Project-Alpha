import { expect, test } from "vitest";
import { buildRequirements } from "../../src/payments/seller";

test("builds a 402 requirements body paying the treasury payout in atomic USDC", () => {
  const reqs = buildRequirements({
    price: 50n,
    payTo: "0x00000000000000000000000000000000000000ab",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
  });
  expect(reqs.accepts).toHaveLength(1);
  const accept = reqs.accepts[0];
  expect(accept).toBeDefined();
  expect(accept).toMatchObject({
    payTo: "0x00000000000000000000000000000000000000ab",
    maxAmountRequired: "50",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
  });
  expect(accept!.maxTimeoutSeconds).toBeGreaterThan(0);
});
