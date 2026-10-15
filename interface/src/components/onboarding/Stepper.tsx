"use client";

import type { ReactNode } from "react";
import type { Phase } from "./types";
import { CheckIcon, cx } from "./primitives";

/** Generic over the phase id, so another flow with its own phases can use the same rail. */
type Props<P extends string> = {
  /** The phases THIS deployment shows — not the full list. A deployment that forms no entities
   *  has no legal-identity step, and a rail advertising one would be describing another box. */
  phases: { id: P; label: string }[];
  current: P;
  done: Record<string, boolean>;
  onJump: (phase: P) => void;
  /** The rail's heading; the wizard's by default. */
  heading?: ReactNode;
  /** The note under the rail; the wizard's by default. */
  footer?: ReactNode;
};

const DEFAULT_FOOTER = (
  <>
    <span className="text-muted">Guardian controlled.</span> SIWE sign-in,
    passkey ceremony, and one guardian transaction per allowlist address.
    Treasury funding needs no user signature.
  </>
);

export function Stepper<P extends string = Phase>({
  phases,
  current,
  done,
  onJump,
  heading = "Create your agent",
  footer = DEFAULT_FOOTER,
}: Props<P>) {
  const currentIndex = phases.findIndex((p) => p.id === current);

  return (
    <nav aria-label="Onboarding progress">
      <div className="mb-5 text-[11px] uppercase tracking-[0.2em] text-muted-2">
        {heading}
      </div>
      <ol className="flex flex-col gap-1">
        {phases.map((p, i) => {
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
                  {isDone ? <CheckIcon className="h-3.5 w-3.5" /> : i + 1}
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
        {footer}
      </div>
    </nav>
  );
}
