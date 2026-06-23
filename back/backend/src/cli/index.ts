import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { DemoResult } from "../agent/demo";
import { buildLiveAgentRunner } from "../agent/liveRunner";
import { toJobView } from "../api/jobViews";
import { loadConfig } from "../config/env";
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
        fundAmount: opts.fund ? usdToUnits(opts.fund) : undefined,
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

  program
    .command("fund-treasury")
    .argument("<key>", "idempotency key")
    .argument("<usd>", "USDC amount")
    .action(async (key, usd) => {
      const ctx = await makeContext();
      const rec = ctx.repo.findByIdempotencyKey(key);
      if (!rec?.treasury || !rec.treasuryConfig)
        throw new Error(`entity ${key} has no treasury yet`);
      const txHash = await ctx.arc.fundTreasury({
        usdc: rec.treasuryConfig.usdc,
        treasury: rec.treasury,
        amount: usdToUnits(usd),
      });
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
