/**
 * A step's lifetime, for what a click starts and what goes on after it: the work after an await
 * (the wallet, a receipt, a request) and a timer. Both go on only while the step is on screen.
 * Once it is gone, every timer still waiting is cleared, none is set any more, and a timer whose
 * clear did not take runs nothing, so nothing is sent or read for a person who has left.
 *
 * The step marks itself on screen in its effect (`begin`, again after StrictMode's simulated
 * unmount) and gone in that effect's cleanup (`end`); a click's continuation asks `alive()` after
 * every await. The timers come in as two functions, so the rule has a test without a clock.
 */

/** Setting and clearing a timer: the browser's by default. */
export type Timers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const BROWSER_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type StepLifetime = {
  /** Whether the step is on screen: asked after every await of a click's continuation. */
  alive: () => boolean;
  /** The step is on screen: from its effect. */
  begin: () => void;
  /** The step is gone: every waiting timer is cleared, and none is set from now on. */
  end: () => void;
  /** `run` after `ms`, only while the step is on screen. False, with nothing set, once it is
   *  gone. */
  later: (run: () => void, ms: number) => boolean;
};

export function stepLifetime(timers: Timers = BROWSER_TIMERS): StepLifetime {
  let alive = true;
  const waiting = new Set<unknown>();
  return {
    alive: () => alive,
    begin: () => {
      alive = true;
    },
    end: () => {
      alive = false;
      for (const handle of waiting) timers.clear(handle);
      waiting.clear();
    },
    later: (run, ms) => {
      if (!alive) return false;
      const handle: unknown = timers.set(() => {
        waiting.delete(handle);
        if (alive) run();
      }, ms);
      waiting.add(handle);
      return true;
    },
  };
}
