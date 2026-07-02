import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("MCP_PUBLIC_URL loads (with a localhost default)", () => {
  expect(loadConfig(base).mcpPublicUrl).toBe("http://localhost:8789/mcp");
  expect(loadConfig({ ...base, MCP_PUBLIC_URL: "https://api.x/mcp" }).mcpPublicUrl).toBe(
    "https://api.x/mcp",
  );
});
