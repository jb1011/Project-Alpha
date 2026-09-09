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

  // ── formation:reconcile — ASK THE CHAIN what happened to one payment (B1 gate A5) ─────────
  //
  // The manual counterpart to the sweeper's leg, for the row an operator is actually looking at.
  // It runs the SAME log-based resolver (`resolveAuthorizationOutcome`) and then drives the row
  // terminal from what it FOUND — never from what an operator believes.
  //
  // It PRINTS BEFORE IT WRITES, deliberately. This command exists for the situation where
  // somebody is deciding whether a guardian has paid, and a tool that silently flips a row and
  // says "done" gives them nothing to check.
  program
    .command("formation:reconcile")
    .argument("<paymentId>", "the payment to resolve against the chain")
    .description("resolve ONE formation payment from the token's own logs, and record the verdict")
    .action(async (paymentId: string) => {
      const { config: loadDotenv } = await import("dotenv");
      const { loadConfig } = await import("../config/env");
      const { publicClientFor } = await import("../adapters/arc/clients");
      const { resolveAuthorizationOutcome } = await import("../adapters/arc/usdcToken");
      const { openDatabase } = await import("../persistence/db");
      const { SqliteCompanyRepository } = await import("../persistence/companyRepository");
      const { SqliteFormationPaymentRepository } = await import(
        "../persistence/formationPaymentRepository"
      );
      const { guardianOf } = await import("../formation/payment");
      const { opsLog } = await import("../observability/opsLog");
      loadDotenv();
      const cfg = loadConfig();
      const db = openDatabase(cfg.dbPath);
      const payments = new SqliteFormationPaymentRepository(db);
      const companies = new SqliteCompanyRepository(db);

      const row = payments.find(paymentId);
      if (!row) throw new Error(`no payment ${paymentId}`);
      const company = companies.find(row.companyId);
      if (!company)
        throw new Error(
          `payment ${paymentId} names company ${row.companyId}, which does not exist`,
        );
      if (row.status !== "quoted" && row.status !== "settling")
        throw new Error(
          `payment ${paymentId} is already terminal (${row.status})${row.txHash ? ` at ${row.txHash}` : ""} — there is nothing to reconcile`,
        );

      const authorizer = row.payerAddress ?? guardianOf(company);
      const outcome = await resolveAuthorizationOutcome({
        client: publicClientFor(cfg),
        usdc: cfg.usdc,
        authorizer,
        nonce: row.nonce,
        payTo: row.payTo,
        value: row.amountUsdc,
        fromBlock: row.quotedBlock === null ? null : BigInt(row.quotedBlock),
      });
      console.log(
        [
          `payment   ${row.paymentId}  (${row.status})`,
          `company   ${row.companyId}  (${company.status})`,
          `amount    ${row.amountUsdc} atomic USDC -> ${row.payTo}`,
          `authorizer ${authorizer}  nonce ${row.nonce}`,
          `chain says ${outcome.kind}${"txHash" in outcome ? ` at ${outcome.txHash}` : ""}`,
        ].join("\n"),
      );

      if (outcome.kind === "settled") {
        // The observed hash, not ours: whoever broadcast it, the money is at the payee.
        const moved = db.transaction(() => {
          const ok = payments.markSettled(row.paymentId, outcome.txHash);
          if (ok) companies.setStatus(row.companyId, "draft", "ready");
          return ok;
        })();
        if (!moved && row.status !== "settling")
          throw new Error(
            "the chain says settled, but this row is `quoted` — it never reached `settling`, so there is no CAS to make. Investigate before touching it by hand",
          );
        opsLog("formation_payment_settled", {
          companyId: row.companyId,
          paymentId: row.paymentId,
          amountUsdc: row.amountUsdc.toString(),
          txHash: outcome.txHash,
          by: "operator-reconcile",
        });
        console.log(`recorded: settled at ${outcome.txHash}`);
        if (payments.countPaid(row.companyId) > 1)
          console.error(
            `⚠ CRITICAL: company ${row.companyId} now has more than one PAID formation payment. See docs/runbooks/doola-deploy.md (manual refund).`,
          );
        return;
      }
      if (outcome.kind === "cancelled") {
        payments.markExpired(row.paymentId, row.status);
        opsLog("formation_payment_expired", {
          companyId: row.companyId,
          paymentId: row.paymentId,
          reason: "cancelled-on-chain",
          by: "operator-reconcile",
        });
        console.log("recorded: expired (the authorization was cancelled on-chain)");
        return;
      }
      // UNKNOWN. Nothing is written: a payment whose outcome nobody can see is exactly the one
      // that must not be written off, and the row stays where it is for the sweeper to re-try.
      console.log(
        "nothing recorded: the chain shows no AuthorizationUsed and no AuthorizationCanceled for this nonce in the window. The row stays as it is — an outcome we cannot see is never a failure.",
      );
    });

  // ── formation:refund — RECORD a refund the Ledger already made (design 2026-08-26 §6.6) ────
  //
  // ⚠ IT MOVES NOTHING, AND THAT IS THE FEATURE. `FORMATION_REVENUE_ADDRESS` is a Ledger
  // hardware-wallet account with NO KEY ON THIS BOX (the S4 key inventory says so in as many
  // words), so a refund is signed by a human at the device, by runbook, and this command is how
  // the system learns it happened. A refund path that could move funds would need a hot float
  // holding real revenue on a server, which is exactly what the Ledger decision refuses.
  //
  // ⚠ AND IT NEVER TOUCHES `platform_outflows`. A 399 USDC row in the S5 meter would exceed the
  // 200 USDC rolling ceiling on its own and block every agent's treasury funding, gas seeds and
  // job funding for 24 hours — a refund taking the fleet down. `formation_refund` joins
  // `OutflowPath` only in the later hot-float phase, together with an env invariant that the
  // ceiling is at least the fee.
  //
  // ⚠ IT NAMES THE PAYMENT, NOT THE COMPANY (B1 gate A5). The first cut took a companyId and
  // refunded "the most recent settled row", which is precisely the wrong default for the case
  // this command is FOR: a company with two settled rows is the double charge, and picking one
  // by date is a guess made silently, at a Ledger, about somebody's 399 USDC.
  program
    .command("formation:refund")
    .requiredOption("--payment-id <paymentId>", "the SETTLED payment being refunded")
    .requiredOption("--tx <hash>", "the on-chain hash of the transfer signed from the Ledger")
    .option("--yes", "confirm: record this refund")
    .description("RECORD (never execute) a refund of a settled formation payment")
    .action(async (opts: { paymentId: string; tx: string; yes?: boolean }) => {
      const { config: loadDotenv } = await import("dotenv");
      const { loadConfig } = await import("../config/env");
      const { openDatabase } = await import("../persistence/db");
      const { SqliteFormationPaymentRepository } = await import(
        "../persistence/formationPaymentRepository"
      );
      const { opsLog } = await import("../observability/opsLog");
      loadDotenv();
      // `loadConfig().dbPath`, like every other DB-only command here: there is no DB_PATH knob,
      // and an operator who moved DATA_DIR must not silently open a different, empty database.
      const db = openDatabase(loadConfig().dbPath);
      const payments = new SqliteFormationPaymentRepository(db);

      // A malformed hash is not a small mistake here: it is the ONLY pointer we will ever hold to
      // the money that moved, and it is written once. A truncated paste that reads plausibly is
      // the failure this refuses.
      if (!/^0x[0-9a-fA-F]{64}$/.test(opts.tx))
        throw new Error(
          `refusing: "${opts.tx}" is not a 32-byte transaction hash (0x + 64 hex). That hash is the only record of the transfer you just signed`,
        );

      const row = payments.find(opts.paymentId);
      if (!row) throw new Error(`no payment ${opts.paymentId}`);
      if (row.status === "refunded")
        throw new Error(
          `refusing: payment ${row.paymentId} is ALREADY recorded as refunded (tx ${row.refundTxHash}). A second recording would overwrite the only pointer we hold to the money that moved`,
        );
      if (row.status !== "settled")
        throw new Error(
          `refusing: payment ${row.paymentId} is ${row.status}, not settled — a refund records money that was actually taken. If you believe it settled, run \`formation:reconcile ${row.paymentId}\` first and let the chain say so`,
        );

      console.log(
        [
          `payment   ${row.paymentId}`,
          `company   ${row.companyId}`,
          `amount    ${row.amountUsdc} atomic USDC  ($${Number(row.amountUsdc) / 1e6})`,
          `paid by   ${row.payerAddress}`,
          `settled   ${row.txHash}`,
          `refund tx ${opts.tx}`,
        ].join("\n"),
      );
      if (!opts.yes) {
        console.log("\nNothing recorded. Re-run with --yes to record this refund.");
        return;
      }

      if (!payments.markRefunded(row.paymentId, opts.tx))
        throw new Error(
          `refusing: payment ${row.paymentId} is not settled, or already carries a refund hash. A second recording would overwrite the only pointer we hold to the money that moved`,
        );
      opsLog("formation_payment_refunded", {
        severity: "CRITICAL",
        level: "warn",
        companyId: row.companyId,
        paymentId: row.paymentId,
        amountUsdc: row.amountUsdc.toString(),
        settledTxHash: row.txHash,
        refundTxHash: opts.tx,
        by: "operator",
      });
      console.log(
        `\nrecorded refund of ${row.amountUsdc} atomic USDC for payment ${row.paymentId} (tx ${opts.tx}). Nothing was moved by this command.`,
      );
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
