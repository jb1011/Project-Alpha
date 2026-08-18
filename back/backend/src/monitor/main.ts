import "dotenv/config";
import type { Address } from "viem";
import { legalManagerFactoryAbi } from "../abis/generated";
import { managerAccount, publicClientFor } from "../adapters/arc/clients";
import { loadConfig } from "../config/env";
import { opsLog } from "../observability/opsLog";
import { buildAlertSink } from "./alerts";
import { SqliteEntityLookup } from "./entityLookup";
import { MonitorConfigError } from "./errors";
import { Monitor } from "./monitor";
import { fromPublicClient } from "./rpc";
import { SqliteMonitorStore } from "./store";

/**
 * `npm run monitor` — the NoviController watcher (design §8, a DEPLOY PREREQUISITE).
 *
 * Composition root, in the shape of api/main.ts: everything is built here and injected, so the
 * loop, the rules and the sinks are all testable without a chain, a webhook or a real database.
 *
 * What this process is NOT: it builds no WalletClient, signs nothing and sends no transaction. It
 * reads the chain, reads legalbody.db READ-ONLY, writes only its own monitor.db, and shouts.
 *
 * It does read the platform key's ADDRESS (`managerAccount(cfg).address`) — the executor identity.
 * That is needed to tell the seven permanent standing grants apart from a break-glass grant that
 * outlived its ceremony; without it rule 2 would either page forever on the standing set or go
 * blind on grants to an attacker's address. The key material never leaves this function.
 */
async function main() {
  const cfg = loadConfig();

  if (!cfg.controllerAddress)
    throw new MonitorConfigError(
      "CONTROLLER_ADDRESS is required to run the monitor — this watcher exists to observe the NoviController, and a deployment with no controller has nothing for it to watch (start it on the box AFTER the controller cutover, with the same .env as the API)",
    );
  const monitorCfg = cfg.monitor;
  if (!monitorCfg)
    throw new MonitorConfigError("monitor config missing from loadConfig — this is a bug");

  const publicClient = publicClientFor(cfg);
  const rpc = fromPublicClient(publicClient);

  // The configured factory is always watched; MONITOR_WATCH_FACTORIES adds the legacy one, which
  // still owns every pre-cutover agent's creation path.
  const factories: Address[] = [
    ...(cfg.factoryAddress ? [cfg.factoryAddress] : []),
    ...monitorCfg.watchFactories,
  ].filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);

  const store = SqliteMonitorStore.open(monitorCfg.dbPath);
  const entities = new SqliteEntityLookup(cfg.dbPath);
  const sink = buildAlertSink({ store, webhookUrl: cfg.alertWebhookUrl });

  const monitor = new Monitor({
    rpc,
    store,
    entities,
    sink,
    beaconSource: cfg.factoryAddress,
    readBeacon: async (factory) =>
      (await publicClient.readContract({
        address: factory,
        abi: legalManagerFactoryAbi,
        functionName: "beacon",
      })) as Address,
    cfg: {
      controller: cfg.controllerAddress,
      registry: cfg.identityRegistry,
      factories,
      beacons: monitorCfg.watchBeacons,
      executor: managerAccount(cfg).address as Address,
      pollMs: monitorCfg.pollSec * 1000,
      grantTtlMs: monitorCfg.grantTtlMin * 60_000,
      lookbackBlocks: monitorCfg.lookbackBlocks,
    },
  });

  // Addresses and knobs only — never the webhook URL (it is a bearer credential) and never a key.
  opsLog("monitor_start", {
    controller: cfg.controllerAddress,
    registry: cfg.identityRegistry,
    factories,
    extraBeacons: monitorCfg.watchBeacons,
    pollSec: monitorCfg.pollSec,
    grantTtlMin: monitorCfg.grantTtlMin,
    lookbackBlocks: monitorCfg.lookbackBlocks,
    webhook: cfg.alertWebhookUrl ? "configured" : "none",
    monitorDb: monitorCfg.dbPath,
  });

  const shutdown = (signal: string) => {
    opsLog("monitor_stop", { signal });
    monitor.stop();
    store.close();
    entities.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  monitor.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
