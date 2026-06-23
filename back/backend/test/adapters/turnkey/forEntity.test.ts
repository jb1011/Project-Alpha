import { expect, test, vi } from "vitest";

// Mock @turnkey/viem.createAccount + @turnkey/sdk-server so no network is hit.
vi.mock("@turnkey/viem", () => ({
  createAccount: vi.fn(async (args: { organizationId: string; signWith: string }) => ({
    address: args.signWith,
    signTypedData: vi.fn(),
    signMessage: vi.fn(),
  })),
}));
vi.mock("@turnkey/sdk-server", () => ({
  Turnkey: class {
    apiClient() {
      return {};
    }
  },
}));

test("forEntity builds a signer scoped to the agent's sub-org + operator", async () => {
  const { createAccount } = await import("@turnkey/viem");
  const { TurnkeySigner } = await import("../../../src/adapters/turnkey/turnkeySigner");
  const cfg = {
    turnkey: {
      baseUrl: "https://api.turnkey.com",
      organizationId: "org",
      apiPublicKey: "p",
      apiPrivateKey: "s",
      delegatedApiPublicKey: "dp",
      delegatedApiPrivateKey: "ds",
    },
  } as never;
  const signer = await TurnkeySigner.forEntity(cfg, {
    subOrgId: "suborg-1",
    operator: "0x00000000000000000000000000000000000000ab",
  });
  expect(signer.address.toLowerCase()).toBe("0x00000000000000000000000000000000000000ab");
  const firstCall = (createAccount as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(firstCall).toBeDefined();
  expect(firstCall![0]).toMatchObject({
    organizationId: "suborg-1",
    signWith: "0x00000000000000000000000000000000000000ab",
  });
});
