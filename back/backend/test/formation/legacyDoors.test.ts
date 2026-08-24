/**
 * Door 4 (design §5, door matrix): `cli create-entity`.
 *
 * It bypasses the claim, the World gate and the custody gate, and it cannot carry a `partyId`. On
 * a deployment where formation is MANDATORY it would therefore mint entities pinned to a
 * provider, owing a filing, with no legal identity to file with — permanently stuck entities,
 * created by a door that never learned formation exists. So it refuses.
 *
 * There were TWO such doors. The standalone onboarding server (`src/onboarding/{server,main}.ts`)
 * was RETIRED in PR 3: the design recorded the recommendation and left the decision to review,
 * and the decision was to retire it. Its tests went with it — a door that does not exist needs no
 * refusal.
 */
import { expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";
import type { Config } from "../../src/config/env";
import { legacyDoorRefusalMessage, legacyDoorRefused } from "../../src/formation";

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

test("cli create-entity refuses at COMMAND time, before the spec file is even read", async () => {
  const ctx = {
    cfg: cfgWith({ doola, formation: { required: true } as never }),
    repo: {} as never,
    anchors: {} as never,
    docStore: {} as never,
    arc: {} as never,
    operatorSigner: {} as never,
  };
  const program = buildCli(() => ctx as never);
  await expect(
    program.parseAsync(["create-entity", "-c", "/nonexistent/agent.json"], { from: "user" }),
  ).rejects.toThrow(/cannot onboard on a deployment where formation is required/);
});

test("the CLI is UNCHANGED on a deployment where formation is not mandatory", async () => {
  // The refusal is the ONLY thing formation adds to this door. With formation switched off the
  // command reaches its own argument handling exactly as it did before — proven by the spec file
  // being what fails, rather than the gate.
  const ctx = {
    cfg: cfgWith({ doola, formation: { required: false } as never }),
    repo: {} as never,
    anchors: {} as never,
    docStore: {} as never,
    arc: {} as never,
    operatorSigner: {} as never,
  };
  const makeContext = vi.fn(() => ctx as never);
  const program = buildCli(makeContext);
  await expect(
    program.parseAsync(["create-entity", "-c", "/nonexistent/agent.json"], { from: "user" }),
  ).rejects.toThrow(/ENOENT|no such file/i);
  expect(makeContext).toHaveBeenCalled();
});

test("the refusal names the door and points at the two real ones", () => {
  const msg = legacyDoorRefusalMessage("cli create-entity");
  expect(msg).toMatch(/^cli create-entity cannot onboard/);
  expect(msg).toMatch(/POST \/onboard/);
  expect(msg).toMatch(/onboard_agent/);
});
