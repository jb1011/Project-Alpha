import type { Address } from "viem";
import { agentTreasuryAbi } from "../abis/generated";
import { opsLog } from "../observability/opsLog";
import type { AlertSink } from "./alerts";
import type { EntityIndex, EntityLookup, MonitoredEntity } from "./entityLookup";
import { indexEntities } from "./entityLookup";
import { standingRoles } from "./events";
import type { MonitorRpc } from "./rpc";
import { type GrantOp, type RuleContext, evaluateLog, ttlEscalations } from "./rules";
import {
  MAX_LOG_RANGE,
  chunkRange,
  coldStartFrom,
  fetchWindow,
  isRangeTooLargeError,
  shrinkRange,
} from "./scan";
import type { MonitorStore } from "./store";

/**
 * The watcher loop.
 *
 * One invariant governs everything here: THE MONITOR MUST NOT STOP. A watcher that dies on a
 * transient RPC error produces the same observable output as a chain where nothing happened, which
 * is the worst possible failure mode for a security control. So every tick is wrapped, every
 * partial failure degrades a rule rather than the process, and the cursor only advances over
 * blocks that were actually scanned — a failed chunk is re-read on the next tick (the alert dedup
 * key makes that free).
 */

export interface MonitorConfig {
  controller: Address;
  registry: Address;
  /** Configured factory first; extras from MONITOR_WATCH_FACTORIES. */
  factories: Address[];
  /** MONITOR_WATCH_BEACONS; the configured factory's own beacon is added at startup. */
  beacons: Address[];
  /** Address of the platform signing key (the executor identity). No key material here. */
  executor: Address;
  pollMs: number;
  grantTtlMs: number;
  lookbackBlocks: number;
  maxLogRange?: bigint;
}

export interface MonitorDeps {
  rpc: MonitorRpc;
  store: MonitorStore;
  entities: EntityLookup;
  sink: AlertSink;
  cfg: MonitorConfig;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** The factory whose `beacon()` is resolved lazily. Absent = nothing to resolve. */
  beaconSource?: Address;
  /** Injected for tests; production passes viem's `beacon()` read. */
  readBeacon?: (factory: Address) => Promise<Address>;
}

