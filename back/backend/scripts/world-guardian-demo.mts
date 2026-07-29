/**
 * GUARDIAN PROOF-OF-PERSONHOOD — live, re-runnable demo (World).
 *
 * Runs the REAL World ID flow end to end: opens a verification request, prints a QR code
 * (scan it with World App), polls the bridge, forwards the proof to World's v4 verify
 * endpoint, enforces our credential tier, and stores the nullifier under our sybil gate.
 *
 * Safe to re-run any number of times — the state is a persistent SQLite file, so repeat runs
 * demonstrate the interesting behaviour:
 *   · same human, same tenant   -> idempotent re-verify (allowed)
 *   · same human, NEW tenant    -> refused: one human cannot back two accounts (sybil gate)
 *   · entity cap                -> reported after each verification
 *
 *   cd back/backend && npx tsx --env-file=.env scripts/world-guardian-demo.mts
 *
 * Options (env):
 *   TENANT=0x…      the guardian's wallet (default: the ENS owner wallet in .env)
 *   RESET=1         wipe the demo DB first (fresh "never verified" state for a clean demo)
 *   DEMO_DB=path    demo database file (default ./data/world-guardian-demo.db)
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
// qrcode ships no bundled types (it's a transitive dep we reuse for the booth QR).
// @ts-ignore -- untyped module, we call exactly one function
import QRCodeUntyped from "qrcode";
import { privateKeyToAccount } from "viem/accounts";
const QRCode = QRCodeUntyped as unknown as {
  toString(text: string, opts: { type: string; small?: boolean }): Promise<string>;
};
import {
  type WorldIdConfig,
  type WorldIdError,
  startGuardianVerification,
  verifyProof,
} from "../src/adapters/worldid/guardianGate";
import { migrate } from "../src/persistence/db";
import { SqliteWorldStore } from "../src/persistence/worldStore";

const DB_PATH = process.env.DEMO_DB ?? "./data/world-guardian-demo.db";
const MAX_ENTITIES = Number(process.env.WORLD_MAX_ENTITIES_PER_HUMAN ?? 3);

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const C = "\x1b[36m";
const X = "\x1b[0m";
const line = (s = "") => console.log(s);
const rule = (t: string) => {
  line();
  line(`${B}${t}${X}`);
  line(D + "─".repeat(Math.min(t.length, 62)) + X);
};

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`\n${R}✗ ${k} is not set in back/backend/.env${X}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const cfg: WorldIdConfig = {
    appId: requireEnv("WORLD_APP_ID"),
    rpId: requireEnv("WORLD_RP_ID"),
    rpSigningKey: requireEnv("WORLD_RP_SIGNING_KEY"),
    action: process.env.WORLD_ACTION ?? "guardian-verification",
    environment: (process.env.WORLD_ENVIRONMENT ?? "production") as WorldIdConfig["environment"],
  };

  // The guardian's wallet — bound into the proof as its `signal`, so a captured proof can't be
  // replayed for a different account.
  const tenant =
    process.env.TENANT ??
    (process.env.ENS_OWNER_KEY
      ? privateKeyToAccount(process.env.ENS_OWNER_KEY as `0x${string}`).address
      : "0x8ffA18f05056458dbFB2f7A122F185878B2d6e2f");

  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (process.env.RESET === "1") {
    const { rmSync } = await import("node:fs");
    rmSync(DB_PATH, { force: true });
    line(`${D}(reset: demo database cleared)${X}`);
  }
  const db = new Database(DB_PATH);
  migrate(db);
  const store = new SqliteWorldStore(db);

  line();
  line(`${B}${C}╔══════════════════════════════════════════════════════════╗${X}`);
  line(`${B}${C}║   NOVI CORPUS — GUARDIAN PROOF OF PERSONHOOD (World ID)  ║${X}`);
  line(`${B}${C}╚══════════════════════════════════════════════════════════╝${X}`);
  line(`${D}app ${cfg.appId}  ·  action ${cfg.action}  ·  ${cfg.environment}${X}`);
  line(`${D}guardian wallet ${tenant}${X}`);

  // Prior state — makes re-runs tell a story.
  const prior = store.findByTenant(tenant, cfg.action);
  rule("CURRENT STATE");
  if (prior) {
    line(`  ${G}✓${X} this wallet already has a verified guardian`);
    line(
      `    credential ${B}${prior.credential}${X}  ·  verified ${new Date(prior.verifiedAt).toISOString()}`,
    );
    line(
      `    legal entities used: ${store.countEntitiesForNullifier(prior.nullifier, cfg.action)} / ${MAX_ENTITIES}`,
    );
    line(`  ${D}re-verifying is idempotent — the same human keeps the same binding${X}`);
  } else {
    line(`  ${Y}○${X} no verified guardian yet — this wallet cannot form a legal entity`);
  }

  // ── open the real World ID request ─────────────────────────────────────────────────────────
  rule("1 · REQUEST");
  const started = await startGuardianVerification(cfg, tenant);
  line(`  ${D}request ${started.requestId}${X}`);
  line();
  line(await QRCode.toString(started.connectorURI, { type: "terminal", small: true }));
  line(`  ${B}Scan with World App${X} — or open:`);
  line(`  ${C}${started.connectorURI}${X}`);
  line();
  line(`  ${D}the guardian's wallet is bound into the proof, so it can't be reused elsewhere${X}`);
  line(`  ${D}waiting (up to 5 min)…${X}`);

  // ── wait for the human ─────────────────────────────────────────────────────────────────────
  const outcome = await started.completion;
  rule("2 · PROOF RECEIVED");
  if (!outcome?.success) {
    line(`  ${R}✗ not completed:${X} ${JSON.stringify(outcome?.error ?? "unknown")}`);
    line(`  ${D}(cancelled in World App, or the request timed out)${X}`);
    process.exit(1);
  }
  line(`  ${G}✓${X} World App returned a proof`);

  // ── verify with World, enforce our tier ────────────────────────────────────────────────────
  rule("3 · VERIFY (World Developer Portal)");
  let proof: Awaited<ReturnType<typeof verifyProof>>;
  try {
    proof = await verifyProof(cfg, outcome.result, tenant);
  } catch (e) {
    const err = e as WorldIdError;
    line(`  ${R}✗ rejected:${X} ${err.code ?? ""} ${err.message}`);
    process.exit(1);
  }
  line(`  ${G}✓${X} proof verified by World`);
  line(
    `    credential      ${B}${proof.credential}${X}  ${D}(Orb-grade or document tier — device/selfie are refused)${X}`,
  );
  line(`    nullifier       ${D}${proof.nullifier.slice(0, 18)}…${X}`);
  line(`    ${D}the nullifier is the ONLY identity datum we keep: unique per human,${X}`);
  line(`    ${D}meaningless to any other app, and it never identifies anyone.${X}`);

  // ── our gate: sybil check + cap ────────────────────────────────────────────────────────────
  rule("4 · BIND TO THE LEGAL BODY (Novi Corpus)");
  const existing = store.findByNullifier(proof.nullifier, cfg.action);
  if (existing && existing.tenantId !== tenant) {
    line(`  ${R}✗ REFUSED — sybil gate${X}`);
    line(`    this human is already the guardian of ${D}${existing.tenantId}${X}`);
    line("    one human cannot quietly back two separate accounts.");
    process.exit(0);
  }
  store.recordVerification({
    nullifier: proof.nullifier,
    action: cfg.action,
    tenantId: tenant,
    issuerSchemaId: proof.issuerSchemaId,
    credential: proof.credential,
    environment: proof.environment,
    verifiedAt: Date.now(),
    expiresAtMin: proof.expiresAtMin,
  });
  const used = store.countEntitiesForNullifier(proof.nullifier, cfg.action);
  line(`  ${G}✓${X} guardian bound to ${B}${tenant}${X}`);
  line(
    `    legal entities: ${used} / ${MAX_ENTITIES}  ${D}(one human, a capped number of companies)${X}`,
  );
  line(
    `    ${existing ? `${D}re-verification of the same human — binding unchanged${X}` : `${G}new guardian registered${X}`}`,
  );

  rule("RESULT");
  line(`  ${G}✓${X} A real, unique human is now accountable for this account.`);
  line(`  ${G}✓${X} They may form up to ${MAX_ENTITIES} legal entities — no more.`);
  line(`  ${G}✓${X} Every agent under them inherits a named, reachable controller`);
  line("      with power to pause, claw back, and dissolve.");
  line();
  line(`  ${D}re-run:  npx tsx --env-file=.env scripts/world-guardian-demo.mts${X}`);
  line(`  ${D}fresh:   RESET=1 npx tsx --env-file=.env scripts/world-guardian-demo.mts${X}`);
  line(
    `  ${D}sybil:   TENANT=0x0000000000000000000000000000000000000B0B npx tsx … (same human, new wallet)${X}`,
  );
  line();
}

main().catch((e) => {
  console.error(`\n${R}✗ demo failed:${X}`, e?.shortMessage ?? e?.message ?? String(e));
  process.exit(1);
});
