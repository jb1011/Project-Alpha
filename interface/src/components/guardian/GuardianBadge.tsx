"use client";

import Link from "next/link";
import * as React from "react";
import { worldIdMe } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { PersonhoodSeal } from "@/components/guardian/PersonhoodSeal";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { cx } from "@/components/onboarding/primitives";

/**
 * Standing, carried in the shell: lit when a verified human backs this account, grey when not.
 * Reads the stored session directly rather than ensureSession() — the shell must never provoke
 * a wallet signature just by rendering.
 */
export function GuardianBadge() {
  const { session, address } = useAuth();
  const [me, setMe] = React.useState<Awaited<ReturnType<typeof worldIdMe>> | null>(null);
  const [available, setAvailable] = React.useState(true);

  React.useEffect(() => {
    const token = session?.token;
    if (!token) {
      setMe(null);
      return;
    }
    let live = true;
    worldIdMe(token)
      .then((v) => live && setMe(v))
      .catch((e) => {
        // 404 = World isn't configured on this deployment; say nothing rather than show a dead badge.
        if (live && e instanceof ApiError && e.status === 404) setAvailable(false);
      });
    return () => {
      live = false;
    };
  }, [session?.token]);

  if (!available || !session?.token) return null;

  return <GuardianBadgeView verified={me?.verified ?? false} seed={me?.nullifier ?? address ?? "novi-corpus"} />;
}

/** Split out so both states can be rendered against fixed data for design review. */
export function GuardianBadgeView({ verified }: { verified: boolean; seed?: string }) {
  return (
    <Link
      href="/guardian"
      title={verified ? "A verified human backs this account" : "No human on record yet"}
      className={cx(
        "flex items-center gap-2 rounded-full border px-2.5 py-1 transition-colors",
        verified
          ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300 hover:bg-emerald-400/[0.14]"
          : "hairline-strong text-muted-2 hover:bg-paper-2 hover:text-ink",
      )}
    >
      <span className={cx("h-[18px] w-[18px] shrink-0", verified && "guardian-glow")}>
        <SealMark verified={verified} />
      </span>
      <span className="hidden text-[12px] sm:inline">Guardian</span>
      <span className="sr-only">
        {verified ? "Guardian verified — open guardian page" : "Guardian unverified — open guardian page"}
      </span>
    </Link>
  );
}

/**
 * The seal reduced to what survives at 18px: the ring and the struck star. Deliberately fixed
 * rather than derived from the nullifier — at this size a personal figure is illegible, and the
 * badge's job is recognition. The nullifier's own figure lives on the guardian page.
 */
function SealMark({ verified }: { verified: boolean }) {
  const ink = verified ? "#6ee7b7" : "var(--muted-2)";
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="10.2"
        fill="none"
        stroke={ink}
        strokeWidth="1.3"
        strokeDasharray={verified ? undefined : "2.4 2.8"}
        opacity={verified ? 1 : 0.8}
      />
      <path
        d={STAR}
        fill="none"
        stroke={ink}
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity={verified ? 1 : 0.65}
      />
    </svg>
  );
}

const STAR = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 6.4 : 2.8;
    pts.push(`${(12 + Math.cos(a) * r).toFixed(2)} ${(12 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
})();
