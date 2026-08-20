/**
 * doola formation provider config (design §2): the all-or-nothing block, the derived defaults,
 * the ARC_NETWORK mainnet invariants and the redact() rule. The invariant matrix here is the
 * only thing standing between "ARC_NETWORK=mainnet" and a fleet of DEMO-watermarked entities.
 */
import { expect, test } from "vitest";
import { DOOLA_BASE_URLS, canFormEntities, loadConfig, redact } from "../../src/config/env";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

const DOOLA = {
  DOOLA_API_KEY: "dk_test_key",
  DOOLA_WEBHOOK_SECRET: "whsec_test",
};

// A production-NODE_ENV env that already satisfies the pre-existing prod invariants, so a throw
// in these tests can only come from the formation rules.
const PROD_BASE = {
  ...BASE,
  NODE_ENV: "production",
  AUTH_JWT_SECRET: "a-real-production-secret-value",
  WEB_ORIGIN: "https://app.example",
  METADATA_BASE_URL: "https://api.example",
  WALLET_PROVIDER_DEFAULT: "circle",
  CIRCLE_API_KEY: "ck_test",
  CIRCLE_ENTITY_SECRET: "es_test",
  CIRCLE_WALLET_SET_ID: "ws_test",
};

test("doola block is all-or-nothing: only one of key/webhook-secret set -> boot refuses", () => {
  expect(() => loadConfig({ ...BASE, DOOLA_API_KEY: "dk_test_key" })).toThrow(
    /DOOLA_WEBHOOK_SECRET/,
  );
  expect(() => loadConfig({ ...BASE, DOOLA_WEBHOOK_SECRET: "whsec_test" })).toThrow(
    /DOOLA_API_KEY/,
  );
});

test("both set -> cfg.doola present; neither -> absent (feature off, no error)", () => {
  const on = loadConfig({ ...BASE, ...DOOLA });
  expect(on.doola).toEqual({
    apiKey: "dk_test_key",
    webhookSecret: "whsec_test",
    webhookSecretPrevious: undefined,
    environment: "sandbox",
    baseUrl: DOOLA_BASE_URLS.sandbox,
  });
  expect(loadConfig(BASE).doola).toBeUndefined();
});

test("canFormEntities is exactly 'the doola block is present' (drift guard)", () => {
  expect(canFormEntities(loadConfig({ ...BASE, ...DOOLA }))).toBe(true);
  expect(canFormEntities(loadConfig(BASE))).toBe(false);
});

test("base URL derives from the environment; DOOLA_BASE_URL overrides it", () => {
  expect(loadConfig({ ...BASE, ...DOOLA }).doola?.baseUrl).toBe("https://api.test.doola.com");
  expect(loadConfig({ ...BASE, ...DOOLA, DOOLA_ENVIRONMENT: "production" }).doola?.baseUrl).toBe(
    "https://api.doola.com",
  );
  expect(
    loadConfig({ ...BASE, ...DOOLA, DOOLA_BASE_URL: "https://replay.local/doola" }).doola?.baseUrl,
  ).toBe("https://replay.local/doola");
});

test("the rotation secret rides along only when set", () => {
  const cfg = loadConfig({ ...BASE, ...DOOLA, DOOLA_WEBHOOK_SECRET_PREVIOUS: "whsec_old" });
  expect(cfg.doola?.webhookSecretPrevious).toBe("whsec_old");
});

test("ARC_NETWORK defaults to testnet and parses mainnet", () => {
  expect(loadConfig(BASE).arcNetwork).toBe("testnet");
  expect(
    loadConfig({ ...BASE, ...DOOLA, DOOLA_ENVIRONMENT: "production", ARC_NETWORK: "mainnet" })
      .arcNetwork,
  ).toBe("mainnet");
  expect(() => loadConfig({ ...BASE, ARC_NETWORK: "devnet" })).toThrow(/ARC_NETWORK/);
});

test("FORMATION_REQUIRED defaults TRUE when doola is configured, FALSE when it is not", () => {
  expect(loadConfig({ ...BASE, ...DOOLA }).formation?.required).toBe(true);
  expect(loadConfig(BASE).formation?.required).toBe(false);
  // Explicit false is honored (a provider-configured deployment that wants opt-in formation).
  expect(loadConfig({ ...BASE, ...DOOLA, FORMATION_REQUIRED: "false" }).formation?.required).toBe(
    false,
  );
  expect(loadConfig({ ...BASE, FORMATION_REQUIRED: "true" }).formation?.required).toBe(true);
});

