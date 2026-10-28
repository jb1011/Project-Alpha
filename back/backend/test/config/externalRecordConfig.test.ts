/**
 * The external track record's config (design 2026-10-23, section 4.4): `cfg.externalRecord`,
 * present only when its six settings are all set, refused half-set, refused on mainnet, with the
 * explorer API and the start block defaulted.
 *
 * Every key here is a placeholder, never a real wallet.
 */
import { describe, expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};

const RECORD = {
  EXTERNAL_RECORD_POSTER: "0xbbf3f7a2ede8e1fc7b380e7c536666043fcda5e7",
  EXTERNAL_RECORD_TAG1: "accuracy",
  EXTERNAL_RECORD_TAG2: "aevum-market-call",
  EXTERNAL_RECORD_API_BASE: "https://app.aevumprotocol.io",
  EXTERNAL_RECORD_METADATA_KEY: "aevum:lockingWallet",
  EXTERNAL_RECORD_PROVIDER_NAME: "Aevum",
};

/** A mainnet deployment that boots, as `attestationConfig.test.ts` builds it. */
const MAINNET = {
  ...BASE,
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
  ARC_NETWORK: "mainnet",
  ARC_CHAIN_ID: "8004",
  WORLD_APP_ID: "app_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
  WORLD_REQUIRE_GUARDIAN: "true",
  WORLD_MAX_COMPANIES_PER_HUMAN: "3",
  DOOLA_ENVIRONMENT: "production",
  DOOLA_API_KEY: "dk_live_key",
  DOOLA_WEBHOOK_SECRET: "whsec_live",
  FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function thrownBy(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}

describe("cfg.externalRecord", () => {
  test("absent when nothing is set", () => {
    expect(loadConfig(BASE).externalRecord).toBeUndefined();
  });

  test("the whole block: checksummed poster, defaults for the explorer and the start block", () => {
    expect(loadConfig({ ...BASE, ...RECORD }).externalRecord).toEqual({
      poster: "0xBBf3f7a2ede8e1fc7B380e7C536666043fCDa5e7",
      tag1: "accuracy",
      tag2: "aevum-market-call",
      apiBase: "https://app.aevumprotocol.io",
      metadataKey: "aevum:lockingWallet",
      providerName: "Aevum",
      explorerApi: "https://explorer.testnet.arc.io/api",
      fromBlock: 0,
    });
  });

  test("reads the explorer API and the start block when set", () => {
    const cfg = loadConfig({
      ...BASE,
      ...RECORD,
      EXTERNAL_RECORD_EXPLORER_API: "https://explorer.example/api",
      EXTERNAL_RECORD_FROM_BLOCK: "68300000",
    });
    expect(cfg.externalRecord).toMatchObject({
      explorerApi: "https://explorer.example/api",
      fromBlock: 68_300_000,
    });
  });

  test("a blank line reads as unset", () => {
    expect(loadConfig({ ...BASE, EXTERNAL_RECORD_POSTER: "  " }).externalRecord).toBeUndefined();
  });

  test("half a block is refused, naming what is missing", () => {
    const { EXTERNAL_RECORD_PROVIDER_NAME: _name, ...rest } = RECORD;
    expect(thrownBy(() => loadConfig({ ...BASE, ...rest }))).toBe(
      "Invalid config: EXTERNAL_RECORD_POSTER and EXTERNAL_RECORD_TAG1 and EXTERNAL_RECORD_TAG2 and EXTERNAL_RECORD_API_BASE and EXTERNAL_RECORD_METADATA_KEY are set but EXTERNAL_RECORD_PROVIDER_NAME is missing (all-or-nothing)",
    );
  });

  test.each([
    ["http", "http://app.aevumprotocol.io"],
    ["a path", "https://app.aevumprotocol.io/api"],
    ["a port", "https://app.aevumprotocol.io:8443"],
    ["a query", "https://app.aevumprotocol.io/?x=1"],
  ])("refuses an API base with %s", (_label, base) => {
    expect(
      thrownBy(() => loadConfig({ ...BASE, ...RECORD, EXTERNAL_RECORD_API_BASE: base })),
    ).toMatch(/EXTERNAL_RECORD_API_BASE/);
  });

  test("refuses a poster that is not an address", () => {
    expect(
      thrownBy(() => loadConfig({ ...BASE, ...RECORD, EXTERNAL_RECORD_POSTER: "0x1234" })),
    ).toMatch(/EXTERNAL_RECORD_POSTER/);
  });

  test("refuses an http explorer", () => {
    expect(
      thrownBy(() =>
        loadConfig({
          ...BASE,
          ...RECORD,
          EXTERNAL_RECORD_EXPLORER_API: "http://explorer.example/api",
        }),
      ),
    ).toMatch(/EXTERNAL_RECORD_EXPLORER_API/);
  });

  test("a mainnet box without the block boots", () => {
    expect(loadConfig(MAINNET).externalRecord).toBeUndefined();
  });

  test("the block is refused on mainnet", () => {
    expect(thrownBy(() => loadConfig({ ...MAINNET, ...RECORD }))).toBe(
      "Invalid config: the EXTERNAL_RECORD_* block is testnet only (ARC_NETWORK=mainnet): the track-record card is labelled Arc testnet",
    );
  });

  test("redact prints the block as is: nothing in it is secret, and it serialises", () => {
    const out = redact(loadConfig({ ...BASE, ...RECORD }));
    expect(out.externalRecord).toMatchObject({
      poster: "0xBBf3f7a2ede8e1fc7B380e7C536666043fCDa5e7",
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
