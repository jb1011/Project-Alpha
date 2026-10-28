/**
 * The Kleros pilot's config (design 5.9): `cfg.pilot` (the three keys, the mode, the two caps, the
 * lookup base), `cfg.kleros` (the two keys, one per deployment, the endpoint, the court ids, the
 * aliases, the expected options, the policy URI) and `cfg.arcExplorerUrl`. The keys are read like
 * the job keys: all three or none, pairwise distinct, never the platform key in production, and
 * masked by `redact()`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig, redact } from "../../src/config/env";
import { CIRCLE_FULL_ENV } from "../helpers/prodEnv";

const PLATFORM_KEY = `0x${"1".repeat(64)}`;
const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: PLATFORM_KEY,
};

// Anvil's well-known throwaway keys (accounts 1, 2, 3): never real.
const BUYER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SELLER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const REFEREE = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const PILOT_KEYS = {
  PILOT_BUYER_PRIVATE_KEY: BUYER,
  PILOT_SELLER_PRIVATE_KEY: SELLER,
  PILOT_REFEREE_PRIVATE_KEY: REFEREE,
};
const KLEROS_KEYS = {
  KLEROS_API_KEY_TESTNET: "test-key-testnet",
  KLEROS_API_KEY_LIVE: "test-key-live",
};

/** Satisfies every pre-existing production guard, so a throw is the invariant under test. */
const PROD = {
  ...BASE,
  AUTH_JWT_SECRET: "a-real-production-secret-1234",
  WEB_ORIGIN: "https://app.example.com",
  METADATA_BASE_URL: "https://api.example.com/backend",
  NODE_ENV: "production",
  WALLET_PROVIDER_DEFAULT: "circle",
  ...CIRCLE_FULL_ENV,
};
const { NODE_ENV: _nodeEnv, ...DEV } = PROD;

afterEach(() => vi.restoreAllMocks());

describe("Pilot config: presence", () => {
  test("unset leaves both blocks undefined", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.pilot).toBeUndefined();
    expect(cfg.kleros).toBeUndefined();
  });

  test("the three pilot keys build the block", () => {
    const cfg = loadConfig({ ...BASE, ...PILOT_KEYS });
    expect(cfg.pilot?.buyerPrivateKey).toBe(BUYER);
    expect(cfg.pilot?.sellerPrivateKey).toBe(SELLER);
    expect(cfg.pilot?.refereePrivateKey).toBe(REFEREE);
  });

  test.each([
    ["PILOT_BUYER_PRIVATE_KEY"],
    ["PILOT_SELLER_PRIVATE_KEY"],
    ["PILOT_REFEREE_PRIVATE_KEY"],
  ])("two of three pilot keys (no %s) refused with the all-or-nothing message", (missing) => {
    const env: Record<string, string | undefined> = { ...BASE, ...PILOT_KEYS };
    delete env[missing];
    expect(() => loadConfig(env)).toThrow(new RegExp(`${missing} is missing \\(all-or-nothing\\)`));
  });

  test("one pilot key alone is refused with the all-or-nothing message", () => {
    expect(() => loadConfig({ ...BASE, PILOT_BUYER_PRIVATE_KEY: BUYER })).toThrow(/all-or-nothing/);
  });

  test("one Kleros key builds the kleros block with the defaults", () => {
    const cfg = loadConfig({ ...BASE, KLEROS_API_KEY_TESTNET: "test-key-testnet" });
    expect(cfg.kleros?.apiKeyTestnet).toBe("test-key-testnet");
    expect(cfg.kleros?.apiKeyLive).toBeUndefined();
    expect(cfg.kleros?.courtIdTestnet).toBe(8);
  });

  test("a blank Kleros key reads as unset", () => {
    const cfg = loadConfig({ ...BASE, KLEROS_API_KEY_TESTNET: "", KLEROS_API_KEY_LIVE: " " });
    expect(cfg.kleros).toBeUndefined();
  });
});

