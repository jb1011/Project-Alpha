"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/landing/Wordmark";
import { cx } from "@/components/onboarding/primitives";

export function AgentShell({
  title,
  subtitle,
  entityId,
  children,
}: {
  title?: string;
  subtitle?: string;
  entityId?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70" />
      <header className="sticky top-0 z-40 border-b hairline bg-paper/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-4 px-5 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Wordmark />
            {title && (
              <div className="hidden min-w-0 sm:block">
                <div className="truncate text-[13px] font-medium text-ink">{title}</div>
                {subtitle && (
                  <div className="truncate text-[11px] text-muted-2">{subtitle}</div>
                )}
              </div>
            )}
          </div>
          <nav className="flex shrink-0 items-center gap-2">
            <NavLink href="/agents">My agents</NavLink>
            {entityId && (
              <>
                <NavLink href={`/agents/${encodeURIComponent(entityId)}`}>Dashboard</NavLink>
                <NavLink href={`/agents/${encodeURIComponent(entityId)}/settings`}>
                  Settings
                </NavLink>
              </>
            )}
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
      <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-8 lg:px-8">{children}</main>
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
