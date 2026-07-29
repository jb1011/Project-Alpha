/**
 * W7.2 GATE — capture the REAL Identity Check verify response before writing any parser.
 *
 * The v4 response shape for attested attributes is the one genuinely unknown surface in W7:
 * World's demo says the backend "accepts when proof verifies and identity_attested is true",
 * but the per-attribute result shape is undocumented for us. Guessing it is how you get a parser
 * that passes its own tests and fails on the first real scan. So: run one real request, dump the
 * raw response, and write the parser against THAT.
 *
 *   npx tsx --env-file=.env scripts/world-attest-probe.mts
 *
 * Requires WORLD_ATTEST_ACTION to be set (the portal action, e.g. guardian-attest).
 * Writes test/world/fixtures/attest-verify-response.json (gitignored until reviewed — it is a
 * real response for a real human; check it for anything identifying before committing).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { IDKit, identityCheck } from "@worldcoin/idkit-core";
// qrcode ships no bundled types (transitive dep, reused for the booth QR).
// @ts-expect-error -- no types
import QRCodeUntyped from "qrcode";
import { ensureNodeWasmFetch, makeRpContext } from "../src/adapters/worldid/guardianGate";

const QRCode = QRCodeUntyped as unknown as {
  toString(text: string, opts: { type: string; small?: boolean }): Promise<string>;
};

const OUT = "test/world/fixtures/attest-verify-response.json";
const VERIFY_HOST = "https://developer.world.org";

// Read the World slice straight from the environment rather than loadConfig(): a probe has no
// business demanding unrelated secrets (PLATFORM_PRIVATE_KEY et al) that aren't in a dev .env.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required in .env for this probe`);
  return v;
}
const w = {
  appId: need("WORLD_APP_ID"),
  rpId: need("WORLD_RP_ID"),
  rpSigningKey: need("WORLD_RP_SIGNING_KEY"),
  environment: (process.env.WORLD_ENVIRONMENT ?? "production") as
    | "production"
    | "staging"
    | "sandbox",
  attestMinAge: Number(process.env.WORLD_ATTEST_MIN_AGE ?? 18),
};
const action = process.env.WORLD_ATTEST_ACTION;
if (!action) throw new Error("Set WORLD_ATTEST_ACTION (e.g. guardian-attest) in .env first.");

const signal = process.env.SIGNAL ?? "0x0000000000000000000000000000000000000001";

// idkit-core's WASM loader fetches a file:// URL, which Node's fetch rejects. Same shim the API
// server uses; without it .preset() throws "Failed to initialize IDKit WASM".
ensureNodeWasmFetch();

console.log(`\n=== Identity Check probe — action "${action}" (${w.environment}) ===\n`);
console.log(`Requesting: minimum_age >= ${w.attestMinAge}, issuing_country`);
console.log(`Signal (tenant): ${signal}\n`);

// FINDING (2026-07-25): IdentityAttribute is an ASSERTION, not a disclosure request. A first run
// with `{type:"issuing_country", value:""}` came back `identity_attributes_not_matched` — it had
// asserted "country equals empty string", which nothing satisfies. There is no "tell me the
// value" form here (enumerate/all/any are CREDENTIAL combinators for .constraints(), not
// attributes). So we can prove a threshold like age, but we cannot LEARN the issuing country.
const attributes = [{ type: "minimum_age", value: w.attestMinAge }];

const request = await IDKit.request({
  app_id: w.appId,
  action,
  rp_context: makeRpContext(
    {
      appId: w.appId,
      rpId: w.rpId,
      rpSigningKey: w.rpSigningKey,
      action,
      environment: w.environment,
    },
    action,
  ),
  allow_legacy_proofs: false,
  environment: w.environment,
  // biome-ignore lint/suspicious/noExplicitAny: SDK request config typing is loose across versions.
} as any)
  // biome-ignore lint/suspicious/noExplicitAny: attribute union is narrower than what we probe with.
  .preset(identityCheck({ attributes: attributes as any, legacy_signal: signal }));

console.log(await QRCode.toString(request.connectorURI, { type: "terminal", small: true }));
console.log(`\nScan with World App, or open: ${request.connectorURI}\n`);
console.log("Waiting for approval…\n");

const outcome = await request.pollUntilCompletion({
  timeout: Number(process.env.TIMEOUT_MS ?? 8 * 60_000),
});
if (!outcome?.success) {
  console.error("Request did not complete:", JSON.stringify(outcome, null, 2));
  process.exit(1);
}

console.log("Approved. Forwarding to the verify endpoint AS-IS…\n");
const res = await fetch(`${VERIFY_HOST}/api/v4/verify/${w.rpId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(outcome.result),
});
const body = await res.json().catch(() => ({ parseError: true }));

const fixture = {
  capturedFor: { action, environment: w.environment, minAge: w.attestMinAge },
  httpStatus: res.status,
  // The IDKit result we forwarded — the parser reads expires_at_min / issuer_schema_id from it.
  idkitResult: outcome.result,
  verifyResponse: body,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(body, null, 2));
console.log(`\n✓ Written to ${OUT}`);
console.log("Review it for anything identifying before committing.\n");
