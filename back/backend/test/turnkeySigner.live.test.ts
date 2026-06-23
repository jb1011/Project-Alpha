import "dotenv/config"; // load backend/.env (TURNKEY_*) for the live smoke
import { recoverTypedDataAddress } from "viem";
import { describe, expect, test } from "vitest";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { TurnkeySigner } from "../src/adapters/turnkey/turnkeySigner";

// Opt-in: needs real Turnkey creds. Run with TURNKEY_* set in backend/.env, then:
//   npx vitest run test/turnkeySigner.live.test.ts
const RUN = !!process.env.TURNKEY_API_PRIVATE_KEY && !!process.env.TURNKEY_SIGN_WITH;

describe.skipIf(!RUN)("Turnkey live smoke", () => {
  test("a Turnkey enclave key signs AgentWalletSet and recovers to itself", async () => {
    const signer = await TurnkeySigner.forKey(
      {
        apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY ?? "",
        apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY ?? "",
        organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
        baseUrl: process.env.TURNKEY_BASE_URL ?? "https://api.turnkey.com",
      },
      process.env.TURNKEY_SIGN_WITH ?? "",
    );
    const td = buildWalletSetTypedData({
      agentId: 0n,
      newWallet: signer.address,
      owner: "0x0000000000000000000000000000000000000001",
      deadline: 1_900_000_000n,
      chainId: 5042002,
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    });
    const sig = await signer.signWalletSet(td);
    expect((await recoverTypedDataAddress({ ...td, signature: sig })).toLowerCase()).toBe(
      signer.address.toLowerCase(),
    );
  }, 30_000);
});
