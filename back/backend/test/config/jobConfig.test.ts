import { describe, expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

describe("Job config", () => {
  test("job config defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.jobContract).toBe("0x0747EEf0706327138c69792bF28Cd525089e4583");
    expect(cfg.reputationRegistry).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
    expect(cfg.jobClientPrivateKey).toBe(cfg.platformPrivateKey);
    expect(cfg.jobEvaluatorPrivateKey).toBeUndefined();
    expect(cfg.jobSweepToTreasury).toBe(false);
  });

  test("JOB_SWEEP_TO_TREASURY true is honored", () => {
    const cfg = loadConfig({ ...base, JOB_SWEEP_TO_TREASURY: "true" });
    expect(cfg.jobSweepToTreasury).toBe(true);
  });

  test("JOB_SWEEP_TO_TREASURY false is honored", () => {
    const cfg = loadConfig({ ...base, JOB_SWEEP_TO_TREASURY: "false" });
    expect(cfg.jobSweepToTreasury).toBe(false);
  });

  test("JOB_CLIENT_PRIVATE_KEY override is honored", () => {
    const customKey = `0x${"2".repeat(64)}`;
    const cfg = loadConfig({ ...base, JOB_CLIENT_PRIVATE_KEY: customKey });
    expect(cfg.jobClientPrivateKey).toBe(customKey);
  });

  test("JOB_EVALUATOR_PRIVATE_KEY is parsed", () => {
    const evalKey = `0x${"3".repeat(64)}`;
    const cfg = loadConfig({ ...base, JOB_EVALUATOR_PRIVATE_KEY: evalKey });
    expect(cfg.jobEvaluatorPrivateKey).toBe(evalKey);
  });

  test("jobClientPrivateKey is redacted", () => {
    const cfg = loadConfig(base);
    const redacted = redact(cfg);
    expect(redacted.jobClientPrivateKey).toBe("REDACTED");
  });

  test("jobEvaluatorPrivateKey is redacted when present", () => {
    const evalKey = `0x${"3".repeat(64)}`;
    const cfg = loadConfig({ ...base, JOB_EVALUATOR_PRIVATE_KEY: evalKey });
    const redacted = redact(cfg);
    expect(redacted.jobEvaluatorPrivateKey).toBe("REDACTED");
  });

  test("jobEvaluatorPrivateKey is undefined when not set", () => {
    const cfg = loadConfig(base);
    const redacted = redact(cfg);
    expect(redacted.jobEvaluatorPrivateKey).toBeUndefined();
  });

  test("jobContract and reputationRegistry are not redacted", () => {
    const cfg = loadConfig(base);
    const redacted = redact(cfg);
    expect(redacted.jobContract).toBe("0x0747EEf0706327138c69792bF28Cd525089e4583");
    expect(redacted.reputationRegistry).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
  });
});
