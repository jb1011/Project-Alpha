import { hashTypedData, recoverTypedDataAddress, serializeTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";

const operator = privateKeyToAccount(`0x${"2".repeat(64)}`);

const td = buildWalletSetTypedData({
  agentId: 0n,
  newWallet: operator.address,
  owner: "0x0000000000000000000000000000000000000001",
  deadline: 1_900_000_000n,
  chainId: 31337,
  registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
});

test("typed data matches the AgentWalletSet typehash field order", () => {
  expect(td.primaryType).toBe("AgentWalletSet");
  expect(td.domain).toMatchObject({
    name: "ERC8004IdentityRegistry",
    version: "1",
    chainId: 31337,
  });
  expect(td.types.AgentWalletSet?.map((f) => f.name)).toEqual([
    "agentId",
    "newWallet",
    "owner",
    "deadline",
  ]);
});

test("a signature from newWallet recovers back to newWallet (ECDSA path the contract uses)", async () => {
  const sig = await operator.signTypedData(td);
  const recovered = await recoverTypedDataAddress({ ...td, signature: sig });
  expect(recovered.toLowerCase()).toBe(operator.address.toLowerCase());
});

// Regression: viem's hashTypedData auto-injects EIP712Domain, but serializeTypedData drops the
// domain to {} unless EIP712Domain is declared in `types`. Remote signers (e.g. @turnkey/viem) hash
// serializeTypedData() server-side, so a missing EIP712Domain makes them sign an EMPTY-domain digest
// and the on-chain bind reverts "invalid wallet sig". Guard the serialize path here (no creds needed).
test("serializeTypedData preserves the domain (the path remote/enclave signers hash)", () => {
  const serialized = JSON.parse(serializeTypedData(td));
  expect(serialized.domain).toMatchObject({
    name: "ERC8004IdentityRegistry",
    version: "1",
    chainId: 31337,
    verifyingContract: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  });
  // a serialize-then-hash signer must arrive at the SAME digest as the canonical hashTypedData
  expect(hashTypedData(serialized)).toBe(hashTypedData(td));
});