describe("Pilot config: key separation", () => {
  test.each([
    ["PILOT_SELLER_PRIVATE_KEY", BUYER],
    ["PILOT_REFEREE_PRIVATE_KEY", BUYER],
  ])("%s equal to another pilot key is refused", (name, value) => {
    expect(() => loadConfig({ ...BASE, ...PILOT_KEYS, [name]: value })).toThrow(
      /PILOT_.*_PRIVATE_KEY must differ from PILOT_.*_PRIVATE_KEY/,
    );
  });

  test("seller equal to referee is refused", () => {
    expect(() => loadConfig({ ...BASE, ...PILOT_KEYS, PILOT_REFEREE_PRIVATE_KEY: SELLER })).toThrow(
      /PILOT_REFEREE_PRIVATE_KEY must differ from PILOT_SELLER_PRIVATE_KEY/,
    );
  });

  test("equal pilot keys are refused outside production too, and re-cased hex is the same key", () => {
    expect(() =>
      loadConfig({
        ...DEV,
        ...PILOT_KEYS,
        PILOT_SELLER_PRIVATE_KEY: BUYER.toUpperCase().replace("0X", "0x"),
      }),
    ).toThrow(/must differ/);
  });

  test.each([
    ["PILOT_BUYER_PRIVATE_KEY"],
    ["PILOT_SELLER_PRIVATE_KEY"],
    ["PILOT_REFEREE_PRIVATE_KEY"],
  ])("prod + %s equal to PLATFORM_PRIVATE_KEY refuses to boot", (name) => {
    expect(() => loadConfig({ ...PROD, ...PILOT_KEYS, [name]: PLATFORM_KEY })).toThrow(
      new RegExp(`${name} must not equal PLATFORM_PRIVATE_KEY`),
    );
  });

  test.each([
    ["PILOT_BUYER_PRIVATE_KEY"],
    ["PILOT_SELLER_PRIVATE_KEY"],
    ["PILOT_REFEREE_PRIVATE_KEY"],
  ])("outside production %s equal to PLATFORM_PRIVATE_KEY boots with one warning", (name) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => loadConfig({ ...DEV, ...PILOT_KEYS, [name]: PLATFORM_KEY })).not.toThrow();
    const named = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes(name) && l.includes("PLATFORM_PRIVATE_KEY"));
    expect(named).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(PLATFORM_KEY.slice(2));
  });

  test("prod with three distinct pilot keys boots", () => {
    expect(() => loadConfig({ ...PROD, ...PILOT_KEYS })).not.toThrow();
  });

  test("prod + a pilot key equal to JOB_CLIENT_PRIVATE_KEY refuses to boot", () => {
    expect(() => loadConfig({ ...PROD, ...PILOT_KEYS, JOB_CLIENT_PRIVATE_KEY: SELLER })).toThrow(
      /PILOT_SELLER_PRIVATE_KEY must not equal JOB_CLIENT_PRIVATE_KEY/,
    );
  });

  test("outside production a pilot key equal to JOB_CLIENT_PRIVATE_KEY warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      loadConfig({ ...DEV, ...PILOT_KEYS, JOB_CLIENT_PRIVATE_KEY: SELLER }),
    ).not.toThrow();
    const named = warn.mock.calls
      .map((c) => String(c[0]))
      .filter(
        (l) => l.includes("PILOT_SELLER_PRIVATE_KEY") && l.includes("JOB_CLIENT_PRIVATE_KEY"),
      );
    expect(named).toHaveLength(1);
  });

  test("a pilot key equal to NOVI_ATTESTATION_KEY is refused (it is in signingKeys)", () => {
    expect(() => loadConfig({ ...BASE, ...PILOT_KEYS, NOVI_ATTESTATION_KEY: REFEREE })).toThrow(
      /NOVI_ATTESTATION_KEY is the PILOT_REFEREE_PRIVATE_KEY/,
    );
  });

  test("a pilot key equal to WORLDCHAIN_SUBMITTER_PRIVATE_KEY is refused", () => {
    expect(() =>
      loadConfig({ ...BASE, ...PILOT_KEYS, WORLDCHAIN_SUBMITTER_PRIVATE_KEY: BUYER }),
    ).toThrow(/WORLDCHAIN_SUBMITTER_PRIVATE_KEY must not equal PILOT_BUYER_PRIVATE_KEY/);
  });

  test("equal Kleros keys are refused", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        KLEROS_API_KEY_TESTNET: "test-key-testnet",
        KLEROS_API_KEY_LIVE: "test-key-testnet",
      }),
    ).toThrow(/KLEROS_API_KEY_TESTNET and KLEROS_API_KEY_LIVE must differ/);
  });

  test("the equal-keys message does not carry the key", () => {
    let message = "";
    try {
      loadConfig({
        ...BASE,
        KLEROS_API_KEY_TESTNET: "test-key-testnet",
        KLEROS_API_KEY_LIVE: "test-key-testnet",
      });
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/must differ/);
    expect(message).not.toContain("test-key-testnet");
  });

  test("Kleros keys that differ only by surrounding whitespace are refused as equal", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        KLEROS_API_KEY_TESTNET: "test-key-testnet",
        KLEROS_API_KEY_LIVE: "test-key-testnet ",
      }),
    ).toThrow(/KLEROS_API_KEY_TESTNET and KLEROS_API_KEY_LIVE must differ/);
    expect(() =>
      loadConfig({
        ...BASE,
        KLEROS_API_KEY_TESTNET: " test-key-live",
        KLEROS_API_KEY_LIVE: "test-key-live",
      }),
    ).toThrow(/KLEROS_API_KEY_TESTNET and KLEROS_API_KEY_LIVE must differ/);
  });
});

