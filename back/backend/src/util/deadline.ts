/**
 * ONE wall-clock deadline for outbound calls.
 *
 * Every adapter that talks to a remote host makes its calls while the caller usually holds the
 * per-entity keyed lock, and a dropped TCP connection with no RST never resolves — so an
 * unbounded call does not merely hang one request, it wedges the whole entity's mutex chain
 * (Circle review M1, doola design §5). This helper is the single implementation of that bound;
 * copies drift, and a drifted copy is a silent regression of exactly that property.
 *
 * Two deliberate properties:
 *
 *  - **The work is a FUNCTION of an `AbortSignal`, not a started promise.** A timer that only
 *    rejects the wrapper leaves the underlying request running (and its socket held) until the
 *    OS gives up. Handing the signal in lets `fetch` — and any body read layered on top of it —
 *    actually be cancelled when the deadline fires. Callers that cannot take a signal (SDKs)
 *    simply ignore the argument and still get the rejection bound.
 *  - **A real timer, deliberately unref'd.** Not an injectable sleep: an instantly-resolving
 *    fake must never fake-time-out an instantly-resolving fake call. `unref()` keeps a pending
 *    deadline from holding the process (or a test worker) open.
 */

/** Thrown when no caller-supplied error factory is given. Adapters pass their own typed error. */
export class DeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`operation did not complete within ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Run `work` under a `ms` wall-clock deadline. On expiry the signal is ABORTED and the returned
 * promise rejects with `onTimeout()` (or `DeadlineExceededError`).
 *
 * The deadline covers everything `work` awaits — which is the point at the call sites: an HTTP
 * call is not "done" when the response headers arrive, it is done when its body has been read.
 */
export function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  onTimeout?: () => Error,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        // Abort FIRST: the rejection is what the caller sees, but the cancellation is what frees
        // the socket. Reversing these leaves a rejected caller and a live connection.
        controller.abort();
        reject(onTimeout ? onTimeout() : new DeadlineExceededError(ms));
      },
      Math.max(ms, 1),
    );
    (timer as { unref?: () => void }).unref?.();

    let started: Promise<T>;
    try {
      started = work(controller.signal);
    } catch (e) {
      // A synchronous throw inside `work` must not leave the timer armed.
      clearTimeout(timer);
      reject(e);
      return;
    }
    started.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
