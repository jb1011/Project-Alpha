import { describe, expect, test, vi } from "vitest";
import { deterministicIdempotencyKey } from "../../../src/adapters/circle/circleExec";
import { withCircleRateLimit } from "../../../src/adapters/circle/circleRateLimit";
import type { CircleWalletsApi } from "../../../src/adapters/circle/circleWallets";
import {
  activateCircleSca,
  circleAgentkitSigner,
  circleTypedDataSigner,
  provisionCircleWallets,
  withCircleOpsLog,
} from "../../../src/adapters/circle/circleWallets";

/** Narrow mock of the DevC SDK surface we use — call-recorded, anti-vacuous per house rule. */
function mockApi() {
  const calls: { createWallets: unknown[]; signTypedData: unknown[]; signMessage: unknown[] } = {
    createWallets: [],
    signTypedData: [],
    signMessage: [],
  };
  let walletCounter = 0;
  return {
    calls,
    api: {
      createWallets: vi.fn(async (input: unknown) => {
        calls.createWallets.push(input);
        walletCounter++;
        const i = input as { accountType: string };
        return {
          data: {
            wallets: [
              {
                id: `w-${walletCounter}`,
                address: `0x${String(walletCounter).padStart(40, "0")}`,
                blockchain: "ARC-TESTNET",
                accountType: i.accountType,
                scaCore: i.accountType === "SCA" ? "circle_6900_singleowner_v2" : undefined,
              },
            ],
          },
        };
      }),
      signTypedData: vi.fn(async (input: unknown) => {
        calls.signTypedData.push(input);
        return { data: { signature: `0x${"ab".repeat(65)}` } };
      }),
      signMessage: vi.fn(async (input: unknown) => {
        calls.signMessage.push(input);
        return { data: { signature: `0x${"cd".repeat(65)}` } };
      }),
    },
  };
}

describe("provisionCircleWallets — one SCA operator + one EOA pocket per agent", () => {
  test("creates both on ARC-TESTNET in the platform wallet set, tagged with the entity key", async () => {
    const { api, calls } = mockApi();
    const out = await provisionCircleWallets(api as never, {
      walletSetId: "ws-1",
      blockchain: "ARC-TESTNET",
      entityKey: "t:agent1",
    });
    expect(out.operator.address).toMatch(/^0x/);
    expect(out.pocket.address).toMatch(/^0x/);
    expect(out.operator.walletId).toBe("w-1");
    expect(out.pocket.walletId).toBe("w-2");
    expect(out.operator.scaCore).toBe("circle_6900_singleowner_v2");
    const wallets = calls.createWallets as {
      accountType: string;
      blockchains: string[];
      walletSetId: string;
      metadata?: { name?: string; refId?: string }[];
    }[];
    const scaCall = wallets[0]!;
    const eoaCall = wallets[1]!;
    expect(scaCall.accountType).toBe("SCA");
    expect(eoaCall.accountType).toBe("EOA");
    for (const c of [scaCall, eoaCall]) {
      expect(c.blockchains).toEqual(["ARC-TESTNET"]);
      expect(c.walletSetId).toBe("ws-1");
      expect(c.metadata?.[0]?.refId).toBe("t:agent1");
    }
  });

  test("a response missing the wallet is a loud error, never a half-provisioned agent", async () => {
    const { api } = mockApi();
    (api.createWallets as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { wallets: [] },
    });
    await expect(
      provisionCircleWallets(api as never, {
        walletSetId: "ws-1",
        blockchain: "ARC-TESTNET",
        entityKey: "t:x",
      }),
    ).rejects.toThrow(/wallet/i);
  });
});

describe("circleTypedDataSigner — drops into the existing signX402/BatchEvmSigner seam", () => {
  test("serializes the typed-data object to the SDK's JSON `data` string and returns the signature", async () => {
    const { api, calls } = mockApi();
    const signer = circleTypedDataSigner(api as never, { walletId: "w-9", address: "0xAbC" });
    const typed = {
      domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002 },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: "0xAbC" },
    };
    const sig = await signer.signTypedData(typed as never);
    expect(sig).toBe(`0x${"ab".repeat(65)}`);
    expect(signer.address).toBe("0xAbC");
    const sent = calls.signTypedData[0] as { walletId: string; data: string };
    expect(sent.walletId).toBe("w-9");
    const parsed = JSON.parse(sent.data);
    expect(parsed.domain.name).toBe("GatewayWalletBatched");
    expect(parsed.primaryType).toBe("TransferWithAuthorization");
  });

  test("a missing signature in the response throws rather than returning undefined", async () => {
    const { api } = mockApi();
    (api.signTypedData as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });
    const signer = circleTypedDataSigner(api as never, { walletId: "w-9", address: "0xAbC" });
    await expect(signer.signTypedData({} as never)).rejects.toThrow(/signature/i);
  });
});

describe("circleAgentkitSigner — the World human-backing proof seam", () => {
  test("eip191 shape with Circle signMessage underneath", async () => {
    const { api, calls } = mockApi();
    const s = circleAgentkitSigner(api as never, { walletId: "w-3", address: "0xDeF" }, 5042002);
    expect(s.type).toBe("eip191");
    expect(s.chainId).toBe("eip155:5042002");
    expect(await s.signMessage("hello world")).toBe(`0x${"cd".repeat(65)}`);
    expect((calls.signMessage[0] as { message: string }).message).toBe("hello world");
  });
});