describe("Pilot config: mode", () => {
  test("rehearsal is the default and needs nothing", () => {
    const cfg = loadConfig({ ...BASE, ...PILOT_KEYS });
    expect(cfg.pilot?.mode).toBe("rehearsal");
    expect(cfg.kleros).toBeUndefined();
  });

  test("testnet without KLEROS_API_KEY_TESTNET is refused", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        ...PILOT_KEYS,
        PILOT_KLEROS_MODE: "testnet",
        KLEROS_API_KEY_LIVE: "test-key-live",
      }),
    ).toThrow(/PILOT_KLEROS_MODE=testnet requires KLEROS_API_KEY_TESTNET/);
  });

  test("live without KLEROS_API_KEY_LIVE is refused", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        ...PILOT_KEYS,
        PILOT_KLEROS_MODE: "live",
        KLEROS_API_KEY_TESTNET: "test-key-testnet",
      }),
    ).toThrow(/PILOT_KLEROS_MODE=live requires KLEROS_API_KEY_LIVE/);
  });

  test("testnet with its key, and live with its key, load", () => {
    expect(
      loadConfig({
        ...BASE,
        ...PILOT_KEYS,
        PILOT_KLEROS_MODE: "testnet",
        KLEROS_API_KEY_TESTNET: "test-key-testnet",
      }).pilot?.mode,
    ).toBe("testnet");
    expect(
      loadConfig({
        ...BASE,
        ...PILOT_KEYS,
        PILOT_KLEROS_MODE: "live",
        KLEROS_API_KEY_LIVE: "test-key-live",
      }).pilot?.mode,
    ).toBe("live");
  });

  test("an unknown mode is refused", () => {
    expect(() => loadConfig({ ...BASE, ...PILOT_KEYS, PILOT_KLEROS_MODE: "mainnet" })).toThrow(
      /PILOT_KLEROS_MODE/,
    );
  });

  test.each([["KLEROS_API_KEY"], ["KLEROS_CHAIN"], ["KLEROS_COURT_ID"]])(
    "a stale %s is refused by name, naming the new names",
    (stale) => {
      expect(() => loadConfig({ ...BASE, [stale]: "anything" })).toThrow(new RegExp(stale));
      expect(() => loadConfig({ ...BASE, [stale]: "anything" })).toThrow(
        /KLEROS_API_KEY_TESTNET.*KLEROS_API_KEY_LIVE/,
      );
    },
  );

  test("a stale KLEROS_COURT_ID names the two court-id variables", () => {
    expect(() => loadConfig({ ...BASE, KLEROS_COURT_ID: "8" })).toThrow(
      /KLEROS_COURT_ID_TESTNET.*KLEROS_COURT_ID_LIVE/,
    );
  });

  test("the stale-key message does not carry the key", () => {
    let message = "";
    try {
      loadConfig({ ...BASE, KLEROS_API_KEY: "test-key-live" });
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/KLEROS_API_KEY/);
    expect(message).not.toContain("test-key-live");
  });
});

