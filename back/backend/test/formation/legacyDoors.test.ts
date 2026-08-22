/**
 * Doors 3 and 4 (design §5, door matrix): the legacy onboarding server and `cli create-entity`.
 *
 * Both bypass the claim, the World gate and the custody gate, and neither can carry a `partyId`.
 * On a deployment where formation is MANDATORY they would therefore mint entities pinned to a
 * provider, owing a filing, with no legal identity to file with — permanently stuck entities,
 * created by doors that never learned formation exists. So they refuse.
 *
 * (The design records the recommendation to retire the legacy server outright and leaves the
 * decision to this PR's review. The refusal is what makes either outcome safe in the meantime.)
 */
import { expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";
import type { Config } from "../../src/config/env";
import { legacyDoorRefusalMessage, legacyDoorRefused } from "../../src/formation";
import { buildOnboardingApp } from "../../src/onboarding/server";

const doola = {
  apiKey: "dk_test_x",
  webhookSecret: "s",
  environment: "sandbox" as const,
  baseUrl: "https://api.test.doola.com",
};

const cfgWith = (over: Partial<Config>): Config => ({ ...over }) as Config;

test("legacyDoorRefused is exactly `formation configured AND mandatory`", () => {
  // No provider: the credential-less deployment keeps working exactly as it always has.
  expect(legacyDoorRefused(cfgWith({ formation: { required: true } as never }))).toBe(false);
  // Credentials but formation switched off: stub mode, nothing is owed, so nothing is refused.
  expect(legacyDoorRefused(cfgWith({ doola, formation: { required: false } as never }))).toBe(
    false,
  );
  expect(legacyDoorRefused(cfgWith({ doola, formation: { required: true } as never }))).toBe(true);
});

test("the legacy onboarding server refuses BEFORE reading the body", async () => {
  const runOnboarding = vi.fn();
  const app = buildOnboardingApp({
    runOnboarding,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    formationRefusal: legacyDoorRefusalMessage("onboarding-server"),
  } as never);

  // A body that would otherwise be perfectly valid — nothing this door can be told changes the
  // answer, so it is refused before the JSON is even parsed.
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "Agent" },
      guardianPasskey: { attestation: { credentialId: "id" } },
    }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(
    /cannot onboard on a deployment where formation is required/,
  );
  expect(runOnboarding).not.toHaveBeenCalled();
});

test("the legacy server is UNCHANGED where formation is not mandatory", async () => {
  const app = buildOnboardingApp({
    runOnboarding: async () => ({
      status: "funded",
      turnkeySubOrgId: "s1",
      turnkeyWalletId: "w1",
      operator: "0x00000000000000000000000000000000000000ab",
    }),
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
  } as never);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "Agent" },
      guardianPasskey: { attestation: { credentialId: "id" } },
    }),
  });
  expect(res.status).toBe(200);
});

test("cli create-entity refuses at COMMAND time, before the spec file is even read", async () => {
  const ctx = {
    cfg: cfgWith({ doola, formation: { required: true } as never }),
    repo: {} as never,
    docStore: {} as never,
    arc: {} as never,
    operatorSigner: {} as never,
  };
  const program = buildCli(() => ctx as never);
  await expect(
    program.parseAsync(["create-entity", "-c", "/nonexistent/agent.json"], { from: "user" }),
  ).rejects.toThrow(/cannot onboard on a deployment where formation is required/);
});
