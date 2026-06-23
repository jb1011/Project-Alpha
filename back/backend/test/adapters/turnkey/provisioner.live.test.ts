// backend/test/adapters/turnkey/provisioner.live.test.ts
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildTurnkeyProvisionDeps } from "../../../src/adapters/turnkey/clients";
import { provisionAgentVault } from "../../../src/adapters/turnkey/provisioner";
import { loadConfig } from "../../../src/config/env";

const FIXTURE = fileURLToPath(
  new URL("../../fixtures/guardian-passkey.local.json", import.meta.url),
);

// loadConfig throws if required env is missing — tolerate that while deciding whether to gate.
const cfg = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();

const gated =
  process.env.LIVE_TURNKEY === "1" && existsSync(FIXTURE) && !!cfg?.turnkey?.delegatedApiPublicKey;

const run = gated ? describe : describe.skip;

// To run live: `npm run passkey:capture`, click the button, then
// `LIVE_TURNKEY=1 npx vitest run test/adapters/turnkey/provisioner.live.test.ts`
run("live Turnkey provisioning (creates a throwaway sub-org)", () => {
  test("provisionAgentVault returns guardian-root + sign-only delegated vault ids", async () => {
    const config = loadConfig();
    const deps = buildTurnkeyProvisionDeps(config);
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

    const ids = await provisionAgentVault(deps, {
      subOrgName: `live-test agent vault ${Date.now()}`,
      guardianPasskey: fixture,
      delegatedApiPublicKey: config.turnkey?.delegatedApiPublicKey ?? "",
    });

    expect(ids.subOrgId).toBeTruthy();
    expect(ids.walletId).toBeTruthy();
    expect(ids.guardianUserId).toBeTruthy();
    expect(ids.delegatedUserId).toBeTruthy();
    expect(ids.operator).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Read-back (belt-and-suspenders): the delegated client can see the wallet it will sign for.
    const wallets = await deps.makeDelegatedClient(ids.subOrgId).getWallets({
      organizationId: ids.subOrgId,
    });
    const found = wallets.wallets.find((w: { walletId: string }) => w.walletId === ids.walletId);
    expect(found).toBeTruthy();
  }, 60_000);
});