describe("Pilot config: defaults and overrides", () => {
  test("defaults for caps, courts, aliases, options, policy, endpoint, explorer, lookup base", () => {
    const cfg = loadConfig({ ...BASE, ...PILOT_KEYS, ...KLEROS_KEYS });
    expect(cfg.pilot?.testnetCasesCap).toBe(10);
    expect(cfg.pilot?.liveCasesCap).toBe(5);
    expect(cfg.pilot?.lookupBase).toBe("http://localhost:8789");
    expect(cfg.kleros?.apiUrl).toBe("https://kleros-dispute-service.fly.dev/mcp");
    expect(cfg.kleros?.courtIdTestnet).toBe(8);
    expect(cfg.kleros?.courtIdLive).toBe(34);
    expect(cfg.kleros?.aliasClient).toBe("client");
    expect(cfg.kleros?.aliasProvider).toBe("provider");
    expect(cfg.kleros?.expectedOptions).toEqual({
      "1": "Pay the provider",
      "2": "Refund the client",
    });
    expect(cfg.kleros?.policyUri).toBe("/ipfs/QmPbiXTAacEcw2BrWxqGERJ24BcAxGvGa3M75sqRruSfVW");
    expect(cfg.arcExplorerUrl).toBe("https://explorer.testnet.arc.io");
  });

  test("arcExplorerUrl is set with no pilot at all", () => {
    expect(loadConfig(BASE).arcExplorerUrl).toBe("https://explorer.testnet.arc.io");
  });

  test("lookup base: PUBLIC_API_URL when set, else METADATA_BASE_URL, no trailing slash", () => {
    expect(
      loadConfig({ ...BASE, ...PILOT_KEYS, PUBLIC_API_URL: "https://api.example.com/" }).pilot
        ?.lookupBase,
    ).toBe("https://api.example.com");
    expect(
      loadConfig({ ...BASE, ...PILOT_KEYS, METADATA_BASE_URL: "https://www.example.com/backend/" })
        .pilot?.lookupBase,
    ).toBe("https://www.example.com/backend");
    expect(
      loadConfig({
        ...BASE,
        ...PILOT_KEYS,
        PUBLIC_API_URL: "https://api.example.com",
        PILOT_LOOKUP_BASE: "https://lookup.example.com/",
      }).pilot?.lookupBase,
    ).toBe("https://lookup.example.com");
  });

  test("ARC_EXPLORER_URL override loses its trailing slash", () => {
    expect(
      loadConfig({ ...BASE, ARC_EXPLORER_URL: "https://explorer.example.com/" }).arcExplorerUrl,
    ).toBe("https://explorer.example.com");
  });

  test("overrides for caps, courts and aliases are honored", () => {
    const cfg = loadConfig({
      ...BASE,
      ...PILOT_KEYS,
      ...KLEROS_KEYS,
      PILOT_TESTNET_CASES_CAP: "20",
      PILOT_LIVE_CASES_CAP: "3",
      KLEROS_COURT_ID_TESTNET: "9",
      KLEROS_COURT_ID_LIVE: "35",
      KLEROS_ALIAS_CLIENT: "buyer",
      KLEROS_ALIAS_PROVIDER: "seller",
    });
    expect(cfg.pilot?.testnetCasesCap).toBe(20);
    expect(cfg.pilot?.liveCasesCap).toBe(3);
    expect(cfg.kleros?.courtIdTestnet).toBe(9);
    expect(cfg.kleros?.courtIdLive).toBe(35);
    expect(cfg.kleros?.aliasClient).toBe("buyer");
    expect(cfg.kleros?.aliasProvider).toBe("seller");
  });

  test.each([
    ["PILOT_TESTNET_CASES_CAP", "0"],
    ["PILOT_TESTNET_CASES_CAP", "1.5"],
    ["PILOT_LIVE_CASES_CAP", "-1"],
    ["PILOT_LIVE_CASES_CAP", "five"],
  ])("%s=%s is refused: a cap is a positive integer", (name, value) => {
    expect(() => loadConfig({ ...BASE, ...PILOT_KEYS, [name]: value })).toThrow(new RegExp(name));
  });

  test.each([
    ["KLEROS_COURT_ID_TESTNET", "0"],
    ["KLEROS_COURT_ID_LIVE", "0"],
  ])("%s=%s is refused at boot: a court id is a positive integer", (name, value) => {
    expect(() => loadConfig({ ...BASE, ...KLEROS_KEYS, [name]: value })).toThrow(new RegExp(name));
  });
});

describe("Pilot config: KLEROS_EXPECTED_OPTIONS", () => {
  test("parses the documented value", () => {
    const cfg = loadConfig({
      ...BASE,
      ...KLEROS_KEYS,
      KLEROS_EXPECTED_OPTIONS: "1=Pay the provider;2=Refund the client",
    });
    expect(cfg.kleros?.expectedOptions).toEqual({
      "1": "Pay the provider",
      "2": "Refund the client",
    });
  });

  test("keys are normalised to decimal: 0x01 is 1", () => {
    const cfg = loadConfig({
      ...BASE,
      ...KLEROS_KEYS,
      KLEROS_EXPECTED_OPTIONS: "0x01=Pay the provider; 02 = Refund the client",
    });
    expect(cfg.kleros?.expectedOptions).toEqual({
      "1": "Pay the provider",
      "2": "Refund the client",
    });
  });

  test("an uppercase 0X prefix parses: 0X01 is 1", () => {
    const cfg = loadConfig({
      ...BASE,
      ...KLEROS_KEYS,
      KLEROS_EXPECTED_OPTIONS: "0X01=Pay the provider;2=Refund the client",
    });
    expect(cfg.kleros?.expectedOptions).toEqual({
      "1": "Pay the provider",
      "2": "Refund the client",
    });
  });

  test("a trailing semicolon is refused as an empty pair", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        ...KLEROS_KEYS,
        KLEROS_EXPECTED_OPTIONS: "1=Pay the provider;2=Refund the client;",
      }),
    ).toThrow(/KLEROS_EXPECTED_OPTIONS.*an empty pair \(a trailing ";"\?\)/);
  });

  test.each([
    ["no equals sign", "1 Pay the provider"],
    ["empty label", "1=;2=Refund the client"],
    ["non-numeric value", "one=Pay the provider"],
    ["negative value", "-1=Pay the provider"],
    ["duplicate value", "1=Pay the provider;0x1=Refund the client"],
    ["empty pair", "1=Pay the provider;;2=Refund the client"],
  ])("refuses a malformed value (%s)", (_why, value) => {
    expect(() => loadConfig({ ...BASE, ...KLEROS_KEYS, KLEROS_EXPECTED_OPTIONS: value })).toThrow(
      /KLEROS_EXPECTED_OPTIONS/,
    );
  });
});

