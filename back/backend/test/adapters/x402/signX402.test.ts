import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
// backend/test/adapters/x402/signX402.test.ts
import { evm } from "x402/types";
import { arcBatchingConfig, pocketSignerFromKey } from "../../../src/adapters/x402/pocket";
import { decodeX402Header, makeSignX402 } from "../../../src/adapters/x402/signX402";

const KEY = `0x${"2".repeat(64)}` as const;
const pocket = privateKeyToAccount(KEY);
const payee = getAddress(`0x${"ab".repeat(20)}`);

test("signs a batching authorization that recovers to the pocket, and the header round-trips", async () => {
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });

  const signed = await signX402({
    payTo: payee,
    amount: 1n,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    maxTimeoutSeconds: 60,
  });

  // recovery: the GatewayWalletBatched authorization recovers to the pocket address
  const recovered = await verifyTypedData({
    address: pocket.address,
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: 5042002,
      verifyingContract: arcBatchingConfig.verifyingContract,
    },
    types: evm.authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(signed.authorization.from),
      to: getAddress(signed.authorization.to),
      value: BigInt(signed.authorization.value),
      validAfter: BigInt(signed.authorization.validAfter),
      validBefore: BigInt(signed.authorization.validBefore),
      nonce: signed.authorization.nonce,
    },
    signature: signed.signature,
  });
  expect(recovered).toBe(true);

  // header round-trips to the same payload
  const decoded = decodeX402Header(signed.header);
  expect(decoded.payload.signature).toBe(signed.signature);
  expect(decoded.network).toBe(arcBatchingConfig.network);
  expect(signed.ledgerRef).toBe(signed.authorization.nonce);
});

test("throws when the configured network does not match chainId", () => {
  expect(() =>
    makeSignX402({
      signer: pocketSignerFromKey(KEY),
      chainId: 1,
      network: arcBatchingConfig.network,
      verifyingContract: arcBatchingConfig.verifyingContract,
    }),
  ).toThrow(/config mismatch/);
});
