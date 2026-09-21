/**
 * THE REGRESSION GUARD for the whole "a missing env var must refuse, never become the platform
 * key" item.
 *
 * Three config values silently defaulted to the platform governance key when their var was unset:
 * CUSTOMER_PRIVATE_KEY, JOB_CLIENT_PRIVATE_KEY and X402_DEMO_PAYTO. Each of those has its own
 * focused test. This one is the net under all of them, and under the next one somebody adds: it
 * parses a config with EVERY optional var unset and walks the whole parsed object — strings,
 * nested objects, arrays — asserting that nothing anywhere holds the platform private key or the
 * address derived from it.
 *
 * A `?? PLATFORM_PRIVATE_KEY` or `privateKeyToAccount(e.PLATFORM_PRIVATE_KEY).address` added
 * anywhere in `loadConfig` fails here, by construction, whether or not anyone writes a test for
 * the field itself. That is the point: the three defects were three instances of one habit.
 */
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { type Config, loadConfig } from "../../src/config/env";

const PLATFORM_KEY = `0x${"1".repeat(64)}` as const;
const PLATFORM_ADDRESS = privateKeyToAccount(PLATFORM_KEY).address;

/**
 * The bare env: the two REQUIRED vars and nothing else, which is exactly the shape that used to
 * spread the platform key across the config. Credential-less boot is an invariant here — this
 * deployment must parse, with every optional feature degraded to unavailable.
 */
const BARE_ENV = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: PLATFORM_KEY,
};

/**
 * THE ONLY FIELDS ALLOWED TO HOLD THE PLATFORM IDENTITY — each one because it IS that identity,
 * not because it fell back to it. Every entry carries its reason; anything else matching is a
 * finding, not a line to add here.
 */
const PLATFORM_IDENTITY_FIELDS: Array<[path: string, reason: string]> = [
  [
    "cfg.platformPrivateKey",
    "the platform governance key itself — the value every other field must not be",
  ],
];

/** Every string in the config, with the path that reached it. */
function walk(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return;
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, `${path}.${k}`, out);
    }
  }
}

function platformIdentityHits(cfg: Config): Array<[string, string]> {
  const strings: Array<[string, string]> = [];
  walk(cfg, "cfg", strings);
  const key = PLATFORM_KEY.toLowerCase();
  const address = PLATFORM_ADDRESS.toLowerCase();
  const allowed = new Set(PLATFORM_IDENTITY_FIELDS.map(([p]) => p));
  return strings.filter(([path, value]) => {
    if (allowed.has(path)) return false;
    const v = value.toLowerCase();
    // `includes` for the address, not equality: a url, a CAIP id or any composed string that
    // embeds the platform address is the same leak wearing a different shape.
    return v === key || v.includes(address);
  });
}

test("the walker actually reaches nested values (so a green assertion means something)", () => {
  const found: Array<[string, string]> = [];
  walk({ a: "one", b: { c: ["two", { d: "three" }] }, n: 1n }, "cfg", found);
  expect(found).toEqual([
    ["cfg.a", "one"],
    ["cfg.b.c[0]", "two"],
    ["cfg.b.c[1].d", "three"],
  ]);
});

test("the walker would CATCH a platform-key fallback (the guard is not vacuous)", () => {
  const cfg = loadConfig(BARE_ENV);
  // Exactly the shape the three defects had, injected by hand: a field that answered the platform
  // key, and one that answered its derived address.
  const withFallbacks = {
    ...cfg,
    someKey: PLATFORM_KEY,
    nested: { payTo: PLATFORM_ADDRESS },
  } as unknown as Config;
  const hits = platformIdentityHits(withFallbacks).map(([p]) => p);
  expect(hits).toContain("cfg.someKey");
  expect(hits).toContain("cfg.nested.payTo");
});

test("with every optional var unset, NO config value is the platform key or its address", () => {
  const cfg = loadConfig(BARE_ENV);

  const hits = platformIdentityHits(cfg);
  // The message names the offender, because the useful failure here is "which field, and did
  // somebody add a fourth silent derivation?" — not "a boolean was false".
  expect(
    hits,
    `these fields hold the platform identity with no var set:\n${hits
      .map(([p, v]) => `  ${p} = ${v}`)
      .join(
        "\n",
      )}\nIf one of them IS the platform identity by design, document it in PLATFORM_IDENTITY_FIELDS with a reason. Otherwise it is a fallback and must be removed.`,
  ).toEqual([]);

  // And the field that IS the platform identity still is — proof the walk looked at the config it
  // was handed rather than an empty object.
  expect(cfg.platformPrivateKey).toBe(PLATFORM_KEY);
});

test("the three fields that used to fall back are undefined, one by one", () => {
  const cfg = loadConfig(BARE_ENV);
  expect(cfg.customerPrivateKey).toBeUndefined();
  expect(cfg.jobClientPrivateKey).toBeUndefined();
  expect(cfg.x402DemoPayTo).toBeUndefined();
});

test("the guard also holds with the optional FEATURE FLAGS on but their credentials absent", () => {
  // Turning a feature on must not conjure an identity for it either: this is the state an
  // operator is actually in halfway through a deploy.
  const cfg = loadConfig({
    ...BARE_ENV,
    ENABLE_X402_DEMO: "true",
    JOB_SWEEP_TO_TREASURY: "true",
    X402_TRUST_POLICY: "legal-bodies-only",
  });
  expect(platformIdentityHits(cfg)).toEqual([]);
});