describe("Pilot config: redaction", () => {
  test("redact() masks the five secrets and prints the rest", () => {
    const cfg = loadConfig({ ...BASE, ...PILOT_KEYS, ...KLEROS_KEYS });
    const r = redact(cfg) as {
      pilot: Record<string, unknown>;
      kleros: Record<string, unknown>;
      arcExplorerUrl: string;
    };
    expect(r.pilot.buyerPrivateKey).toBe("REDACTED");
    expect(r.pilot.sellerPrivateKey).toBe("REDACTED");
    expect(r.pilot.refereePrivateKey).toBe("REDACTED");
    expect(r.kleros.apiKeyTestnet).toBe("REDACTED");
    expect(r.kleros.apiKeyLive).toBe("REDACTED");
    expect(r.pilot.mode).toBe("rehearsal");
    expect(r.kleros.apiUrl).toBe("https://kleros-dispute-service.fly.dev/mcp");
    expect(r.kleros.courtIdTestnet).toBe(8);
    expect(r.kleros.courtIdLive).toBe(34);
    expect(r.kleros.policyUri).toBe("/ipfs/QmPbiXTAacEcw2BrWxqGERJ24BcAxGvGa3M75sqRruSfVW");
    expect(r.arcExplorerUrl).toBe("https://explorer.testnet.arc.io");
  });

  test("a box-like env serialises with no key in it", () => {
    const line = JSON.stringify(redact(loadConfig({ ...DEV, ...PILOT_KEYS, ...KLEROS_KEYS })));
    for (const secret of [BUYER, SELLER, REFEREE, "test-key-testnet", "test-key-live"])
      expect(line).not.toContain(secret.replace(/^0x/, ""));
  });

  test("an absent Kleros key stays undefined in redact()", () => {
    const cfg = loadConfig({ ...BASE, KLEROS_API_KEY_LIVE: "test-key-live" });
    const r = redact(cfg) as { kleros: Record<string, unknown> };
    expect(r.kleros.apiKeyTestnet).toBeUndefined();
    expect(r.kleros.apiKeyLive).toBe("REDACTED");
  });
});

describe("Pilot config: the two agent ids", () => {
  test("unset by default", () => {
    const cfg = loadConfig({ ...BASE, ...PILOT_KEYS });
    expect(cfg.pilot?.buyerAgentId).toBeUndefined();
    expect(cfg.pilot?.sellerAgentId).toBeUndefined();
  });

  test("decimal ids are carried as strings; blank is unset", () => {
    const cfg = loadConfig({
      ...BASE,
      ...PILOT_KEYS,
      PILOT_BUYER_AGENT_ID: "12",
      PILOT_SELLER_AGENT_ID: "0",
    });
    expect(cfg.pilot?.buyerAgentId).toBe("12");
    expect(cfg.pilot?.sellerAgentId).toBe("0");
    expect(
      loadConfig({ ...BASE, ...PILOT_KEYS, PILOT_SELLER_AGENT_ID: " " }).pilot?.sellerAgentId,
    ).toBeUndefined();
  });

  test.each([
    ["PILOT_BUYER_AGENT_ID", "0x12"],
    ["PILOT_BUYER_AGENT_ID", "012"],
    ["PILOT_SELLER_AGENT_ID", "-1"],
    ["PILOT_SELLER_AGENT_ID", "1.5"],
    ["PILOT_SELLER_AGENT_ID", "1".repeat(79)],
  ])("%s=%s is refused by name: an agent id is a decimal", (name, value) => {
    expect(() => loadConfig({ ...BASE, ...PILOT_KEYS, [name]: value })).toThrow(new RegExp(name));
  });
});