test("the formation knobs carry their documented defaults and honor overrides", () => {
  const d = loadConfig(BASE).formation!;
  expect(d.sweepMs).toBe(60_000);
  expect(d.maxPerTenant).toBe(3);
  expect(d.dailyCeiling).toBe(10);
  const over = loadConfig({
    ...BASE,
    FORMATION_SWEEP_MS: "5000",
    FORMATION_MAX_PER_TENANT: "1",
    FORMATION_DAILY_CEILING: "2",
  }).formation!;
  expect([over.sweepMs, over.maxPerTenant, over.dailyCeiling]).toEqual([5000, 1, 2]);
});

test("synthetic sandbox PII defaults TRUE in sandbox, FALSE in production, overridable", () => {
  expect(loadConfig({ ...BASE, ...DOOLA }).formation?.sandboxSyntheticPii).toBe(true);
  expect(
    loadConfig({ ...BASE, ...DOOLA, DOOLA_ENVIRONMENT: "production" }).formation
      ?.sandboxSyntheticPii,
  ).toBe(false);
  expect(
    loadConfig({ ...BASE, ...DOOLA, FORMATION_SANDBOX_SYNTHETIC_PII: "false" }).formation
      ?.sandboxSyntheticPii,
  ).toBe(false);
});

test("prod invariant: FORMATION_REQUIRED without the doola block refuses to boot", () => {
  expect(() => loadConfig({ ...PROD_BASE, FORMATION_REQUIRED: "true" })).toThrow(
    /FORMATION_REQUIRED is set but the doola block is missing/,
  );
  // …and the same deployment WITH the block boots.
  expect(() => loadConfig({ ...PROD_BASE, ...DOOLA, FORMATION_REQUIRED: "true" })).not.toThrow();
});

test("mainnet invariant: ARC_NETWORK=mainnet without doola refuses (formation is mandatory)", () => {
  expect(() => loadConfig({ ...PROD_BASE, ARC_NETWORK: "mainnet" })).toThrow(
    /ARC_NETWORK=mainnet requires the doola block/,
  );
});

test("mainnet invariant: ARC_NETWORK=mainnet + DOOLA_ENVIRONMENT=sandbox refuses", () => {
  expect(() => loadConfig({ ...PROD_BASE, ...DOOLA, ARC_NETWORK: "mainnet" })).toThrow(
    /must not file DEMO-watermarked sandbox entities/,
  );
  expect(() =>
    loadConfig({ ...PROD_BASE, ...DOOLA, ARC_NETWORK: "mainnet", DOOLA_ENVIRONMENT: "production" }),
  ).not.toThrow();
});

test("the mainnet invariants are keyed on ARC_NETWORK, NOT on NODE_ENV", () => {
  // The testnet box runs NODE_ENV=production against doola SANDBOX by design, so NODE_ENV cannot
  // be the signal in either direction: prod+sandbox is legal…
  expect(() => loadConfig({ ...PROD_BASE, ...DOOLA })).not.toThrow();
  // …and a NON-production box that names mainnet is still refused.
  expect(() => loadConfig({ ...BASE, ...DOOLA, ARC_NETWORK: "mainnet" })).toThrow(
    /must not file DEMO-watermarked sandbox entities/,
  );
  expect(() => loadConfig({ ...BASE, ARC_NETWORK: "mainnet" })).toThrow(
    /ARC_NETWORK=mainnet requires the doola block/,
  );
});

test("neither doola secret EVER survives redact() — env.ts's own header rule", () => {
  const cfg = loadConfig({
    ...BASE,
    DOOLA_API_KEY: "dk_test_SUPER_SECRET",
    DOOLA_WEBHOOK_SECRET: "whsec_SUPER_SECRET",
    DOOLA_WEBHOOK_SECRET_PREVIOUS: "whsec_OLD_SECRET",
  });
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain("dk_test_SUPER_SECRET");
  expect(printed).not.toContain("whsec_SUPER_SECRET");
  expect(printed).not.toContain("whsec_OLD_SECRET");
  // The non-secret half stays visible — redaction must not blind the boot log.
  expect(printed).toContain("api.test.doola.com");
});
