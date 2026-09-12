/**
 * Operator tool: register a legal body's ERC-8004 identity on Hedera testnet and store its UAID.
 *
 * WHY THIS EXISTS. A legal body's Hedera identity is one `register(metadataURI)` call against the
 * ERC-8004 IdentityRegistry, plus the HCS-14 UAID derived from the same entity's public facts
 * (design D10). Both have to be written to the row that the public `/verify` surface answers
 * from, so doing this by hand from a console is exactly the way the chain and the database end up
 * disagreeing. This script does the pair, or neither.
 *
 * FOUR MODES, because the registration and the database write happen in different places (D28):
 *   --entity <name|key>   read the row from the LOCAL database, register, write the row back
 *   --all-entities        the same for every eligible row; refuses without --execute --yes
 *   --from-prod <publicId>  read the entity from PROD's public endpoints, register, and PRINT the
 *                         --record line to run on the box — no local database is opened at all,
 *                         because under D28 the local database never holds the prod rows
 *   --record --entity <id> --agent-id <n> --tx <hash> --uaid <uaid>
 *                         write those three values to the local row, no chain call — this is the
 *                         half of --from-prod that has to run ON the box
 *
 * DRY RUN BY DEFAULT. Without --execute nothing is signed and no key is even read; the script
 * prints the metadata URI it would register and the UAID it would derive. A dry run is the
 * intended way to check a UAID against the served one before spending HBAR.
 *
 * SECRETS. `HEDERA_JSON_RPC_URL` and `HEDERA_OPERATOR_KEY` are read from `process.env` only, only
 * when --execute is passed, and the key is never printed, logged or included in an error message.
 * Run it under 1Password: `op run --env-file=.env.register.tpl -- npx tsx scripts/…`.
 *
 * The registry address is the `HEDERA_IDENTITY_REGISTRY` constant, deliberately not configurable
 * (audit C3): see `src/hedera/registry.ts`.
 *
 *   npx tsx scripts/hedera-register-identity.mts --entity FormationE2E_1
 *   npx tsx scripts/hedera-register-identity.mts --from-prod <publicId> --execute
 *   npx tsx scripts/hedera-register-identity.mts --record --entity <id> --agent-id 12 --tx 0x… --uaid uaid:aid:…
 *
 * `dotenv` is loaded inside `main()` rather than as a top-level import (the one deviation from
 * `scripts/sweep-standing-float.mts`'s header): this module is imported by
 * `test/hedera/registerIdentity.test.ts` for its pure helpers, and an import-time `.env` load
 * would make the suite's behaviour depend on an untracked developer file.
 */
import { pathToFileURL } from "node:url";
import { http, type Chain, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config/env";
import { HEDERA_IDENTITY_REGISTRY, registerOnHedera } from "../src/hedera/registry";
import { deriveUaid, uaidInputsFor } from "../src/hedera/uaid";
import { migrate, openDatabase } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import type { EntityRecord, Hex } from "../src/types";

/** Prod's public API root (naming table, D28). The only host `--from-prod` may ever read. */
const PROD_BASE = "https://www.novicorpus.com/backend";
const PROD_HOST = "www.novicorpus.com";
/** Hedera testnet, the only network this plan touches (global constraint: testnet only). */
const HEDERA_CHAIN_ID = 296;
const HASHSCAN = "https://hashscan.io/testnet/transaction";
/** `ARC_CHAIN_ID`'s value on prod, and the chain id the golden UAID vector is pinned to. It is a
 *  default only for `--from-prod`, which must not call `loadConfig()`; every local-database mode
 *  takes the chain id from the config it already loaded. */
const DEFAULT_ARC_CHAIN_ID = 5042002;

// ── Pure helpers (exported for test/hedera/registerIdentity.test.ts) ───────────────────────────

/** One entity as prod's two public endpoints describe it. */
export interface ProdEntity {
  publicId: string;
  name: string;
  agentId: string;
  treasury: string;
  legalManager: string | null;
  /** The metadata URI to register: prod's own metadata URL for this entity, which is also the
   *  URI already published on Arc for it. */
  metadataURI: string;
  /** The `legalBody` block of the served metadata, printed for the operator to eyeball before
   *  spending HBAR. Null when the served JSON carries no such block. */
  legalBody: Record<string, unknown> | null;
}

/**
 * Refuses any URL that is not on prod. `--from-prod` builds every URL from `PROD_BASE`, so this
 * can only fire if that constant is edited: it is here so that an edit which points the script at
 * a staging or local host fails loudly instead of registering a real on-chain identity for an
 * entity read out of the wrong place.
 */
export function assertProdHost(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== PROD_HOST) {
    throw new Error(`refusing ${url}: --from-prod reads only https://${PROD_HOST}`);
  }
}

