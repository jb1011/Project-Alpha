import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

test("AGENT_MODEL defaults to claude-sonnet-4-6 and facilitator URL to the testnet base", () => {
  const cfg = loadConfig(base);
  expect(cfg.agentModel).toBe("claude-sonnet-4-6");
  expect(cfg.gatewayFacilitatorUrl).toBe("https://gateway-api-testnet.circle.com");
});
test("ANTHROPIC_API_KEY is parsed and redacted", () => {
  const cfg = loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" });
  expect(cfg.anthropicApiKey).toBe("sk-ant-xxx");
  expect(redact(cfg).anthropicApiKey).toBe("REDACTED");
});
test("AGENT_MODEL override is honored", () => {
  expect(loadConfig({ ...base, AGENT_MODEL: "claude-opus-4-8" }).agentModel).toBe(
    "claude-opus-4-8",
  );
});
