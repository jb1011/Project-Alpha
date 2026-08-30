import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { privateKeyToAccount } from "viem/accounts";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import type { DemoResult } from "../agent/demo";
import { buildLiveAgentRunner } from "../agent/liveRunner";
import { toJobView } from "../api/jobViews";
import { loadConfig } from "../config/env";
import { legacyDoorRefusalMessage, legacyDoorRefused } from "../formation";
import { parseAgentSpec } from "../policy/agentSpec";
import { usdToUnits } from "../policy/units";
import { runOnboarding } from "../workflow/onboarding";
import { type CliContext, buildContext } from "./context";

/** Deps that can be injected for testing — bypasses live Anthropic + chain calls. */
export interface AgentDeps {
  runDemo: (query: string) => Promise<DemoResult>;
}

/** Build the commander program. `makeContext` is injectable so tests pass an anvil-backed context. */
export function buildCli(
  makeContext: () => CliContext | Promise<CliContext> = buildContext,
  agentDeps?: AgentDeps,
): Command {
  const program = new Command();
  program.name("legalbody").description("Onboard AI agents into on-chain legal bodies on Arc");

  program
    .command("create-entity")
    .requiredOption("-c, --config <path>", "agent.json path")
    .option("-i, --id <key>", "idempotency key (defaults to the agent name)")
    .option("-f, --fund <usd>", "optional: fund the treasury with this many USDC")
    .action(async (opts) => {
      const ctx = await makeContext();
      // Door 4 (design §5): the CLI is a separate process on the same DB with no `partyId` and
      // no PII intake, so on a deployment where formation is MANDATORY it refuses at COMMAND
      // time rather than minting an entity that owes a filing it can never make.
      if (legacyDoorRefused(ctx.cfg)) throw new Error(legacyDoorRefusalMessage());
      const spec = parseAgentSpec(JSON.parse(readFileSync(opts.config, "utf8")));
      const idempotencyKey = opts.id ?? spec.name;
      const rec = await runOnboarding({
        spec,
        idempotencyKey,
        repo: ctx.repo,
        docStore: ctx.docStore,
        arc: ctx.arc,
        operatorSigner: ctx.operatorSigner,
        usdc: ctx.cfg.usdc,
        metadataBaseUrl: ctx.cfg.metadataBaseUrl,
        fundAmount: opts.fund ? usdToUnits(opts.fund) : undefined,
        // Carried from PR 1: a CLI-created entity records its v1 anchor cycle like every other
        // one. Without it `oa_anchors` has no baseline for this entity, and the monotonic rules
        // ("schedule/execute only when version > the anchored one") plus the monitor's
        // "any execute of a non-current version is CRITICAL" both read that table.
        anchors: ctx.anchors,
        // Audit item 7 (review L4): CLI-created rows must also store their pocket address at
        // creation, or their read paths re-open the master-seed dependency.
        derivePocketAddress: ctx.cfg.pocketMasterSeed
          ? (entityKey) =>
              privateKeyToAccount(derivePocketKey(ctx.cfg.pocketMasterSeed!, entityKey)).address
          : undefined,
        // Formation (design §2/§5, C5): NOT wired, and that is now a statement rather than an
        // omission. An entity is pinned iff a formation party is bound to it, and this door has
        // no way to carry a partyId — so an entity it mints is a stub, on every deployment.
        // `legacyDoorRefused` is what stops it minting one at all where formation is mandatory.
      });
      console.log(
        JSON.stringify(
          {
            idempotencyKey,
            status: rec.status,
            agentId: rec.agentId,
            proxy: rec.proxy,
            treasury: rec.treasury,
          },
          null,
          2,
        ),
      );
    });

  program
    .command("get-entity")
    .argument("<idOrKey>", "agentId or idempotency key")
    .action(async (idOrKey) => {
      const ctx = await makeContext();
      const rec = ctx.repo.findByAgentId(idOrKey) ?? ctx.repo.findByIdempotencyKey(idOrKey);
      if (!rec) {
        console.error(`not found: ${idOrKey}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    });

  program.command("list-entities").action(async () => {
    const ctx = await makeContext();
    const rows = ctx.repo
      .list()
      .map((r) => ({ key: r.idempotencyKey, name: r.name, status: r.status, agentId: r.agentId }));
    console.log(JSON.stringify(rows, null, 2));
  });

  /**
   * The operator's exit from an anchor HOLD (design §7, audit H4 — review F10).
   *
   * Two cycle states park an entity's WHOLE anchor pipeline until a human acts: `vetoed` (the
   * guardian stopped this manifest) and `failed` (its bytes no longer re-hash to the scheduled
   * anchor, or its manager call reverted deterministically until the attempts ran out). A veto can
   * also end on chain via `liftVeto`, which the loop observes by itself. This is the OTHER exit,
   * and until now it existed only as a repository method with no way to call it: an operator
   * looking at `anchor_held` in journald had to open sqlite and hand-write the UPDATE.
   *
   * It is deliberately per-version rather than per-entity: acknowledging a hold is a statement
   * about ONE manifest version ("that one is dead, move on"), and a blanket per-entity ack would
   * quietly clear a second hold nobody had looked at.
   */
  program
    .command("anchor-ack")
    .description("acknowledge a held OA anchor cycle so the entity's pipeline can resume")
    .argument("<entityKey>", "idempotency key")
    .argument("<version>", "manifest version of the held cycle")
    .action(async (entityKey: string, version: string) => {
      const ctx = await makeContext();
      const v = Number(version);
      const before = ctx.anchors.find(entityKey, v);
      if (!before) {
        console.error(`no anchor cycle ${entityKey} v${v}`);
        process.exitCode = 1;
        return;
      }
      const acknowledged = ctx.anchors.acknowledgeHold(entityKey, v);
      if (!acknowledged) process.exitCode = 1;
      console.log(
        JSON.stringify(
          {
            entityKey,
            version: v,
            acknowledged,
            was: before.state,
            now: ctx.anchors.find(entityKey, v)?.state,
            manifestHash: before.manifestHash,
            // The honest caveat, printed where the operator is looking: an acknowledgement is a
            // statement about OUR records. A scheduled amendment stays executable on chain
            // forever, and only the guardian can stop it.
            note: acknowledged
              ? "this version will never be anchored by us; if it is still scheduled on chain only the guardian can stop it"
              : "not a held cycle (only `vetoed` or `failed` can be acknowledged)",
          },
          null,
          2,
        ),
      );
    });

  program
    .command("fund-treasury")
    .argument("<key>", "idempotency key")
    .argument("<usd>", "USDC amount")
    .action(async (key, usd) => {
      const ctx = await makeContext();
      const rec = ctx.repo.findByIdempotencyKey(key);
      if (!rec?.treasury || !rec.treasuryConfig)
        throw new Error(`entity ${key} has no treasury yet`);
      // S5: the trusted operator keeps direct signing, but no path is unmetered — same
      // rolling-window brake and record as every other platform outflow (audit correction 4).
      const amount = usdToUnits(usd);
      ctx.outflows.check(amount);
      const txHash = await ctx.arc.fundTreasury({
        usdc: rec.treasuryConfig.usdc,
        treasury: rec.treasury,
        amount,
      });
      ctx.outflows.record("cli_fund", amount, txHash);
      ctx.repo.upsert({ ...rec, status: "funded", fundTxHash: txHash });
      console.log(JSON.stringify({ key, funded: usd, txHash }, null, 2));
    });

  program
    .command("run-job")
    .description("Run a new job for an entity and print the result as JSON")
    .requiredOption("-e, --entity <key>", "entity (idempotency) key")
    .option("-b, --budget <usd>", "budget in USD (default: 1.00)")
    .option("-d, --description <text>", "job description (default: demo job)")
    .action(async (opts) => {
      const ctx = await makeContext();
      const jobKey = `${opts.entity}:${Date.now()}-${randomUUID().slice(0, 8)}`;
      const rec = await ctx.jobDeps.runJob({
        jobKey,
        entityKey: opts.entity,
        budget: usdToUnits(opts.budget ?? "1.00"),
        description: opts.description ?? "demo job",
      });
      console.log(JSON.stringify(toJobView(rec), null, 2));
    });

  program
    .command("get-job")
    .description("Print a job record by jobKey")
    .argument("<jobKey>", "job key")
    .action(async (jobKey) => {
      const ctx = await makeContext();
      const rec = ctx.jobDeps.jobs.findByKey(jobKey);
      if (!rec) {
        console.error(`not found: ${jobKey}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(toJobView(rec), null, 2));
    });

  program
    .command("list-jobs")
    .description("List jobs; optionally filtered by entity key")
    .option("-e, --entity <key>", "filter by entity (idempotency) key")
    .action(async (opts) => {
      const ctx = await makeContext();
      const rows = opts.entity
        ? ctx.jobDeps.jobs.listByEntity(opts.entity)
        : ctx.jobDeps.jobs.list();
      console.log(JSON.stringify(rows.map(toJobView), null, 2));
    });

  program
    .command("agent")
    .description("Governed insight agent commands")
    .addCommand(
      new Command("ask")
        .argument("<query>", "natural-language query to send to the agent")
        .description("Run the governed insight agent: buy data, synthesize, price, report P&L")
        .action(async (query: string) => {
          const runner = agentDeps?.runDemo ?? (await buildLiveAgentRunner());
          const r = await runner(query);
          console.log(`\n=== answer ===\n${r.answer}`);
          console.log(
            "\npurchases:",
            r.purchases.map((p) => `${p.id} (${p.cost})`).join(", ") || "(none)",
          );
          if (r.denied.length)
            console.log("denied:", r.denied.map((x) => `${x.id}: ${x.reason}`).join(", "));
          console.log(`cost=${r.totalCost} price=${r.price} P&L=${r.pnl} (atomic USDC)`);
          const lr = r as Partial<import("../agent/liveRunner").LiveRunResult>;
          if (lr.fundingTxs?.length) console.log("funding txs:", lr.fundingTxs.join(", "));
          if (lr.settleTransferIds?.length)
            console.log("settled transfer ids:", lr.settleTransferIds.join(", "));
          if (lr.sold !== undefined)
            console.log(`sold=${lr.sold} customer=${lr.customer} vendorPayout=${lr.vendorPayout}`);
        }),
    );

  // ── Guardian waivers ─────────────────────────────────────────────────────────────────────────
  // DB-only on purpose: waiver admin must work on a box (or against a snapshot) without chain
  // config, so this path never goes through buildContext / FACTORY_ADDRESS.
  const openWorldStore = async () => {
    const { config: loadDotenv } = await import("dotenv");
    const { openDatabase, migrate } = await import("../persistence/db");
    const { SqliteWorldStore } = await import("../persistence/worldStore");
    loadDotenv();
    // Resolve the DB path without loadConfig(): full config validation demands chain keys this
    // command never touches (and local .envs post-P3 deliberately no longer carry them).
    const dbPath = process.env.DB_PATH ?? `${process.env.DATA_DIR ?? "./data"}/legalbody.db`;
    const db = openDatabase(dbPath);
    migrate(db);
    return new SqliteWorldStore(db);
  };

  const waiver = program
    .command("waiver")
    .description("Guardian waiver codes — the escape hatch for humans with no World ID path");

  waiver
    .command("create")
    .requiredOption(
      "-n, --note <who/why>",
      "audit note, e.g. 'FR colleague — no Orb/passport path'",
    )
    .option("-d, --days <n>", "expiry in days (default 14)", "14")
    .description("Issue a single-use waiver code (plaintext shown ONCE, only the hash is stored)")
    .action(async (opts) => {
      const store = await openWorldStore();
      const code = `nvw_${randomUUID().replaceAll("-", "")}`;
      store.createWaiver({
        codeHash: createHash("sha256").update(code).digest("hex"),
        note: opts.note,
        createdAt: Date.now(),
        expiresAt: Date.now() + Number(opts.days) * 86_400_000,
      });
      console.log(code);
      console.error(`(expires in ${opts.days} days; redeem with POST /world-id/waiver)`);
    });

  waiver
    .command("list")
    .description("List issued waivers (hashes only) and their redemption state")
    .action(async () => {
      const store = await openWorldStore();
      console.log(JSON.stringify(store.listWaivers(), null, 2));
    });

  waiver
    .command("revoke")
    .argument("<code-or-hash>", "the plaintext code or its sha256 hash")
    .description("Revoke an unredeemed waiver")
    .action(async (arg: string) => {
      const store = await openWorldStore();
      const hash = /^[0-9a-f]{64}$/.test(arg)
        ? arg
        : createHash("sha256").update(arg).digest("hex");
      const revoked = store.revokeWaiver(hash);
      console.log(revoked ? "revoked" : "not revoked (unknown or already redeemed)");
      if (!revoked) process.exitCode = 1;
    });

  // ── formation:abandon — the OPERATOR ESCAPE (design 2026-08-26 §2 step 1) ──────────────────
  //
  // The entity→company migration REFUSES to run while any `create_provider` row is non-terminal,
  // because re-keying a live create rotates its idempotency key and doola would file a SECOND
  // real Wyoming LLC. Most such rows clear themselves: the sweeper retries them and abandons them
  // at the attempt bound. One shape never does — a row parked on `key_reused` or on a lost answer
  // never burns an attempt, by design (C1), so a human-parked row would block the upgrade forever.
  // This is the deliberate, ops-logged act that clears it.
  //
  // It REFUSES when `provider_ref IS NOT NULL`: a create that reached doola is ADOPTED, never
  // abandoned by hand, and abandoning it is what would erase the responsible party's data for a
  // company that may really exist in Wyoming's records.
  //
  // DB-only, like the waiver commands, and deliberately WITHOUT `migrate()`: this command exists
  // to be run on a box whose migration is refusing, so running that migration first would be a
  // catch-22. It therefore speaks whichever schema it finds.
  program
    .command("formation:abandon")
    .argument("<entityKey>", "the entity whose create_provider row is parked (or its companyId)")
    .option("-r, --reason <text>", "why, for the ops trail", "operator abandon (pre-migration)")
    .description("Abandon a parked create_provider row so the company re-key can proceed")
    .action(async (key: string, opts: { reason: string }) => {
      const { config: loadDotenv } = await import("dotenv");
      const { loadConfig } = await import("../config/env");
      const { openDatabase } = await import("../persistence/db");
      const { SqliteCompanyRepository } = await import("../persistence/companyRepository");
      const { SqliteFormationRepository } = await import("../persistence/formationRepository");
      const { opsLog } = await import("../observability/opsLog");
      const { abandonFormation } = await import("../workflow/formationStep");
      loadDotenv();
      // `loadConfig().dbPath`, never `process.env.DB_PATH`: there is no DB_PATH knob. The config
      // derives the path from DATA_DIR, so an operator who moved the data directory would have
      // had this command open a DIFFERENT, empty database and report "no create_provider row"
      // about a formation that is sitting right there.
      const db = openDatabase(loadConfig().dbPath);

      // Whichever shape is on disk. Pre-migration the rows are keyed by entity; post-migration by
      // company, and the argument is resolved through `entities.company_id`.
      const cols = (
        db.prepare("PRAGMA table_info(formation_requests)").all() as { name: string }[]
      ).map((c) => c.name);
      const legacy = cols.includes("entity_key");
      const target = legacy
        ? key
        : ((
            db.prepare("SELECT company_id AS c FROM entities WHERE idempotency_key = ?").get(key) as
              | { c: string | null }
              | undefined
          )?.c ?? key);
      const column = legacy ? "entity_key" : "company_id";

      const row = db
        .prepare(
          `SELECT state, provider_ref AS providerRef FROM formation_requests
            WHERE ${column} = ? AND step = 'create_provider'`,
        )
        .get(target) as { state: string; providerRef: string | null } | undefined;
      if (!row) throw new Error(`no create_provider row for "${key}"`);
      if (row.providerRef)
        throw new Error(
          `refusing: create_provider for "${key}" holds doola company id ${row.providerRef}. A create that REACHED doola is adopted, never abandoned by hand — abandoning it would erase the responsible party's data for a company that may exist in Wyoming's records. Let the saga adopt it.`,
        );
      if (row.state === "abandoned") {
        console.log("already abandoned");
        return;
      }
      const reason = `operator abandon: ${opts.reason}`;
      // POST-migration this is the SAME domain function the sweeper's own terminal verdict uses:
      // one transaction, the step and the company together, `facts_updated_at` stamped. The two
      // raw UPDATEs it replaces ran outside any transaction and stamped nothing, so a crash
      // between them left a company `ready` — attachable and quota-chargeable — over an
      // abandoned create.
      //
      // The LEGACY branch stays a raw statement because it must: on a pre-migration box there is
      // no `companies` table and `formation_requests` has no `company_id`, so neither repository
      // can even be constructed, and this command exists precisely to be run there.
      const changed = legacy
        ? db
            .prepare(
              `UPDATE formation_requests
                  SET state = 'abandoned', error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE entity_key = ? AND step = 'create_provider' AND state = ?`,
            )
            .run(reason, target, row.state).changes === 1
        : abandonFormation(
            new SqliteFormationRepository(db),
            new SqliteCompanyRepository(db),
            target,
            reason,
            {
              transaction: (fn) => db.transaction(fn)(),
              from: row.state as "pending" | "submitted" | "failed",
            },
          );
      if (!changed) throw new Error("lost the race: the row moved, re-run to see its state");
      opsLog("formation_abandoned", {
        severity: "CRITICAL",
        level: "error",
        [legacy ? "entityKey" : "companyId"]: target,
        step: "create_provider",
        by: "operator",
        reason: opts.reason,
      });
      console.log(`abandoned create_provider for ${key}`);
    });

  return program;
}

// Entry point when run directly (tsx src/cli/index.ts ...).
if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli()
    .parseAsync(process.argv)
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
