"use client";

import Link from "next/link";
import { cx } from "@/components/onboarding/primitives";

/** Agent-scoped navigation, rendered beside the agent's name — these belong to the agent, not
 *  to the account-level shell nav. */
export function AgentTabs({
  entityId,
  active,
}: {
  entityId: string;
  active: "dashboard" | "settings";
}) {
  const base = `/agents/${encodeURIComponent(entityId)}`;
  return (
    <nav
      aria-label="Agent pages"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border hairline bg-paper-2/60 p-1"
    >
      <Tab href={base} current={active === "dashboard"}>
        Dashboard
      </Tab>
      <Tab href={`${base}/settings`} current={active === "settings"}>
        Settings
      </Tab>
    </nav>
  );
}

function Tab({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "rounded-full px-3.5 py-1.5 text-[12px] transition-colors",
        current ? "bg-paper-3 text-ink" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