describe("withCircleOpsLog — every mutating Circle call leaves a journald line (S5 parity)", () => {
  test("wraps mutating methods with an opslog line carrying method + walletId", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { api } = mockApi();
    const wrapped = withCircleOpsLog(api as never);
    await wrapped.signTypedData({ walletId: "w-7", data: "{}" } as never);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("circle_call"));
    expect(line).toBeTruthy();
    expect(line).toContain("signTypedData");
    expect(line).toContain("w-7");
    spy.mockRestore();
  });

  test("logging failure never blocks the call (observe, don't gate)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("logger down");
    });
    const { api } = mockApi();
    const wrapped = withCircleOpsLog(api as never);
    const res = await wrapped.signMessage({ walletId: "w", message: "m" } as never);
    expect((res as { data?: { signature?: string } }).data?.signature).toBeTruthy();
    spy.mockRestore();
  });
});

describe("activateCircleSca — P2 probe-A fix (deploy the SCA before any signature)", () => {
  const USDC = "0x3600000000000000000000000000000000000000";
  const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

  function makeExecApi(states: string[] = ["CONFIRMED"]) {
    let call = 0;
    const submits: { idempotencyKey: string; contractAddress: string; callData: string }[] = [];
    return {
      submits,
      createContractExecutionTransaction: vi.fn(
        async (input: { idempotencyKey: string; contractAddress: string; callData: string }) => {
          submits.push(input);
          return { data: { id: `tx-${submits.length}` } };
        },
      ),
      getTransaction: vi.fn(async ({ id }: { id: string }) => ({
        data: {
          transaction: {
            id,
            state: states[Math.min(call++, states.length - 1)]!,
            txHash: `0xhash-${id}`,
            networkFee: "0.009188",
          },
        },
      })),
    };
  }

  test("submits ONE sponsored approve(gateway, 0) with a DETERMINISTIC per-entity key, records the fee", async () => {
    const api = makeExecApi();
    const fees: [bigint, string | null][] = [];
    const { txHash } = await activateCircleSca(api, {
      operatorWalletId: "op-1",
      entityKey: "t:agent-1",
      usdc: USDC,
      gatewayWallet: GATEWAY,
      confirm: { pollDelayMs: 0, timeoutMs: 5_000, sleep: async () => {} },
      outflows: { record: (_p, amt, ref) => fees.push([amt, ref]) },
    });
    expect(txHash).toBe("0xhash-tx-1");
    expect(api.submits).toHaveLength(1);
    // approve(GATEWAY, 0) calldata against the USDC contract
    expect(api.submits[0]!.contractAddress).toBe(USDC);
    expect(api.submits[0]!.callData.startsWith("0x095ea7b3")).toBe(true); // approve selector
    expect(api.submits[0]!.callData.endsWith("0".repeat(64))).toBe(true); // amount 0
    // Deterministic seed keyed to the WALLET (P3 catch): a crash-retry replays THIS op, while a
    // re-provisioned FRESH wallet derives a fresh key instead of replaying the orphan's deploy.
    expect(api.submits[0]!.idempotencyKey).toBe(deterministicIdempotencyKey("activate:op-1"));
    // S5 parity: the sponsored fee is observed (0.009188 USDC → 9188 atomic).
    expect(fees).toEqual([[9188n, "tx-1"]]);
  });

  test("a terminal FAILED activation propagates (provisioning must not persist a half-activated agent)", async () => {
    const api = makeExecApi(["FAILED"]);
    await expect(
      activateCircleSca(api, {
        operatorWalletId: "op-1",
        entityKey: "t:agent-1",
        usdc: USDC,
        gatewayWallet: GATEWAY,
        confirm: { pollDelayMs: 0, timeoutMs: 5_000, sleep: async () => {} },
      }),
    ).rejects.toThrow(/terminal state FAILED/);
  });
});

describe("wrapper prototype-safety — P3 leg-1 regression", () => {
  /** The REAL SDK client is a class instance: methods live on the PROTOTYPE. A `{...api}` spread
   *  silently drops them — which is exactly how production lost getTransaction while every
   *  plain-object test fake passed. This fake reproduces the real shape. */
  class ProtoApi {
    calls: string[] = [];
    async createWallets(_i: unknown) {
      this.calls.push("createWallets");
      return { data: { wallets: [] } };
    }
    async signTypedData(_i: unknown) {
      this.calls.push("signTypedData");
      return { data: { signature: "0xsig" } };
    }
    async signMessage(_i: unknown) {
      this.calls.push("signMessage");
      return { data: { signature: "0xsig" } };
    }
    async createContractExecutionTransaction(_i: unknown) {
      this.calls.push("exec");
      return { data: { id: "tx-1" } };
    }
    async getTransaction(_i: unknown) {
      this.calls.push("getTransaction");
      return { data: { transaction: { id: "tx-1", state: "CONFIRMED", txHash: "0xh" } } };
    }
  }

  test("withCircleOpsLog preserves prototype methods it does not wrap (getTransaction)", async () => {
    const proto = new ProtoApi();
    const api = withCircleOpsLog(proto as unknown as CircleWalletsApi);
    expect(typeof api.getTransaction).toBe("function"); // the P3 crash was this being undefined
    await api.getTransaction({ id: "tx-1" });
    await api.createWallets({} as never);
    expect(proto.calls).toEqual(["getTransaction", "createWallets"]);
  });

  test("withCircleRateLimit preserves prototype methods and still limits the listed ones", async () => {
    const proto = new ProtoApi();
    const api = withCircleRateLimit(proto as unknown as CircleWalletsApi, {
      minIntervalMs: 0,
      sleep: async () => {},
    });
    expect(typeof api.getTransaction).toBe("function");
    await api.getTransaction({ id: "tx-1" });
    await api.signMessage({ walletId: "w", message: "m" });
    expect(proto.calls).toEqual(["getTransaction", "signMessage"]);
  });
});
