// Live connectivity probe against a real World environment (sandbox/staging/production).
//
// Opt-in only:  WORLD_LIVE=1 DOTENV_CONFIG_PATH=.env.sandbox npx vitest run test/world/worldHandshake.live.test.ts
//
// WHY: the whole World suite runs hermetically (stubs + captured fixtures), which the
// expires_at_min near-miss proved is not enough by itself — real World behavior can drift from
// our understanding and only real calls catch it. This probe is the automated half of the
// sandbox runbook (docs/runbooks/world-sandbox-testing.md): it proves the WASM initializes in
// Node, the rp signature is accepted, and the request-creation API answers — everything short of
// the human scan. It creates a request and STOPS: no pollUntilCompletion (a floating 5-minute
// poll would keep the test process alive), no verification, nothing to clean up server-side
// (requests simply expire).
import "dotenv/config";
import { IDKit, proofOfHuman } from "@worldcoin/idkit-core";
import { describe, expect, test } from "vitest";
import { ensureNodeWasmFetch, makeRpContext } from "../../src/adapters/worldid/guardianGate";

const RUN = process.env.WORLD_LIVE === "1";

describe.skipIf(!RUN)("World live handshake (opt-in, WORLD_LIVE=1)", () => {
  test("request creation succeeds against the configured environment", async () => {
    const { WORLD_APP_ID, WORLD_RP_ID, WORLD_RP_SIGNING_KEY } = process.env;
    // Loud, not skipped: if you asked for the live probe, missing config is a failure you
    // want to see, not a silent green.
    if (!WORLD_APP_ID || !WORLD_RP_ID || !WORLD_RP_SIGNING_KEY)
      throw new Error(
        "WORLD_LIVE=1 but WORLD_APP_ID / WORLD_RP_ID / WORLD_RP_SIGNING_KEY are not set — " +
          "point DOTENV_CONFIG_PATH at a filled .env.sandbox (see docs/runbooks/world-sandbox-testing.md)",
      );

    const environment = (process.env.WORLD_ENVIRONMENT ?? "sandbox") as
      | "production"
      | "staging"
      | "sandbox";
    const cfg = {
      appId: WORLD_APP_ID,
      rpId: WORLD_RP_ID,
      rpSigningKey: WORLD_RP_SIGNING_KEY,
      action: process.env.WORLD_ACTION ?? "guardian-sandbox",
      environment,
    };

    ensureNodeWasmFetch();
    const request = await IDKit.request({
      app_id: cfg.appId,
      action: cfg.action,
      rp_context: makeRpContext(cfg),
      allow_legacy_proofs: true,
      environment: cfg.environment,
      // biome-ignore lint/suspicious/noExplicitAny: SDK request config typing is loose across versions.
    } as any).preset(proofOfHuman({ signal: "live-handshake-probe" }));

    // A requestId + connector URI back means: WASM up, rp signature accepted, API reachable.
    expect(request.requestId).toBeTruthy();
    expect(typeof request.connectorURI).toBe("string");
    expect(request.connectorURI.length).toBeGreaterThan(0);
    console.log(
      `  ✓ ${environment} handshake OK — requestId ${request.requestId} (action ${cfg.action})`,
    );
  }, 30_000);
});
