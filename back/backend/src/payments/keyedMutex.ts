const chains = new Map<string, Promise<unknown>>();

/** Serialize async work per key within this process. Single-process only (single-VPS/SQLite);
 *  a multi-process deployment would need an on-chain/db lock — superseded by Tier-0 batching. */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => fn(),
    () => fn(),
  ); // run regardless of the prior task's outcome
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  ); // stored tail never rejects
  return run;
}
