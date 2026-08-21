/**
 * doola formation provider config (design §2): the all-or-nothing block, the derived defaults,
 * the ARC_NETWORK mainnet invariants and the redact() rule. The invariant matrix here is the
 * only thing standing between "ARC_NETWORK=mainnet" and a fleet of DEMO-watermarked entities.
 */
import { expect, test } from "vitest";
import {
  ARC_TESTNET_CHAIN_ID,
  DOOLA_BASE_URLS,
  canFormEntities,
  loadConfig,
  redact,
} from "../../src/config/env";
import { CIRCLE_FULL_ENV } from "../helpers/prodEnv";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

const DOOLA = {
  DOOLA_API_KEY: "dk_test_key",
  DOOLA_WEBHOOK_SECRET: "whsec_test",
};

/** Arc mainnet's chain id is not published yet; any non-testnet id exercises the invariant. */
const MAINNET_CHAIN_ID = "8004";

/** A LEGAL mainnet deployment: real network, real chain, real provider environment. Everything
 *  the mainnet invariants demand, so a throw in a mainnet test names the one thing it removed. */
const MAINNET = {
  ARC_NETWORK: "mainnet",
  ARC_CHAIN_ID: MAINNET_CHAIN_ID,
  DOOLA_ENVIRONMENT: "production",
};

