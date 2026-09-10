"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/landing/Wordmark";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { cx } from "@/components/onboarding/primitives";
import { useWorldIdMeQuery } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/types";

export function AgentShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70"
      />
      <header className="sticky top-0 z-40 overflow-visible border-b hairline bg-paper/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-4 overflow-visible px-5 lg:px-8">
          <div className="flex shrink-0 items-center gap-4">
            <Wordmark />
          </div>
          <nav className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-visible">
            <NavLink href="/agents">My agents</NavLink>
            <Link
              href="/onboarding?new=1"
              className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-hover"
            >
              <PlusIcon />
              New agent
            </Link>
            <ProfileMenu />
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

const PROFILE_LINKS = [
  { href: "/guardian", label: "Guardian" },
  { href: "/agents/account", label: "Account" },
] as const;

function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { session } = useAuth();
  const { data: me, error } = useWorldIdMeQuery({ enabled: !!session?.token });
  const unavailable = error instanceof ApiError && error.status === 404;
  const verified = !unavailable && Boolean(me?.verified);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative z-50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
        aria-label="Profile"
        title="Profile"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "relative flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
          verified
            ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300 hover:bg-emerald-400/[0.14]"
            : "hairline-strong text-muted hover:bg-paper-2 hover:text-ink",
        )}
      >
        <ProfileIcon />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[10.5rem] rounded-2xl border hairline bg-paper p-1.5"
        >
          {PROFILE_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-xl px-3 py-2 text-[12px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden>
      <circle cx="12" cy="8.2" r="3.4" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.8 18.6c.7-3.1 3.1-4.8 6.2-4.8s5.5 1.7 6.2 4.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
