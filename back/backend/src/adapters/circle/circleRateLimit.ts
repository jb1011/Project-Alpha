import type { CircleWalletsApi } from "./circleWallets";

/**
 * Global Circle-API rate limiter (spec 2026-08-03, audit item 6). Circle's per-key limit is a
 * shared ~5-10 rps across the WHOLE platform, and several entities can bridge/sign concurrently
 * (the keyed mutex is per-entity, not global). This wrapper spaces the START of every API call by
 * a minimum interval, process-wide, so a burst of concurrent agents degrades to a queue instead of
 * a 429 storm. Individual calls stay concurrent-safe: only the start times are serialized; the
 * HTTP round-trips themselves overlap freely.
 */
const ALL_METHODS: (keyof CircleWalletsApi)[] = [
  "createWallets",
  "signTypedData",
  "signMessage",
  "createContractExecutionTransaction",
  "getTransaction",
];

export const DEFAULT_MIN_INTERVAL_MS = 200; // ~5 rps

export function withCircleRateLimit(
  api: CircleWalletsApi,
  opts: {
    minIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): CircleWalletsApi {
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let nextSlot = 0; // earliest time the next call may start
  let queue: Promise<void> = Promise.resolve();

  /** Reserve the next start slot; resolves when this call may begin. */
  const acquire = (): Promise<void> => {
    const granted = queue.then(async () => {
      const wait = nextSlot - now();
      nextSlot = Math.max(nextSlot, now()) + minIntervalMs;
      if (wait > 0) await sleep(wait);
    });
    queue = granted.then(
      () => undefined,
      () => undefined,
    );
    return granted;
  };

  // PROXY, not `{...api}` (P3 leg-1 catch, same class of bug as withCircleOpsLog): a spread of a
  // class instance drops prototype methods. Listed methods get the limiter; anything else passes
  // through bound — a future interface addition can never be silently dropped.
  return new Proxy(api, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") return original;
      if (!(ALL_METHODS as string[]).includes(prop as string)) return original.bind(target);
      return async (input: unknown) => {
        await acquire();
        return (original as (i: unknown) => Promise<unknown>).call(target, input);
      };
    },
  });
}