// A production-NODE_ENV env that already satisfies the pre-existing prod invariants, so a throw
// in these tests can only come from the formation rules. The circle half comes from the shared
// fixture — one definition of "a full credential set", so tightening a boot invariant does not
// mean hunting pasted copies.
const PROD_BASE = {
  ...BASE,
  NODE_ENV: "production",
  AUTH_JWT_SECRET: "a-real-production-secret-value",
  WEB_ORIGIN: "https://app.example",
  METADATA_BASE_URL: "https://api.example",
  WALLET_PROVIDER_DEFAULT: "circle",
  ...CIRCLE_FULL_ENV,
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
  expect(loadConfig({ ...BASE, ...DOOLA, ...MAINNET }).arcNetwork).toBe("mainnet");
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

test("B1: tri-state booleans accept true|1|yes / false|0|no case-insensitively", () => {
  for (const raw of ["true", "TRUE", "True", "1", "yes", "YES", " true "])
    expect(loadConfig({ ...BASE, FORMATION_REQUIRED: raw }).formation?.required, raw).toBe(true);
  for (const raw of ["false", "FALSE", "False", "0", "no", "NO"])
    expect(
      loadConfig({ ...BASE, ...DOOLA, FORMATION_REQUIRED: raw }).formation?.required,
      raw,
    ).toBe(false);
  // Absent and BLANK both fall back to the derived default (doola configured -> true).
  expect(loadConfig({ ...BASE, ...DOOLA, FORMATION_REQUIRED: "" }).formation?.required).toBe(true);
  expect(loadConfig({ ...BASE, ...DOOLA }).formation?.required).toBe(true);
});

test("B1: a garbage boolean REFUSES to boot instead of quietly meaning false", () => {
  // The old rule ("anything that is not true is false") turned an operator's deliberate opt-in
  // into a deployment that forms nothing, with no signal anywhere.
  expect(() => loadConfig({ ...BASE, FORMATION_REQUIRED: "ture" })).toThrow(
    /FORMATION_REQUIRED must be true\|false \(got "ture"\)/,
  );
  expect(() => loadConfig({ ...BASE, FORMATION_REQUIRED: "on" })).toThrow(/must be true\|false/);
  expect(() => loadConfig({ ...BASE, ...DOOLA, FORMATION_SANDBOX_SYNTHETIC_PII: "maybe" })).toThrow(
    /FORMATION_SANDBOX_SYNTHETIC_PII must be true\|false \(got "maybe"\)/,
  );
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

test("B4: a HALF-configured block names the MISSING HALF, even under FORMATION_REQUIRED", () => {
  // Ordering matters: every formation invariant reads canFormEntities, which is false for a half
  // block exactly as it is for an absent one. If FORMATION_REQUIRED ran first, an operator who
  // set DOOLA_API_KEY and forgot the webhook secret would be told the block is "missing".
  expect(() =>
    loadConfig({ ...PROD_BASE, DOOLA_API_KEY: "dk_test_key", FORMATION_REQUIRED: "true" }),
  ).toThrow(/DOOLA_API_KEY is set but DOOLA_WEBHOOK_SECRET is missing \(all-or-nothing\)/);
  // …and from the other side, including on a mainnet box (where two more invariants queue up).
  expect(() =>
    loadConfig({ ...PROD_BASE, DOOLA_WEBHOOK_SECRET: "whsec_test", ARC_NETWORK: "mainnet" }),
  ).toThrow(/DOOLA_WEBHOOK_SECRET is set but DOOLA_API_KEY is missing \(all-or-nothing\)/);
});

test("mainnet invariant: ARC_NETWORK=mainnet without doola refuses (formation is mandatory)", () => {
  expect(() => loadConfig({ ...PROD_BASE, ARC_NETWORK: "mainnet" })).toThrow(
    /ARC_NETWORK=mainnet requires the doola block/,
  );
});

test("mainnet invariant: ARC_NETWORK=mainnet + DOOLA_ENVIRONMENT=sandbox refuses", () => {
  expect(() =>
    loadConfig({ ...PROD_BASE, ...DOOLA, ...MAINNET, DOOLA_ENVIRONMENT: "sandbox" }),
  ).toThrow(/must not file DEMO-watermarked sandbox entities/);
  expect(() => loadConfig({ ...PROD_BASE, ...DOOLA, ...MAINNET })).not.toThrow();
});

test("B2: mainnet invariant — FORMATION_REQUIRED=false is refused, not honored", () => {
  // The credentials being present is not the same as formation being ON: a mainnet deployment
  // with the switch off would mint real-network entities whose legal body is a stub forever.
  expect(() =>
    loadConfig({ ...PROD_BASE, ...DOOLA, ...MAINNET, FORMATION_REQUIRED: "false" }),
  ).toThrow(/ARC_NETWORK=mainnet with FORMATION_REQUIRED=false/);
  // Explicitly true is fine, and so is leaving it to the derived default.
  expect(() =>
    loadConfig({ ...PROD_BASE, ...DOOLA, ...MAINNET, FORMATION_REQUIRED: "true" }),
  ).not.toThrow();
});

test("B3: ARC_NETWORK and ARC_CHAIN_ID must describe the SAME network, both directions", () => {
  // testnet naming a foreign chain: every manifest binds chainId (§4 domain separation), so this
  // silently anchors against a chain nothing verifies on.
  expect(() => loadConfig({ ...BASE, ARC_CHAIN_ID: "31337" })).toThrow(
    /ARC_NETWORK=testnet with ARC_CHAIN_ID=31337/,
  );
  expect(loadConfig({ ...BASE, ARC_CHAIN_ID: String(ARC_TESTNET_CHAIN_ID) }).chainId).toBe(
    ARC_TESTNET_CHAIN_ID,
  );
  // mainnet still pointing at the TESTNET chain id: real filings, test state.
  expect(() =>
    loadConfig({
      ...PROD_BASE,
      ...DOOLA,
      ...MAINNET,
      ARC_CHAIN_ID: String(ARC_TESTNET_CHAIN_ID),
    }),
  ).toThrow(/that is the Arc TESTNET chain id/);
  // …and the default (no ARC_CHAIN_ID at all) is the testnet id, so it is refused too.
  expect(() =>
    loadConfig({ ...PROD_BASE, ...DOOLA, ARC_NETWORK: "mainnet", DOOLA_ENVIRONMENT: "production" }),
  ).toThrow(/that is the Arc TESTNET chain id/);
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