export class Monitor {
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  /** Adaptive: starts at the configured ceiling, halves whenever the RPC says the window is too
   *  wide. Different Arc endpoints enforce different limits (see scan.ts). */
  private currentRange: bigint;
  /** Beacons discovered from `factory.beacon()`, merged with the configured list. */
  private resolvedBeacons: Address[] = [];
  private beaconResolved = false;
  private lastEntities: MonitoredEntity[] = [];
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? opsLog;
    this.currentRange = deps.cfg.maxLogRange ?? MAX_LOG_RANGE;
  }

  /** The window size currently in use — exposed for tests and for the ops log. */
  logRange(): bigint {
    return this.currentRange;
  }

  /**
   * The configured factory's beacon is not an env var — it is a fact on the chain. Resolved once,
   * but RETRIED every tick until it succeeds: if the RPC was down at startup we must not silently
   * run forever with rule 6 disabled on the beacon that matters most.
   */
  private async ensureBeacon(): Promise<void> {
    if (this.beaconResolved || !this.deps.beaconSource || !this.deps.readBeacon) {
      this.beaconResolved = true;
      return;
    }
    try {
      const beacon = await this.deps.readBeacon(this.deps.beaconSource);
      this.resolvedBeacons = [beacon];
      this.beaconResolved = true;
      this.log("monitor_beacon_resolved", { factory: this.deps.beaconSource, beacon });
    } catch (err) {
      this.log("monitor_beacon_unresolved", {
        factory: this.deps.beaconSource,
        message: (err as Error).message,
      });
    }
  }

  /** Entities drive three rules. A lookup failure degrades those rules for one tick — the last
   *  known set is reused rather than dropped, so a locked DB does not blind the treasury watch. */
  private refreshEntities(): MonitoredEntity[] {
    try {
      this.lastEntities = this.deps.entities.all();
    } catch (err) {
      this.log("monitor_entity_lookup_failed", {
        message: (err as Error).message,
        usingCached: this.lastEntities.length,
      });
    }
    return this.lastEntities;
  }

  private buildContext(index: EntityIndex): RuleContext {
    const { cfg } = this.deps;
    return {
      controller: cfg.controller,
      registry: cfg.registry,
      factories: new Set(cfg.factories.map((a) => a.toLowerCase())),
      beacons: new Set([...cfg.beacons, ...this.resolvedBeacons].map((a) => a.toLowerCase())),
      executor: cfg.executor,
      standingRoles: standingRoles(),
      entities: index,
    };
  }

  /** One poll: resolve the beacon, refresh entities, scan new blocks, sweep grant TTLs. */
  async tick(): Promise<void> {
    await this.ensureBeacon();
    const entities = this.refreshEntities();
    const index = indexEntities(entities);
    const ctx = this.buildContext(index);

    await this.scan(ctx, index);
    await this.sweepGrantTtl();
  }

  private async scan(ctx: RuleContext, index: EntityIndex): Promise<void> {
    const { rpc, store, cfg } = this.deps;
    let latest: bigint;
    try {
      latest = await rpc.getBlockNumber();
    } catch (err) {
      this.log("monitor_head_read_failed", { message: (err as Error).message });
      return;
    }

    const cursor = store.getCursor();
    const from = cursor === undefined ? coldStartFrom(latest, cfg.lookbackBlocks) : cursor + 1n;
    if (from > latest) return; // no new blocks since the last tick.

    const own: Address[] = [
      cfg.controller,
      ...cfg.factories,
      ...cfg.beacons,
      ...this.resolvedBeacons,
      ...[...index.byTreasury.values()].map((e) => e.treasury as Address),
    ];
    const agentIds = [...index.byAgentId.keys()];

    for (const range of chunkRange(from, latest, this.currentRange)) {
      let logs: Awaited<ReturnType<typeof fetchWindow>>;
      try {
        logs = await fetchWindow(rpc, { own, registry: cfg.registry, agentIds }, range);
      } catch (err) {
        // "Window too wide" is not a chain problem, it is OUR request — shrink so the next tick
        // can actually make progress. Without this the monitor stays up, logs forever and never
        // advances its cursor, which looks exactly like a quiet chain.
        if (isRangeTooLargeError(err)) {
          const next = shrinkRange(this.currentRange);
          if (next === undefined) {
            this.log("monitor_range_floor_reached", {
              range: this.currentRange.toString(),
              message: (err as Error).message,
            });
          } else {
            this.currentRange = next;
            this.log("monitor_range_reduced", {
              range: next.toString(),
              reason: "rpc rejected the block range",
            });
          }
          return;
        }
        // Stop here, keep the cursor where it is: the next tick retries THIS chunk. Continuing to
        // the next chunk would advance past blocks we never read.
        this.log("monitor_scan_failed", {
          from: range.from.toString(),
          to: range.to.toString(),
          message: (err as Error).message,
        });
        return;
      }

      for (const log of logs) {
        try {
          const outcome = await evaluateLog(log, ctx, {
            now: this.now,
            currentPayout: (t) => this.readPayoutAddress(t),
          });
          const grants = await this.stampGrantTimestamps(outcome.grants);
          this.applyGrants(grants);
          for (const alert of outcome.alerts) await this.deps.sink.emit(alert);
        } catch (err) {
          // A single undecodable log must not abort the window; record it and move on.
          this.log("monitor_log_eval_failed", {
            tx: log.transactionHash,
            logIndex: log.logIndex,
            message: (err as Error).message,
          });
        }
      }

      store.setCursor(range.to);
    }
    this.log("monitor_scanned", {
      from: from.toString(),
      to: latest.toString(),
      watched: own.length,
      agents: agentIds.length,
      range: this.currentRange.toString(),
    });
  }

  /**
   * Replace the observation time on new grants with the BLOCK time. Matters after downtime: a
   * grant made 40 minutes ago must page immediately on restart, not 15 minutes after we noticed it.
   * One read per distinct block, and the observation time stands if the read fails.
   */
  private async stampGrantTimestamps(grants: readonly GrantOp[]): Promise<GrantOp[]> {
    const cache = new Map<string, number>();
    const out: GrantOp[] = [];
    for (const g of grants) {
      if (g.kind !== "open") {
        out.push(g);
        continue;
      }
      const key = g.block.toString();
      let ts = cache.get(key);
      if (ts === undefined) {
        try {
          ts = Number(await this.deps.rpc.getBlockTimestamp(g.block)) * 1000;
        } catch {
          ts = g.ts;
        }
        cache.set(key, ts);
      }
      out.push({ ...g, ts });
    }
    return out;
  }

  private applyGrants(grants: readonly GrantOp[]): void {
    for (const g of grants) {
      if (g.kind === "open")
        this.deps.store.openGrant({
          role: g.role,
          account: g.account,
          grantedAtBlock: g.block,
          grantedAtTs: g.ts,
        });
      else this.deps.store.closeGrant(g.role, g.account);
    }
  }

  private async readPayoutAddress(treasury: Address): Promise<Address | undefined> {
    try {
      return (await this.deps.rpc.readContract({
        address: treasury,
        abi: agentTreasuryAbi,
        functionName: "payoutAddress",
      })) as Address;
    } catch (err) {
      // Unreadable, not unchanged: the alert says "unreadable" and stays at WARN rather than
      // claiming the payout address is fine.
      this.log("monitor_payout_read_failed", { treasury, message: (err as Error).message });
      return undefined;
    }
  }

  private async sweepGrantTtl(): Promise<void> {
    const { store, cfg, sink } = this.deps;
    const escalations = ttlEscalations(
      store.listOpenGrants(),
      this.now(),
      cfg.grantTtlMs,
      cfg.controller,
    );
    for (const e of escalations) {
      await sink.emit(e.alert);
      store.setGrantAlertedCount(e.role, e.account, e.alertedCount);
    }
  }

  /** Poll forever. Each tick is fully guarded — the loop is scheduled again no matter what. */
  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        this.log("monitor_tick_failed", { message: (err as Error).message });
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.deps.cfg.pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
