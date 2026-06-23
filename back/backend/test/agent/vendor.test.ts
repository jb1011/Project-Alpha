import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { DATASETS } from "../../src/agent/datasets";
import { buildVendor } from "../../src/agent/vendor";

const KEY = `0x${"2".repeat(64)}` as const;
const vendorPayout = "0x00000000000000000000000000000000000000cd" as const;
async function pay(amount: bigint, payTo: `0x${string}`) {
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

test("vendor 402s then serves the dataset body on payment", async () => {
  const app = buildVendor({
    payTo: vendorPayout,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
  });
  // biome-ignore lint/complexity/useLiteralKeys: test mirrors brief's verbatim key access
  const ds = DATASETS["sentiment"]!;
  const no = await app.request(`/data/${ds.id}`);
  expect(no.status).toBe(402);
  const ok = await app.request(`/data/${ds.id}`, {
    headers: { "X-PAYMENT": await pay(ds.price, vendorPayout) },
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).body).toMatchObject(ds.body);
});
test("unknown dataset id is 404", async () => {
  const app = buildVendor({
    payTo: vendorPayout,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
  });
  expect((await app.request("/data/nope")).status).toBe(404);
});
