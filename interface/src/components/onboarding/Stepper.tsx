"use client";

import * as React from "react";
import { Phase, PHASES } from "./types";
import { CheckIcon, cx } from "./primitives";

type Props = {
  current: Phase;
  done: Record<string, boolean>;
  onJump: (phase: Phase) => void;
};

export function Stepper({ current, done, onJump }: Props) {
  const currentIndex = PHASES.findIndex((p) => p.id === current);

  return (
    <nav aria-label="Onboarding progress">
      <div className="mb-5 text-[11px] uppercase tracking-[0.2em] text-muted-2">
        Create your agent
      </div>
      <ol className="flex flex-col gap-1">
        {PHASES.map((p, i) => {
          const isCurrent = p.id === current;
          const isDone = !!done[p.id];
          const isReachable = isDone || i < currentIndex;
          const state = isCurrent ? "current" : isDone ? "done" : "upcoming";

          return (
            <li key={p.id} className="relative">
              <button
                type="button"
                disabled={!isReachable && !isCurrent}
                onClick={() => isReachable && onJump(p.id)}
                className={cx(
                  "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                  isReachable && !isCurrent && "hover:bg-paper-2/70",
                  !isReachable && !isCurrent && "cursor-default",
                )}
              >
                <span
                  className={cx(
                    "relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors",
                    state === "current" &&
                      "border-accent bg-accent/15 text-accent-soft",
                    state === "done" && "border-accent/50 bg-accent text-paper",
                    state === "upcoming" &&
                      "hairline-strong bg-paper text-muted-2",
                  )}
                >
                  {isDone ? <CheckIcon className="h-3.5 w-3.5" /> : p.n}
                </span>
                <span className="flex flex-col">
                  <span
                    className={cx(
                      "text-[13px] leading-tight transition-colors",
                      isCurrent
                        ? "text-ink"
                        : isDone
                          ? "text-muted"
                          : "text-muted-2",
                    )}
                  >
                    {p.label}
                  </span>
                  {isCurrent && (
                    <span className="mt-0.5 text-[10.5px] uppercase tracking-[0.14em] text-accent-soft/80">
                      In progress
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-7 rounded-xl hairline bg-paper-2/40 px-3.5 py-3 text-[11.5px] leading-[1.5] text-muted-2">
        <span className="text-muted">Non-custodial.</span> You sign only twice —
        your passkey and your funding transfer. Everything else is automated.
      </div>
    </nav>
  );
}
