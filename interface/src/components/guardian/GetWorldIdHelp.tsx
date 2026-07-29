"use client";

import * as React from "react";
import { cx } from "@/components/onboarding/primitives";

/**
 * The path for someone who has no World ID yet.
 *
 * Guardian verification is enforced, so this is the difference between a dead end and a
 * conversion: without it, scanning the QR sends people to World's generic download page with no
 * idea why Novi Corpus asked, and no way back. Present but quiet — a disclosure under the
 * action, not a banner competing with it.
 */
export function GetWorldIdHelp({
  className,
  defaultOpen = false,
}: {
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-[12px] text-muted-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <Chevron open={open} />
        Don&apos;t have a World ID?
      </button>

      {open && (
        <div className="flex flex-col gap-3 rounded-xl border hairline bg-paper/50 px-4 py-3.5 text-[12.5px] leading-[1.6] text-muted">
          {/* The legal "why" is already stated directly above this on both surfaces — repeating
              it here would be the third time on one screen. Lead with the how. */}
          <p className="text-[12px] text-muted-2">Two ways to get one:</p>

          <div className="flex flex-col gap-2.5">
            <Route
              title="Tap your passport in World App"
              detail="No Orb needed. Install World App, open World ID, and add a passport credential by tapping your phone to your passport."
              href="https://support.world.org/hc/en-us/articles/34408020222099-What-are-World-ID-Credentials-and-how-do-I-use-them"
              linkLabel="Supported passports"
            />
            <Route
              title="Or verify at an Orb"
              detail="A one-time in-person scan. Orbs are in most major cities."
              href="https://world.org/find-orb"
              linkLabel="Find an Orb"
            />
          </div>

          <p className="text-[11.5px] text-muted-2">
            Come back to this page once World App shows your World ID and tap Verify — we keep
            your place.
          </p>
        </div>
      )}
    </div>
  );
}

function Route({
  title,
  detail,
  href,
  linkLabel,
}: {
  title: string;
  detail: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-l hairline-strong pl-3">
      <span className="text-[12.5px] text-ink">{title}</span>
      <span>{detail}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="self-start text-[11.5px] text-accent-soft underline-offset-2 hover:underline"
      >
        {linkLabel} →
      </a>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cx("origin-center transition-transform", open && "rotate-90")}
      />
    </svg>
  );
}
