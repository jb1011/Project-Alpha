import { recoverTypedDataAddress } from "viem";
import { expect, test } from "vitest";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";

test("LocalKeySigner exposes its address and signs AgentWalletSet typed data", async () => {
  const signer = new LocalKeySigner(`0x${"2".repeat(64)}`);
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: signer.address,
    owner: "0x0000000000000000000000000000000000000001",
    deadline: 1_900_000_000n,
    chainId: 31337,
    registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  });
  const sig = await signer.signWalletSet(td);
  const recovered = await recoverTypedDataAddress({ ...td, signature: sig });
  expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
});
