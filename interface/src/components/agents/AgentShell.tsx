"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { GuardianBadge } from "@/components/guardian/GuardianBadge";
import { Wordmark } from "@/components/landing/Wordmark";
import { cx } from "@/components/onboarding/primitives";

export function AgentShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70"
      />
      <header className="sticky top-0 z-40 border-b hairline bg-paper/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-4 px-5 lg:px-8">
          <div className="flex shrink-0 items-center gap-4">
            <Wordmark />
          </div>
          {/* Scrolls rather than forcing the page wider than the viewport on narrow screens. */}
          <nav className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-x-auto [&>*]:shrink-0">
            <NavLink href="/agents">My agents</NavLink>
            <NavLink href="/agents/account">Account</NavLink>
            <NavLink href="/agents/connect">Connect an agent</NavLink>
            <GuardianBadge />
            {/* Agent-scoped navigation (Dashboard/Settings) lives beside the agent's name on its
                own pages — the shell nav stays account-level. */}
            <Link
              href="/onboarding?new=1"
              className="rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-hover"
            >
              New agent
            </Link>
            <Link
              href="/"
              className="rounded-full px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
            >
              Home
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-8 lg:px-8">
        {children}
      </main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "rounded-full px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-paper-2 hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
