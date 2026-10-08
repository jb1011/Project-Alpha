/**
 * The attestor of the public legal-body statements, published as a text record of the apex name:
 * `com.novicorpus.attestor`, whose value is CAIP-10, `eip155:<chain id>:<EIP-55 address>`, the
 * chain being the deployment's. Empty where no attestor is configured; every other record of the
 * name is what it was. Served by this gateway and signed by its key, like every record of the name.
 *
 * The attestor is anvil's published account 0 and the gateway signs with anvil's account 1; every
 * other address is a placeholder.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  namehash,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { describe, expect, test } from "vitest";
import { answer } from "../../src/api/routes/ensGateway";
import { REGISTRY } from "../helpers/legalBodyFixtures";
import { TEST_ATTESTOR } from "../helpers/legalBodyStatementFixtures";

const KEY = "com.novicorpus.attestor";
/** anvil's published account 1: the gateway's signer here. */
const GATEWAY_SIGNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
/** Placeholders: the resolver that asks, the apex's address and an agent's treasury. */
const RESOLVER = getAddress("0x00000000000000000000000000000000000e0501");
const APEX = getAddress("0x00000000000000000000000000000000000a9e00");
const TREASURY = getAddress("0x0000000000000000000000000000000000000b02");
const ARC_TESTNET = 5_042_002;

/** The gateway's part of the API's dependencies, with an attestor when one is given. */
function gatewayDeps(o: { attestor?: Address; chainId?: number } = {}) {
  return {
    ens: {
      signer: GATEWAY_SIGNER,
      parentName: "novicorpus.eth",
      metadataBaseUrl: "https://api.example.test",
      identityRegistry: REGISTRY,
      chainId: o.chainId ?? ARC_TESTNET,
      ...(o.attestor === undefined ? {} : { attestor: o.attestor }),
    },
    repo: {
      findByPublicId: (id: string) =>
        id === "example"
          ? {
              name: "Example Agent",
              treasury: TREASURY,
              operator: TREASURY,
              proxy: TREASURY,
              agentId: "7001",
              publicId: "example",
            }
          : undefined,
    },
    arc: { legalStatus: async () => 0, treasuryPaused: async () => false },
    ensApexAddress: APEX,
    mcpPublicUrl: "https://api.example.test/mcp",
    webOrigin: "https://www.example.test",
  } as never;
}

const resolveAbi = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "view",
    inputs: [{ type: "bytes" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;
const recordAbi = [
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "string" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

/** What the gateway answers for `name`'s record, the inner call being `inner`. */
async function resolved(deps: never, name: string, inner: `0x${string}`): Promise<`0x${string}`> {
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
  return result;
}

async function text(deps: never, name: string, key: string): Promise<string> {
  const inner = encodeFunctionData({
    abi: recordAbi,
    functionName: "text",
    args: [namehash(name), key],
  });
  return decodeAbiParameters([{ type: "string" }], await resolved(deps, name, inner))[0];
}

async function addr(deps: never, name: string): Promise<Address> {
  const inner = encodeFunctionData({
    abi: recordAbi,
    functionName: "addr",
    args: [namehash(name)],
  });
  return decodeAbiParameters([{ type: "address" }], await resolved(deps, name, inner))[0];
}

describe("the attestor on the apex", () => {
  test("answered in CAIP-10 form: the deployment's chain, then the attestor's EIP-55 address", async () => {
    expect(TEST_ATTESTOR.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    const lowerCase = TEST_ATTESTOR.address.toLowerCase() as Address;
    await expect(text(gatewayDeps({ attestor: lowerCase }), "novicorpus.eth", KEY)).resolves.toBe(
      "eip155:5042002:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
    // The chain is the deployment's, whichever it is.
    await expect(
      text(
        gatewayDeps({ attestor: TEST_ATTESTOR.address, chainId: 31_337 }),
        "novicorpus.eth",
        KEY,
      ),
    ).resolves.toBe("eip155:31337:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  test("no attestor configured: the record is empty", async () => {
    await expect(text(gatewayDeps(), "novicorpus.eth", KEY)).resolves.toBe("");
  });

  test("only the apex carries it: an agent's name answers it empty", async () => {
    const deps = gatewayDeps({ attestor: TEST_ATTESTOR.address });
    await expect(text(deps, "example.novicorpus.eth", KEY)).resolves.toBe("");
    await expect(text(deps, "example.novicorpus.eth", "description")).resolves.toBe(
      "Example Agent — Wyoming DAO LLC governed agent",
    );
  });

  test("every other record of the apex is what it was, with or without an attestor", async () => {
    for (const deps of [gatewayDeps(), gatewayDeps({ attestor: TEST_ATTESTOR.address })]) {
      await expect(text(deps, "novicorpus.eth", "description")).resolves.toBe(
        "Novi Corpus — legal bodies for AI agents",
      );
      await expect(text(deps, "novicorpus.eth", "url")).resolves.toBe("https://api.example.test");
      await expect(text(deps, "novicorpus.eth", "agent-endpoint[web]")).resolves.toBe(
        "https://www.example.test",
      );
      await expect(text(deps, "novicorpus.eth", "com.twitter")).resolves.toBe("");
      await expect(addr(deps, "novicorpus.eth")).resolves.toBe(APEX);
    }
  });
});

test("the composition root publishes the attestation key's address on the apex, never the key", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const at = main.indexOf("const ens = cfg.ens");
  expect(at, "the gateway's dependencies were not found").toBeGreaterThan(0);
  const ens = main.slice(at, main.indexOf(": undefined;", at));
  expect(ens).toMatch(/^ {8}attestor: cfg\.attestation\?\.address,$/m);
  expect(ens).not.toMatch(/attestation\??\.key/);
});
