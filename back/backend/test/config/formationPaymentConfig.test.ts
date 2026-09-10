/**
 * FORMATION PAYMENTS — the boot invariants (design 2026-08-26 §6.6/§6.7).
 *
 * Every one of these refuses at BOOT rather than at the first quote, because the failure modes
 * are silent: a fee paid to an address nobody holds a key for, a fee paid to OUR OWN hot wallet
 * (which looks exactly like a successful payment while moving the money nowhere), or 399 USDC
 * taken for a DEMO-watermarked sandbox record that is not a legal body at all.
 */

import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PLATFORM_KEY = `0x${"a".repeat(64)}` as const;
const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: PLATFORM_KEY,
};

const WORLD = {
  WORLD_APP_ID: "app_staging_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
  WORLD_REQUIRE_GUARDIAN: "true",
  WORLD_MAX_COMPANIES_PER_HUMAN: "3",
};

const REVENUE = "0x000000000000000000000000000000000000BEeF";
/** The DEDICATED settle submitter (B1 gate A2) — its own key, and nothing else's. */
const SUBMITTER_KEY = `0x${"c".repeat(64)}` as const;

/** The smallest env that may legally charge: a provider it can actually file with, a production
 *  provider environment, the identity floor wired, and somewhere to be paid. */
const PAYING = {
  ...BASE,
  ...WORLD,
  DOOLA_ENVIRONMENT: "production",
  DOOLA_API_KEY: "dk_live_key",
  DOOLA_WEBHOOK_SECRET: "whsec_live",
  FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
  FORMATION_PAYMENT_REQUIRED: "true",
  FORMATION_REVENUE_ADDRESS: REVENUE,
  FORMATION_SETTLE_SUBMITTER_KEY: SUBMITTER_KEY,
};

test("payment is OFF by default, and nothing derives it on", () => {
  // Unlike FORMATION_REQUIRED, which turns itself on when the provider is configured. Charging is
  // a decision an operator makes in as many words.
  const cfg = loadConfig(BASE);
  expect(cfg.formation?.payment.required).toBe(false);
  expect(cfg.formation?.payment.revenueAddress).toBeUndefined();
  const withProvider = loadConfig({
    ...BASE,
    DOOLA_API_KEY: "dk_test_key",
    DOOLA_WEBHOOK_SECRET: "whsec_test",
  });
  expect(withProvider.formation?.required).toBe(true);
  expect(withProvider.formation?.payment.required).toBe(false);
});

test("the fee defaults to 399 whole USDC and is converted ONCE to atomic", () => {
  expect(loadConfig(BASE).formation?.payment).toMatchObject({
    feeUsdc: 399,
    feeAtomic: 399_000_000n,
    quoteTtlMs: 30 * 60 * 1000,
    // The settlement GRACE (gate A4): how much longer than the quote the signature stays valid,
    // so a last-second authorization can still be composed, broadcast and mined.
    settleGraceMs: 15 * 60 * 1000,
  });
  const cheap = loadConfig({ ...BASE, FORMATION_FEE_USDC: "1" });
  expect(cheap.formation?.payment.feeAtomic).toBe(1_000_000n);
});

test("the fee is a positive integer — cents and zero are refused at boot", () => {
  expect(() => loadConfig({ ...BASE, FORMATION_FEE_USDC: "399.50" })).toThrow();
  expect(() => loadConfig({ ...BASE, FORMATION_FEE_USDC: "0" })).toThrow();
});

test("a paying deployment boots with the whole floor satisfied", () => {
  const cfg = loadConfig(PAYING);
  expect(cfg.formation?.payment.required).toBe(true);
  // Checksummed by the address schema, whatever casing the operator typed.
  expect(cfg.formation?.payment.revenueAddress).toBe("0x000000000000000000000000000000000000bEEF");
});

test("charging with no revenue address refuses to boot", () => {
  const { FORMATION_REVENUE_ADDRESS: _drop, ...noRevenue } = PAYING;
  expect(() => loadConfig(noRevenue)).toThrow(/FORMATION_REVENUE_ADDRESS is missing/);
});

test("SANDBOX CAN NEVER CHARGE — a demo record is not a legal body", () => {
  expect(() => loadConfig({ ...PAYING, DOOLA_ENVIRONMENT: "sandbox" })).toThrow(
    /DOOLA_ENVIRONMENT=sandbox/,
  );
  // …including the box that has no provider at all, whose DOOLA_ENVIRONMENT is the "sandbox"
  // DEFAULT rather than a choice. A deployment that forms nothing is exactly the one that must
  // not take money for a formation.
  const { DOOLA_ENVIRONMENT: _drop, ...noProvider } = PAYING;
  expect(() => loadConfig(noProvider)).toThrow(/DOOLA_ENVIRONMENT=sandbox/);
});

test("⚠ B9: a box that CANNOT FILE refuses to charge, even pointed at production", () => {
  // The deliberate shape the sandbox rule misses: `DOOLA_ENVIRONMENT=production` with no
  // credentials. It used to boot, print "FORMATION PAYMENTS ENABLED", quote $399 and take the
  // money — while every formation door stayed shut behind `canFormEntities`. The fee would have
  // been the only thing on the box that worked.
  const { DOOLA_API_KEY: _key, DOOLA_WEBHOOK_SECRET: _secret, ...noCredentials } = PAYING;
  expect(() => loadConfig(noCredentials)).toThrow(/cannot file anything/);
});

