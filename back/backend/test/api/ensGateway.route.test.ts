import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  namehash,
  recoverAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { describe, expect, test } from "vitest";
import { answer } from "../../src/api/routes/ensGateway";

const signer = privateKeyToAccount(`0x${"a".repeat(64)}` as Hex);
const RESOLVER = "0x50968D0D84fc491c11cedA2999C5eF5Aa1D66473" as Address;
const TREASURY = "0x8ffA18f05056458dbFB2f7A122F185878B2d6e2f" as Address;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const ERC7930 = "0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e";

type ArcMock = {
  legalStatus: () => Promise<number>;
  treasuryPaused: () => Promise<boolean>;
  getAgentMetadata: () => Promise<Hex>;
};
function makeDeps(arc?: Partial<ArcMock>) {
  return {
    ens: {
      signer,
      parentName: "novicorpus.eth",
      metadataBaseUrl: "https://x/backend",
      identityRegistry: REGISTRY,
      chainId: 5042002,
    },
    repo: {
      findByPublicId: (id: string) =>
        id === "abc"
          ? {
              name: "Agent A",
              treasury: TREASURY,
              operator: TREASURY,
              proxy: TREASURY,
              agentId: "845775",
              publicId: "abc",
            }
          : undefined,
    },
    arc: {
      legalStatus: async () => 0,
      treasuryPaused: async () => false,
      getAgentMetadata: async () => toHex("abc.novicorpus.eth"),
      ...arc,
    },
    platformManagerAddress: TREASURY,
    mcpPublicUrl: "https://x/mcp",
    webOrigin: "https://x",
    // biome-ignore lint/suspicious/noExplicitAny: partial mock of ApiDeps for isolated gateway test.
  } as any;
}

const textAbi = [
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "string" }],
    outputs: [{ type: "string" }],
  },
] as const;
const addrAbi = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;
const resolveAbi = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "view",
    inputs: [{ type: "bytes" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;

// biome-ignore lint/suspicious/noExplicitAny: mock deps
async function callText(deps: any, name: string, key: string) {
  const inner = encodeFunctionData({
    abi: textAbi,
    functionName: "text",
    args: [namehash(name), key],
  });
  const outer = encodeFunctionData({
    abi: resolveAbi,
    functionName: "resolve",
    args: [toHex(packetToBytes(name)), inner],
  });
  const { data } = await answer(deps, RESOLVER, outer);
  const [result, expires, sig] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    data,
  );
  const value = decodeAbiParameters([{ type: "string" }], result)[0] as string;
  return { value, result, expires, sig, outer };
}
// biome-ignore lint/suspicious/noExplicitAny: mock deps
async function callAddr(deps: any, name: string) {
  const inner = encodeFunctionData({ abi: addrAbi, functionName: "addr", args: [namehash(name)] });
  const outer = encodeFunctionData({
    abi: resolveAbi,
    functionName: "resolve",
    args: [toHex(packetToBytes(name)), inner],
  });
  const { data } = await answer(deps, RESOLVER, outer);
  const [result] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    data,
  );
  return decodeAbiParameters([{ type: "address" }], result)[0] as Address;
}

describe("ENS gateway answer()", () => {
  test("text url -> metadata url", async () => {
    expect((await callText(makeDeps(), "abc.novicorpus.eth", "url")).value).toBe(
      "https://x/backend/metadata/abc",
    );
  });

  test("text description -> name-based", async () => {
    expect((await callText(makeDeps(), "abc.novicorpus.eth", "description")).value).toBe(
      "Agent A — Wyoming DAO LLC governed agent",
    );
  });

  test("addr -> treasury", async () => {
    expect((await callAddr(makeDeps(), "abc.novicorpus.eth")).toLowerCase()).toBe(
      TREASURY.toLowerCase(),
    );
  });

  test("legal-status Active when on-chain status 0 and not paused", async () => {
    expect((await callText(makeDeps(), "abc.novicorpus.eth", "legal-status")).value).toBe("Active");
  });

  test("legal-status Suspended when treasury paused", async () => {
    const deps = makeDeps({ treasuryPaused: async () => true });
    expect((await callText(deps, "abc.novicorpus.eth", "legal-status")).value).toBe("Suspended");
  });

  test("legal-status Suspended when LegalManager status != 0", async () => {
    const deps = makeDeps({ legalStatus: async () => 1 });
    expect((await callText(deps, "abc.novicorpus.eth", "legal-status")).value).toBe("Suspended");
  });

  test("ENSIP-25 agent-registration match -> 1", async () => {
    const key = `agent-registration[${ERC7930}][845775]`;
    expect((await callText(makeDeps(), "abc.novicorpus.eth", key)).value).toBe("1");
  });

  test("ENSIP-25 wrong agentId -> empty", async () => {
    const key = `agent-registration[${ERC7930}][999999]`;
    expect((await callText(makeDeps(), "abc.novicorpus.eth", key)).value).toBe("");
  });

  test("ENSIP-25 wrong registry -> empty", async () => {
    const key = "agent-registration[0x0001deadbeef][845775]";
    expect((await callText(makeDeps(), "abc.novicorpus.eth", key)).value).toBe("");
  });

  test("unknown label -> empty text", async () => {
    expect((await callText(makeDeps(), "nope.novicorpus.eth", "url")).value).toBe("");
  });

  test("unknown record key -> empty (ENSIP-5)", async () => {
    expect((await callText(makeDeps(), "abc.novicorpus.eth", "com.twitter")).value).toBe("");
  });

  test("apex description", async () => {
    expect((await callText(makeDeps(), "novicorpus.eth", "description")).value).toBe(
      "Novi Corpus — legal bodies for AI agents",
    );
  });

  test("response signature recovers to the gateway signer", async () => {
    const { result, expires, sig, outer } = await callText(makeDeps(), "abc.novicorpus.eth", "url");
    const digest = keccak256(
      encodePacked(
        ["bytes2", "address", "uint64", "bytes32", "bytes32"],
        ["0x1900", RESOLVER, expires as bigint, keccak256(outer), keccak256(result)],
      ),
    );
    const recovered = await recoverAddress({ hash: digest, signature: sig });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  test("vanity label alias resolves to the aliased agent", async () => {
    const deps = makeDeps();
    deps.ens.labelAliases = { demo: "abc" };
    // Unaliased, "demo" is not a publicId and resolves to nothing.
    expect((await callText(makeDeps(), "demo.novicorpus.eth", "description")).value).toBe("");
    expect((await callText(deps, "demo.novicorpus.eth", "description")).value).toBe(
      "Agent A — Wyoming DAO LLC governed agent",
    );
  });

  test("aliased label's metadata url points at the real publicId, not the alias", async () => {
    const deps = makeDeps();
    deps.ens.labelAliases = { demo: "abc" };
    expect((await callText(deps, "demo.novicorpus.eth", "url")).value).toBe(
      "https://x/backend/metadata/abc",
    );
  });

  test("bad calldata selector -> throws", async () => {
    await expect(answer(makeDeps(), RESOLVER, "0xdeadbeef")).rejects.toThrow();
  });
});
