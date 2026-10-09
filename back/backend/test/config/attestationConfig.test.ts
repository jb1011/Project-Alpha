/**
 * The attestation key's own config: `cfg.attestation`, built from NOVI_ATTESTATION_KEY whenever it
 * is set, on any network and whatever HEDERA_ENABLED says; the rule that the key holds no other
 * role on this box; and the rule that a mainnet deployment with legal bodies on must hold it.
 *
 * Every key here is a placeholder or one of anvil's published test accounts, never a real wallet.
 */
import { expect, test } from "vitest";
import { assertLegalBodyAttestationConfig, loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};

/** The Hedera block, whole. */
const HEDERA_ON = {
  HEDERA_ENABLED: "1",
  HEDERA_NETWORK: "testnet",
  HEDERA_FACILITATOR_URL: "https://facilitator.example",
  HEDERA_MIRROR_URL: "https://mirror.example",
  HEDERA_USDC_TOKEN_ID: "0.0.1",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.2",
};

/** anvil's published account #0, and its address in EIP-55 form. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

/** Controller mode with the full-product factory named: what the legal-body factory requires. */
const CONTROLLER_MODE = {
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
};
const LB_FACTORY = "0x3333333333333333333333333333333333333333" as const;

/** Any chain id other than the testnet's names mainnet here. */
const MAINNET_CHAIN_ID = "8004";

/** A mainnet deployment that boots: a production provider with the identity and SSN-key floors,
 *  and controller mode. A throw from it names the one thing a test changed. */
