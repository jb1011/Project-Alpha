// backend/test/payments/settle.test.ts
import { expect, test, vi } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { type Facilitator, settleWith } from "../../src/payments/settle";

const KEY = `0x${"2".repeat(64)}` as const;
const payTo = "0x00000000000000000000000000000000000000ab" as const;

async function header(amount: bigint) {
  const s = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  return (
    await s({
      payTo,
      amount,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      maxTimeoutSeconds: 600,
    })
  ).header;
}

test("settleWith enriches the payload with resource + accepted and reports the transfer id", async () => {
  const fac: Facilitator = {
    settle: vi.fn(async () => ({ success: true, transaction: "tid-1" })),
  } as never;
  const reqs = {
    scheme: "exact",
    network: arcBatchingConfig.network,
    asset: arcBatchingConfig.asset,
    amount: "50",
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: arcBatchingConfig.verifyingContract,
    },
    resourceUrl: "https://insight.local/x",
  };
  const res = await settleWith(fac, await header(50n), reqs);
  expect(res).toMatchObject({ ok: true, transferId: "tid-1" });
  const [payloadArg] = (fac.settle as ReturnType<typeof vi.fn>).mock.calls[0]!;
  expect(payloadArg.resource).toMatchObject({ url: "https://insight.local/x" });
  expect(payloadArg.accepted).toMatchObject({ network: arcBatchingConfig.network });
  expect(payloadArg.payload.authorization.to.toLowerCase()).toBe(payTo);
});

test("a facilitator failure is reported, not thrown", async () => {
  const fac: Facilitator = {
    settle: vi.fn(async () => ({ success: false, errorReason: "insufficient_balance" })),
  } as never;
  const reqs = {
    scheme: "exact",
    network: arcBatchingConfig.network,
    asset: arcBatchingConfig.asset,
    amount: "50",
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: arcBatchingConfig.verifyingContract,
    },
    resourceUrl: "x",
  };
  expect(await settleWith(fac, await header(50n), reqs)).toMatchObject({
    ok: false,
    reason: "insufficient_balance",
  });
});

test("a facilitator throw is caught and returned as ok:false, not rethrown", async () => {
  const fac: Facilitator = {
    settle: vi.fn(async () => {
      throw new Error("network down");
    }),
  } as never;
  const reqs = {
    scheme: "exact",
    network: arcBatchingConfig.network,
    asset: arcBatchingConfig.asset,
    amount: "50",
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: arcBatchingConfig.verifyingContract,
    },
    resourceUrl: "x",
  };
  expect(await settleWith(fac, await header(50n), reqs)).toMatchObject({
    ok: false,
    reason: "network down",
  });
});
