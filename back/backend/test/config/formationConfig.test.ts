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

/**
 * THE IDENTITY FLOOR (2026-08-26 §6.7): production formation refuses to boot without a WIRED
 * World ID block. It is spelled out as a fixture rather than folded into DOOLA because the tests
 * below prove BOTH halves — that a production box with it boots, and that one without it does not.
 *
 * The invariant asserts the wired dependency, never the env strings, because that is exactly
 * where the hole was: `assertGuardianAllowed` silently returns when `cfg.world` is undefined.
 */
const WORLD = {
  WORLD_APP_ID: "app_staging_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
  WORLD_REQUIRE_GUARDIAN: "true",
  WORLD_MAX_COMPANIES_PER_HUMAN: "3",
};

/**
 * THE PII FLOOR (2026-08-26 §4.2): production formation is the only deployment that collects an
 * SSN, and it refuses to boot without a key to encrypt one with. Its own fixture, beside WORLD,
 * for the same reason: the tests below prove both halves.
 */
const PII = { FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64") };

/** A production doola environment, with the identity and PII floors satisfied. */
const DOOLA_PROD = { ...DOOLA, ...WORLD, ...PII, DOOLA_ENVIRONMENT: "production" };

/** Arc mainnet's chain id is not published yet; any non-testnet id exercises the invariant. */
const MAINNET_CHAIN_ID = "8004";

/** A LEGAL mainnet deployment: real network, real chain, real provider environment. Everything
 *  the mainnet invariants demand, so a throw in a mainnet test names the one thing it removed. */
const MAINNET = {
  ARC_NETWORK: "mainnet",
  ARC_CHAIN_ID: MAINNET_CHAIN_ID,
  DOOLA_ENVIRONMENT: "production",
  ...WORLD,
  ...PII,
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
  expect(loadConfig({ ...BASE, ...DOOLA_PROD }).doola?.baseUrl).toBe("https://api.doola.com");
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
  expect(loadConfig({ ...BASE, ...DOOLA_PROD }).formation?.sandboxSyntheticPii).toBe(false);
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
  expect(() => loadConfig({ ...PROD_BASE, ...DOOLA_PROD, ARC_NETWORK: "mainnet" })).toThrow(
    /that is the Arc TESTNET chain id/,
  );
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

// ── THE IDENTITY FLOOR (2026-08-26 §6.7) ────────────────────────────────────────────────────
//
// Production formation without proof-of-personhood is anonymous USDC buying real Wyoming LLCs.
// Every case below is the SAME deployment minus one piece of the wiring, because the failure this
// guards against is precisely a partial one: `assertGuardianAllowed` SILENTLY RETURNS when
// `cfg.world` is undefined, so a box could set WORLD_REQUIRE_GUARDIAN=true, pass every string
// check an operator would think to make, and gate nothing at all.

test("identity floor: production formation boots with the World block WIRED", () => {
  const cfg = loadConfig({ ...BASE, ...DOOLA_PROD });
  expect(cfg.world?.requireGuardian).toBe(true);
  expect(cfg.world?.maxCompaniesPerHuman).toBe(3);
});

test("identity floor: production formation REFUSES when any WORLD_* credential is missing", () => {
  for (const missing of ["WORLD_APP_ID", "WORLD_RP_ID", "WORLD_RP_SIGNING_KEY"] as const) {
    const env: Record<string, string | undefined> = { ...BASE, ...DOOLA_PROD };
    env[missing] = undefined;
    // The wired dependency, not the env string: two of the three present is still a no-op gate.
    expect(() => loadConfig(env), missing).toThrow(/requires the World ID block/);
  }
});

test("identity floor: production formation REFUSES with the gate configured but OFF", () => {
  expect(() => loadConfig({ ...BASE, ...DOOLA_PROD, WORLD_REQUIRE_GUARDIAN: "false" })).toThrow(
    /the guardian must be a verified unique human/,
  );
});

test("identity floor: production formation REFUSES an unbounded per-human company count", () => {
  const env: Record<string, string | undefined> = { ...BASE, ...DOOLA_PROD };
  env.WORLD_MAX_COMPANIES_PER_HUMAN = undefined;
  expect(() => loadConfig(env)).toThrow(/requires WORLD_MAX_COMPANIES_PER_HUMAN/);
});

test("identity floor: a SANDBOX deployment is unaffected — the floor is about real filings", () => {
  expect(() => loadConfig({ ...BASE, ...DOOLA })).not.toThrow();
  expect(loadConfig({ ...BASE, ...DOOLA }).world).toBeUndefined();
});

test("a synthetic sandbox identity can never file a REAL company", () => {
  // The shortcut exists so real personal data never reaches a playground. Used the other way
  // round it would file a real Wyoming LLC naming a person who does not exist (§7).
  expect(() =>
    loadConfig({ ...BASE, ...DOOLA_PROD, FORMATION_SANDBOX_SYNTHETIC_PII: "true" }),
  ).toThrow(/would file a REAL Wyoming LLC for a person who does not exist/);
});

// ── THE PII FLOOR (2026-08-26 §4.2) ─────────────────────────────────────────────────────────
//
// Production formation collects the responsible party's SSN on the same request that mints the
// company. Without a key the door could only refuse every such create or store one in plaintext,
// and both are worse than refusing to boot.

test("PII floor: production formation boots with a key, and PARSES it into a keyring", () => {
  const cfg = loadConfig({ ...BASE, ...DOOLA_PROD });
  expect(cfg.formation?.pii?.current.id).toMatch(/^fpk1:[0-9a-f]{16}$/);
  expect(cfg.formation?.pii?.previous).toBeUndefined();
  // PARSED at boot, so a malformed key names its variable here rather than throwing at the first
  // filing — which is the only moment the key is otherwise used.
  expect(cfg.formation?.pii?.current.key).toHaveLength(32);
});

test("PII floor: production formation REFUSES with no FORMATION_PII_KEY", () => {
  const env: Record<string, string | undefined> = { ...BASE, ...DOOLA_PROD };
  env.FORMATION_PII_KEY = undefined;
  expect(() => loadConfig(env)).toThrow(/requires FORMATION_PII_KEY/);
});

test("a malformed key fails at BOOT with the variable named, never at the first filing", () => {
  for (const bad of ["", "   ", Buffer.alloc(31).toString("base64"), "nope"])
    expect(() => loadConfig({ ...BASE, ...DOOLA_PROD, FORMATION_PII_KEY: bad }), bad).toThrow(
      /FORMATION_PII_KEY/,
    );
  // Hex is accepted too — an operator reaching for `openssl rand` gets one of the two forms.
  expect(() =>
    loadConfig({ ...BASE, ...DOOLA_PROD, FORMATION_PII_KEY: Buffer.alloc(32, 3).toString("hex") }),
  ).not.toThrow();
});

test("_PREVIOUS alone is refused, and so is a 'rotation' to the same key", () => {
  // Both shapes are SILENT otherwise: the first leaves every row keyed to a key this box does not
  // have, the second is a rotation somebody believes they have done.
  expect(() =>
    loadConfig({
      ...BASE,
      ...DOOLA,
      FORMATION_PII_KEY_PREVIOUS: Buffer.alloc(32).toString("base64"),
    }),
  ).toThrow(/FORMATION_PII_KEY_PREVIOUS is set but FORMATION_PII_KEY is missing/);
  expect(() =>
    loadConfig({
      ...BASE,
      ...DOOLA_PROD,
      FORMATION_PII_KEY_PREVIOUS: DOOLA_PROD.FORMATION_PII_KEY,
    }),
  ).toThrow(/are the SAME key — that is not a rotation/);
  // A real rotation boots, with two distinct ids.
  const rotated = loadConfig({
    ...BASE,
    ...DOOLA_PROD,
    FORMATION_PII_KEY_PREVIOUS: Buffer.alloc(32, 9).toString("base64"),
  });
  expect(rotated.formation?.pii?.previous?.id).not.toBe(rotated.formation?.pii?.current.id);
});

test("a SANDBOX deployment must not carry a PII key — it has nothing to encrypt", () => {
  // §4.1: the door refuses the SSN field outright on a sandbox box. A key there is at best dead
  // weight and at worst a production key pasted into a sandbox `.env`.
  expect(() =>
    loadConfig({ ...BASE, ...DOOLA, FORMATION_PII_KEY: Buffer.alloc(32, 5).toString("base64") }),
  ).toThrow(/FORMATION_PII_KEY is set with DOOLA_ENVIRONMENT=sandbox/);
  // …and a box with NO doola block at all is unaffected: it forms nothing either way.
  expect(() =>
    loadConfig({ ...BASE, FORMATION_PII_KEY: Buffer.alloc(32, 5).toString("base64") }),
  ).not.toThrow();
});

test("the PII key NEVER survives redact() — a Buffer stringifies to its bytes", () => {
  // The boot log prints the config. `JSON.stringify(Buffer)` is `{"type":"Buffer","data":[...]}`,
  // so an un-redacted keyring puts the key material in journald verbatim.
  const key = Buffer.alloc(32, 0x2a);
  const cfg = loadConfig({
    ...BASE,
    ...DOOLA_PROD,
    FORMATION_PII_KEY: key.toString("base64"),
    FORMATION_PII_KEY_PREVIOUS: Buffer.alloc(32, 0x2b).toString("base64"),
  });
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain(key.toString("base64"));
  expect(printed).not.toContain(key.toString("hex"));
  // The byte-array spelling, which is what an un-redacted Buffer actually prints as.
  expect(printed).not.toContain('"type":"Buffer"');
  expect(printed).not.toContain(JSON.stringify([...key]).slice(1, -1));
  // The IDS survive: two of them is how an operator sees a rotation actually in progress.
  expect(printed).toContain(cfg.formation!.pii!.current.id);
  expect(printed).toContain(cfg.formation!.pii!.previous!.id);
});

test("FORMATION_MAX_AGENTS_PER_COMPANY defaults to 10 and is overridable", () => {
  expect(loadConfig({ ...BASE, ...DOOLA }).formation?.maxAgentsPerCompany).toBe(10);
  expect(
    loadConfig({ ...BASE, ...DOOLA, FORMATION_MAX_AGENTS_PER_COMPANY: "2" }).formation
      ?.maxAgentsPerCompany,
  ).toBe(2);
});