const MAINNET = {
  ...BASE,
  ...CONTROLLER_MODE,
  ARC_NETWORK: "mainnet",
  ARC_CHAIN_ID: MAINNET_CHAIN_ID,
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

/** The same deployment, charging: somewhere to be paid and a dedicated settle submitter. */
const MAINNET_CHARGING = {
  ...MAINNET,
  FORMATION_PAYMENT_REQUIRED: "true",
  FORMATION_REVENUE_ADDRESS: "0x000000000000000000000000000000000000BEeF",
  FORMATION_SETTLE_SUBMITTER_KEY: `0x${"c".repeat(64)}`,
};

const NEEDS_THE_KEY =
  "Invalid config: LEGAL_BODY_FACTORY_ADDRESS on mainnet needs NOVI_ATTESTATION_KEY: a legal body is stated only by a signed statement";

/** The refusal of a key that is another key of this box, as the separation rule words it. */
const isAlso = (name: string) =>
  `Invalid config: NOVI_ATTESTATION_KEY is the ${name} — the attestation key signs statements and holds no other role on this box (design 2026-09-10 D6)`;

/** The message `fn` throws, or undefined when it returns. */
function thrownBy(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

// ── cfg.attestation ──

test("the key with Hedera off: cfg.attestation holds the key and its EIP-55 address, and there is no Hedera block", () => {
  const cfg = loadConfig({ ...BASE, NOVI_ATTESTATION_KEY: KEY });
  expect(cfg.attestation).toEqual({ key: KEY, address: ADDRESS });
  expect(cfg.hedera).toBeUndefined();
});

test("the key with Hedera on: both blocks hold the one key", () => {
  const cfg = loadConfig({ ...BASE, ...HEDERA_ON, NOVI_ATTESTATION_KEY: KEY });
  expect(cfg.attestation).toEqual({ key: KEY, address: ADDRESS });
  expect(cfg.hedera?.attestationKey).toBe(KEY);
});

test("no key: no attestation block, with Hedera off or on", () => {
  expect(loadConfig(BASE).attestation).toBeUndefined();
  const hedera = loadConfig({ ...BASE, ...HEDERA_ON });
  expect(hedera.attestation).toBeUndefined();
  expect(hedera.hedera).toBeDefined();
  expect(hedera.hedera?.attestationKey).toBeUndefined();
});

test("the key on a mainnet deployment: cfg.attestation holds it", () => {
  const cfg = loadConfig({ ...MAINNET, NOVI_ATTESTATION_KEY: KEY });
  expect(cfg.attestation).toEqual({ key: KEY, address: ADDRESS });
  expect(cfg.hedera).toBeUndefined();
});

// ── no other role ──

test("with Hedera off, a key that is another key of this box is refused: the platform key, a signing key, the settle submitter", () => {
  expect(
    thrownBy(() => loadConfig({ ...BASE, NOVI_ATTESTATION_KEY: BASE.PLATFORM_PRIVATE_KEY })),
  ).toBe(isAlso("PLATFORM_PRIVATE_KEY"));
  expect(
    thrownBy(() => loadConfig({ ...BASE, NOVI_ATTESTATION_KEY: BASE.CUSTOMER_PRIVATE_KEY })),
  ).toBe(isAlso("CUSTOMER_PRIVATE_KEY"));
  const settleKey = `0x${"4".repeat(64)}`;
  expect(
    thrownBy(() =>
      loadConfig({
        ...BASE,
        FORMATION_SETTLE_SUBMITTER_KEY: settleKey,
        NOVI_ATTESTATION_KEY: settleKey,
      }),
    ),
  ).toBe(isAlso("FORMATION_SETTLE_SUBMITTER_KEY"));
});

test("a key written in another case is the same key: the platform key in upper case is refused", () => {
  const upper = `0x${"A".repeat(64)}`;
  expect(
    thrownBy(() =>
      loadConfig({
        ...BASE,
        PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
        NOVI_ATTESTATION_KEY: upper,
      }),
    ),
  ).toBe(isAlso("PLATFORM_PRIVATE_KEY"));
});

// ── redact ──

test("redact hides the key and keeps the address, with Hedera off or on", () => {
  const printed = redact(loadConfig({ ...BASE, NOVI_ATTESTATION_KEY: KEY }));
  expect(printed.attestation).toEqual({ key: "REDACTED", address: ADDRESS });
  expect(JSON.stringify(printed).toLowerCase()).not.toContain(KEY.slice(2));

  const both = redact(loadConfig({ ...BASE, ...HEDERA_ON, NOVI_ATTESTATION_KEY: KEY }));
  expect(both.attestation).toEqual({ key: "REDACTED", address: ADDRESS });
  expect((both.hedera as { attestationKey?: string }).attestationKey).toBe("REDACTED");
  expect(JSON.stringify(both).toLowerCase()).not.toContain(KEY.slice(2));

  expect(redact(loadConfig(BASE)).attestation).toBeUndefined();
});

// ── a mainnet deployment with legal bodies on needs the key ──

test("assertLegalBodyAttestationConfig: mainnet with the factory and no key throws", () => {
  expect(
    thrownBy(() =>
      assertLegalBodyAttestationConfig({ arcNetwork: "mainnet", legalBodyFactory: LB_FACTORY }),
    ),
  ).toBe(NEEDS_THE_KEY);
});

test("assertLegalBodyAttestationConfig: with the key, without the factory, or on testnet, it does not throw", () => {
  const attestation = { key: KEY, address: ADDRESS };
  expect(() =>
    assertLegalBodyAttestationConfig({
      arcNetwork: "mainnet",
      legalBodyFactory: LB_FACTORY,
      attestation,
    }),
  ).not.toThrow();
  expect(() => assertLegalBodyAttestationConfig({ arcNetwork: "mainnet" })).not.toThrow();
  expect(() =>
    assertLegalBodyAttestationConfig({ arcNetwork: "testnet", legalBodyFactory: LB_FACTORY }),
  ).not.toThrow();
  // A network left unset reads as testnet.
  expect(() => assertLegalBodyAttestationConfig({ legalBodyFactory: LB_FACTORY })).not.toThrow();
});

test("loadConfig: a mainnet deployment with the factory refuses to boot without the key, and boots with it", () => {
  expect(loadConfig(MAINNET).legalBodyFactory).toBeUndefined();
  expect(thrownBy(() => loadConfig({ ...MAINNET, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY }))).toBe(
    NEEDS_THE_KEY,
  );
  const cfg = loadConfig({
    ...MAINNET,
    LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY,
    NOVI_ATTESTATION_KEY: KEY,
  });
  expect(cfg.legalBodyFactory).toBe(LB_FACTORY);
  expect(cfg.attestation).toEqual({ key: KEY, address: ADDRESS });
});

test("loadConfig: a testnet deployment with the factory and no key boots", () => {
  const cfg = loadConfig({ ...BASE, ...CONTROLLER_MODE, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY });
  expect(cfg.legalBodyFactory).toBe(LB_FACTORY);
  expect(cfg.attestation).toBeUndefined();
});

test("loadConfig: the factory's own three rules answer first, then the key's", () => {
  const { CONTROLLER_ADDRESS: _controller, ...noController } = MAINNET;
  expect(
    thrownBy(() => loadConfig({ ...noController, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY })),
  ).toMatch(/^Invalid config: LEGAL_BODY_FACTORY_ADDRESS is set but CONTROLLER_ADDRESS is missing/);
  expect(
    thrownBy(() =>
      loadConfig({ ...MAINNET, LEGAL_BODY_FACTORY_ADDRESS: CONTROLLER_MODE.FACTORY_ADDRESS }),
    ),
  ).toMatch(/^Invalid config: LEGAL_BODY_FACTORY_ADDRESS equals FACTORY_ADDRESS/);
  expect(
    thrownBy(() => loadConfig({ ...MAINNET_CHARGING, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY })),
  ).toMatch(/BYO_ATTESTATION_FEE_USDC is missing/);
  expect(
    thrownBy(() =>
      loadConfig({
        ...MAINNET_CHARGING,
        LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY,
        BYO_ATTESTATION_FEE_USDC: "7",
      }),
    ),
  ).toBe(NEEDS_THE_KEY);
  const priced = loadConfig({
    ...MAINNET_CHARGING,
    LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY,
    BYO_ATTESTATION_FEE_USDC: "7",
    NOVI_ATTESTATION_KEY: KEY,
  });
  expect(priced.attestation?.address).toBe(ADDRESS);
});