/**
 * Reads one entity from prod's public, unauthenticated endpoints: `/transparency` for the name,
 * the Arc agent id and the treasury, and `/metadata/:publicId` to confirm the metadata URI
 * actually resolves before it is written on-chain forever. Nothing here needs a key or a database.
 */
export async function fetchProdEntity(
  publicId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProdEntity> {
  const transparencyUrl = `${PROD_BASE}/transparency`;
  assertProdHost(transparencyUrl);
  const listRes = await fetchImpl(transparencyUrl);
  if (!listRes.ok) throw new Error(`failed to read ${transparencyUrl}: HTTP ${listRes.status}`);
  const list = (await listRes.json()) as {
    entities?: Array<{
      publicId?: string | null;
      name?: string | null;
      agentId?: string | null;
      treasury?: string | null;
      legalManager?: string | null;
    }>;
  };
  const row = list.entities?.find((e) => e.publicId === publicId);
  if (!row) throw new Error(`${publicId} is not listed on ${transparencyUrl}`);
  if (!row.name || !row.agentId) {
    throw new Error(`${publicId} has no name or agent id on ${transparencyUrl}`);
  }
  if (!row.treasury) {
    // The treasury IS the UAID's native id (D10); without it there is no identity to derive.
    throw new Error(`${publicId} has no treasury on ${transparencyUrl}`);
  }

  const metadataURI = `${PROD_BASE}/metadata/${publicId}`;
  assertProdHost(metadataURI);
  const metaRes = await fetchImpl(metadataURI);
  if (!metaRes.ok) throw new Error(`failed to read ${metadataURI}: HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as { legalBody?: Record<string, unknown> };
  const legalBody = meta.legalBody && typeof meta.legalBody === "object" ? meta.legalBody : null;

  return {
    publicId,
    name: row.name,
    agentId: row.agentId,
    treasury: row.treasury,
    legalManager: row.legalManager ?? null,
    metadataURI,
    legalBody,
  };
}

/**
 * The UAID for an entity read from prod, derived through exactly the functions the server uses
 * (`uaidInputsFor` + `deriveUaid`), so the script and `/verify` cannot disagree. `uaidInputsFor`
 * reads only `name` and `treasury` off the record, which is all prod publishes.
 */
export function uaidForProdEntity(p: ProdEntity, chainId: number): string {
  const input = uaidInputsFor({ name: p.name, treasury: p.treasury } as EntityRecord, chainId);
  return deriveUaid(input, { uid: p.agentId });
}

/** The `--record` line to run on the box, printed verbatim after a `--from-prod` registration. */
export function recordCommandLine(o: {
  entity: string;
  agentId: string;
  txHash: string;
  uaid: string;
}): string {
  return `--record --entity ${o.entity} --agent-id ${o.agentId} --tx ${o.txHash} --uaid ${o.uaid}`;
}

/**
 * Resolves `--entity <id>` against the local rows by idempotency key, then public id, then name.
 * Name is last and is the only ambiguous one, so two rows sharing a name throw rather than let
 * the script register an identity for whichever row happened to be first.
 */
export function resolveEntity(rows: EntityRecord[], target: string): EntityRecord {
  const byKey = rows.find((r) => r.idempotencyKey === target);
  if (byKey) return byKey;
  const byPublicId = rows.find((r) => r.publicId === target);
  if (byPublicId) return byPublicId;
  const byName = rows.filter((r) => r.name === target);
  if (byName.length > 1) {
    throw new Error(
      `ambiguous entity "${target}": ${byName.length} rows share that name — pass the idempotency key`,
    );
  }
  const only = byName[0];
  if (!only) throw new Error(`no such entity: ${target}`);
  return only;
}

// ── Argument parsing ──────────────────────────────────────────────────────────────────────────

const USAGE = [
  "usage:",
  "  hedera-register-identity.mts --entity <name|key> [--entity …] [--execute]",
  "  hedera-register-identity.mts --all-entities --execute --yes",
  "  hedera-register-identity.mts --from-prod <publicId> [--from-prod …] [--execute]",
  "  hedera-register-identity.mts --record --entity <id> --agent-id <n> --tx <hash> --uaid <uaid>",
].join("\n");

function usageAndExit(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function values(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) usageAndExit(`${flag} needs a value`);
    out.push(v);
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  // The NAME only — an error here must never carry the value, because one of these is a key.
  if (!v) usageAndExit(`${name} is not set (run under: op run --env-file=.env.register.tpl -- …)`);
  return v;
}

// ── Chain wiring ──────────────────────────────────────────────────────────────────────────────

const hederaTestnet = (rpc: string): Chain => ({
  id: HEDERA_CHAIN_ID,
  name: "hedera-testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});

/** Builds the pair of clients `registerOnHedera` needs. Only called under --execute, so a dry run
 *  never touches `HEDERA_OPERATOR_KEY` at all. */
function hederaClients() {
  const rpc = requireEnv("HEDERA_JSON_RPC_URL");
  const key = requireEnv("HEDERA_OPERATOR_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    usageAndExit("HEDERA_OPERATOR_KEY must be 0x followed by 64 hex characters");
  }
  const chain = hederaTestnet(rpc);
  const account = privateKeyToAccount(key as Hex);
  return {
    publicClient: createPublicClient({ chain, transport: http(rpc) }),
    walletClient: createWalletClient({ account, chain, transport: http(rpc) }),
    operator: account.address,
  };
}

// ── Modes ─────────────────────────────────────────────────────────────────────────────────────

/** `--from-prod`: prod's public endpoints in, an on-chain identity and a `--record` line out.
 *  Deliberately never calls `loadConfig()` and never opens a database (D28). */
async function runFromProd(publicIds: string[], execute: boolean): Promise<void> {
  const chainId = Number(process.env.ARC_CHAIN_ID ?? DEFAULT_ARC_CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    usageAndExit(`ARC_CHAIN_ID is not a chain id: ${process.env.ARC_CHAIN_ID}`);
  }
  const clients = execute ? hederaClients() : null;
  if (clients) console.log(`operator ${clients.operator}  registry ${HEDERA_IDENTITY_REGISTRY}\n`);

  for (const publicId of publicIds) {
    const p = await fetchProdEntity(publicId);
    const uaid = uaidForProdEntity(p, chainId);
    console.log(`── ${p.name} ─────────────────────────────────`);
    console.log(`   publicId    ${p.publicId}`);
    console.log(`   agentId     ${p.agentId} (Arc, chain ${chainId})`);
    console.log(`   treasury    ${p.treasury}`);
    console.log(`   metadataURI ${p.metadataURI}`);
    console.log(`   legalBody   ${p.legalBody ? JSON.stringify(p.legalBody) : "(none served)"}`);
    console.log(`   uaid        ${uaid}`);

    if (!clients) {
      console.log("   (dry run — nothing sent)\n");
      continue;
    }
    assertProdHost(p.metadataURI);
    const { agentId, txHash } = await registerOnHedera({
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      registry: HEDERA_IDENTITY_REGISTRY,
      metadataURI: p.metadataURI,
    });
    console.log(`   registered agentId=${agentId} tx=${txHash} uaid=${uaid}`);
    console.log(`   ${HASHSCAN}/${txHash}`);
    // The public id, not the name: it is the one identifier guaranteed to resolve to exactly one
    // row when this line is run on the box.
    console.log(
      `   run on the box: ${recordCommandLine({ entity: p.publicId, agentId, txHash, uaid })}\n`,
    );
  }
}

/** `--record`: write the three values to the local row. No chain call, no key, no network. */
function runRecord(argv: string[]): void {
  const entities = values(argv, "--entity");
  // One registration, one row. Silently taking the first of several --entity flags would write
  // one entity's on-chain identity onto whichever row happened to be listed first.
  if (entities.length > 1) usageAndExit("--record takes exactly one --entity");
  const target = entities[0];
  const agentId = values(argv, "--agent-id")[0];
  const txHash = values(argv, "--tx")[0];
  const uaid = values(argv, "--uaid")[0];
  if (!target || !agentId || !txHash || !uaid) {
    usageAndExit("--record needs --entity, --agent-id, --tx and --uaid");
  }
  if (!/^\d+$/.test(agentId)) usageAndExit(`--agent-id must be a decimal agent id: ${agentId}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) usageAndExit(`--tx must be a 32-byte hash: ${txHash}`);
  if (!uaid.startsWith("uaid:aid:")) usageAndExit(`--uaid must be a uaid:aid: UAID: ${uaid}`);

  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const rec = resolveEntity(repo.list(), target);
  repo.setHederaIdentity(rec.idempotencyKey, { agentId, registerTx: txHash, uaid });
  db.close();
  console.log(`recorded ${rec.name}: hederaAgentId=${agentId} tx=${txHash}`);
  console.log(`  uaid ${uaid}`);
}

/** `--entity` / `--all-entities`: the local database is both the source and the destination. */
async function runLocal(o: {
  targets: string[];
  all: boolean;
  execute: boolean;
  yes: boolean;
}): Promise<void> {
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const rows = repo.list();

  let selected: EntityRecord[];
  if (o.all) {
    selected = rows.filter((r) => r.metadataURI && !r.hederaAgentId);
    // The count goes out BEFORE the refusal: the operator's first question is always "how many
    // entities is this about", and on prod the answer includes other tenants' rows (audit C17).
    console.log(
      `--all-entities: ${selected.length} of ${rows.length} rows are eligible (have a metadata URI, no Hedera agent id yet)`,
    );
    if (!(o.execute && o.yes)) {
      usageAndExit("--all-entities refuses to run without both --execute and --yes");
    }
  } else {
    selected = o.targets.map((t) => resolveEntity(rows, t));
  }

  const clients = o.execute ? hederaClients() : null;
  console.log(`mode: ${o.execute ? "EXECUTE (registers on Hedera)" : "DRY RUN (no writes)"}\n`);

  for (const rec of selected) {
    console.log(`── ${rec.name} ─────────────────────────────────`);
    if (!rec.metadataURI) {
      console.log("   skipped: no metadataURI on the row\n");
      process.exitCode = 1;
      continue;
    }
    if (rec.hederaAgentId) {
      console.log(`   skipped: already registered, hederaAgentId=${rec.hederaAgentId}\n`);
      continue;
    }
    if (!rec.agentId) {
      console.log("   skipped: no Arc agent id, so the UAID has no uid\n");
      process.exitCode = 1;
      continue;
    }
    const uaid = deriveUaid(uaidInputsFor(rec, cfg.chainId), { uid: rec.agentId });
    console.log(`   metadataURI ${rec.metadataURI}`);
    console.log(`   uaid        ${uaid}`);

    if (!clients) {
      console.log("   (dry run — nothing sent)\n");
      continue;
    }
    const { agentId, txHash } = await registerOnHedera({
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      registry: HEDERA_IDENTITY_REGISTRY,
      metadataURI: rec.metadataURI,
    });
    repo.setHederaIdentity(rec.idempotencyKey, { agentId, registerTx: txHash, uaid });
    console.log(`   registered agentId=${agentId} tx=${txHash} uaid=${uaid}`);
    console.log(`   ${HASHSCAN}/${txHash}`);
    console.log(
      `   run on the box: ${recordCommandLine({ entity: rec.publicId ?? rec.idempotencyKey, agentId, txHash, uaid })}\n`,
    );
  }
  db.close();
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const yes = argv.includes("--yes");
  const record = argv.includes("--record");
  const all = argv.includes("--all-entities");
  const targets = values(argv, "--entity");
  const fromProd = values(argv, "--from-prod");

  if (fromProd.length > 0) {
    if (record || all || targets.length > 0) {
      usageAndExit("--from-prod cannot be combined with --record, --all-entities or --entity");
    }
    // No loadConfig(), no database: under D28 the local database never holds the prod rows.
    await runFromProd(fromProd, execute);
    return;
  }

  // Everything below reads the LOCAL database, so it needs the config for dbPath and chainId.
  const { default: dotenv } = await import("dotenv");
  dotenv.config();

  if (record) {
    if (all) usageAndExit("--record cannot be combined with --all-entities");
    runRecord(argv);
    return;
  }
  if (!all && targets.length === 0) usageAndExit("nothing to do");
  if (all && targets.length > 0) usageAndExit("--all-entities cannot be combined with --entity");
  await runLocal({ targets, all, execute, yes });
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