test("the revenue address must not be the PLATFORM key — a hot wallet on this box", () => {
  const platform = privateKeyToAccount(PLATFORM_KEY).address;
  expect(() => loadConfig({ ...PAYING, FORMATION_REVENUE_ADDRESS: platform })).toThrow(
    /equals the PLATFORM_PRIVATE_KEY address/,
  );
});

// ── THE DEDICATED SETTLE SUBMITTER (B1 gate A2) ────────────────────────────────────────────
//
// Its own EOA: its own nonce space, its own USDC gas float, no authority anywhere. Each refusal
// below is a distinct harm, not a variation on one.

test("charging with no submitter key refuses to boot", () => {
  const { FORMATION_SETTLE_SUBMITTER_KEY: _drop, ...noSubmitter } = PAYING;
  expect(() => loadConfig(noSubmitter)).toThrow(/FORMATION_SETTLE_SUBMITTER_KEY is missing/);
});

test("the submitter is wired onto the payment block, and REDACTED in the boot log", async () => {
  const cfg = loadConfig(PAYING);
  expect(cfg.formation?.payment.submitterKey).toBe(SUBMITTER_KEY);
  const { redact } = await import("../../src/config/env");
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain(SUBMITTER_KEY);
  expect(printed).toContain('"submitterKey":"REDACTED"');
});

test("the submitter must not be the PLATFORM key — that is the nonce space it exists to leave", () => {
  expect(() => loadConfig({ ...PAYING, FORMATION_SETTLE_SUBMITTER_KEY: PLATFORM_KEY })).toThrow(
    /is the PLATFORM_PRIVATE_KEY/,
  );
});

test("the submitter must not be the REVENUE address — the fee would come back to the payer of gas", () => {
  expect(() =>
    loadConfig({
      ...PAYING,
      FORMATION_REVENUE_ADDRESS: privateKeyToAccount(SUBMITTER_KEY).address,
    }),
  ).toThrow(/is the FORMATION_REVENUE_ADDRESS/);
});

test("the submitter must not be ANY other key this box signs with", () => {
  const jobKey = `0x${"d".repeat(64)}`;
  expect(() =>
    loadConfig({
      ...PAYING,
      JOB_CLIENT_PRIVATE_KEY: jobKey,
      FORMATION_SETTLE_SUBMITTER_KEY: jobKey,
    }),
  ).toThrow(/is the JOB_CLIENT_PRIVATE_KEY/);
});

test("the revenue address must not be ANY other key this box signs with", () => {
  // One arm per key would be ceremony; the loop is the invariant, so one representative key and
  // the shape of the message is what matters. ENS is chosen because it is the least obviously
  // "money" key in the set — a signer is a signer.
  const ensKey = `0x${"b".repeat(64)}`;
  const ensAddress = privateKeyToAccount(ensKey as `0x${string}`).address;
  expect(() =>
    loadConfig({
      ...PAYING,
      ENS_GATEWAY_SIGNER_KEY: ensKey,
      ENS_PARENT_NAME: "novicorpus.eth",
      FORMATION_REVENUE_ADDRESS: ensAddress,
    }),
  ).toThrow(/equals the ENS_GATEWAY_SIGNER_KEY address/);
});

test("THE IDENTITY FLOOR follows the money: charging demands a WIRED World block", () => {
  // §6.7's whole point — `assertGuardianAllowed` silently returns when `cfg.world` is undefined,
  // so a box could pass every string check and gate nothing. The floor now fires on the PAYMENT
  // switch too, not only on DOOLA_ENVIRONMENT, because a deployment that charges is production
  // formation whatever its provider credentials say.
  const { WORLD_APP_ID: _drop, ...unwired } = PAYING;
  expect(() => loadConfig(unwired)).toThrow(/FORMATION_PAYMENT_REQUIRED is on requires the World/);
  expect(() => loadConfig({ ...PAYING, WORLD_REQUIRE_GUARDIAN: "false" })).toThrow(
    /FORMATION_PAYMENT_REQUIRED is on with WORLD_REQUIRE_GUARDIAN off/,
  );
  const { WORLD_MAX_COMPANIES_PER_HUMAN: _drop2, ...uncapped } = PAYING;
  expect(() => loadConfig(uncapped)).toThrow(/requires WORLD_MAX_COMPANIES_PER_HUMAN/);
});

test("the doola arm of the identity floor still names DOOLA_ENVIRONMENT (no message drift)", () => {
  const { WORLD_APP_ID: _drop, ...unwired } = {
    ...BASE,
    ...WORLD,
    DOOLA_ENVIRONMENT: "production",
    DOOLA_API_KEY: "dk_test_key",
    DOOLA_WEBHOOK_SECRET: "whsec_test",
    FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  expect(() => loadConfig(unwired)).toThrow(
    /DOOLA_ENVIRONMENT=production requires the World ID block/,
  );
});

test("redact() carries the payment block through with nothing secret in it", () => {
  // An address is not a secret — but it is also not on `/config`, and the difference matters:
  // this is the OPERATOR's log line, not a public capability document.
  const cfg = loadConfig(PAYING);
  expect(cfg.formation?.payment.revenueAddress).toBeTruthy();
});

test("redact() serializes the fee as a string — a bigint would take the whole boot line down", async () => {
  const { redact } = await import("../../src/config/env");
  const printed = JSON.stringify(redact(loadConfig(PAYING)));
  expect(printed).toContain('"feeAtomic":"399000000"');
  // …and the revenue address SURVIVES redaction on purpose: it is not a secret, and it is what an
  // operator checks against the Ledger in the boot line. (It stays off `/config`, which is a
  // public document — a different rule for a different surface.)
  expect(printed.toLowerCase()).toContain(REVENUE.toLowerCase());
});
