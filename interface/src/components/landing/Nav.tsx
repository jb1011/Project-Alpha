"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  getAuthSessionSnapshot,
  subscribeAuthSession,
} from "@/lib/api/config";
import { CREATE_COMPANY_CTA, CREATE_SHORT_CTA } from "./copy";
import { Wordmark } from "./Wordmark";

export function Nav() {
  const session = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionSnapshot,
    () => null,
  );
  const signedIn = Boolean(session?.token);

  return (
    <header className="sticky top-0 z-50 anim-nav-drop">
      <div className="absolute inset-0 -z-10 backdrop-blur-md bg-paper/75 border-b hairline" />
      <nav className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-3 px-6 lg:px-10">
        <Wordmark className="min-w-0 shrink" />

        <div className="flex shrink-0 items-center gap-2">
          {signedIn ? (
            <Link
              href="/agents"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-accent/35 bg-accent/[0.08] px-3.5 py-2 text-[13px] text-accent-soft transition-colors hover:bg-accent/[0.15] hover:text-ink"
            >
              <span
                aria-hidden
                className="relative inline-block h-1.5 w-1.5 rounded-full bg-accent anim-pulse-dot"
              />
              <span>My agents</span>
            </Link>
          ) : (
            <Link
              href="/agents"
              className="inline-flex items-center whitespace-nowrap rounded-full border hairline-strong px-3.5 py-2 text-[13px] text-ink transition-colors hover:bg-paper-2"
            >
              Log in
            </Link>
          )}
          <Link
            href="/onboarding"
            aria-label={CREATE_COMPANY_CTA}
            className="group inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink-hover transition-colors"
          >
            <span className="sm:hidden">{CREATE_SHORT_CTA}</span>
            <span className="hidden sm:inline">{CREATE_COMPANY_CTA}</span>
            <span
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </Link>
        </div>
      </nav>
    </header>
  );
}
