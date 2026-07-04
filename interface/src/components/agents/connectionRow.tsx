"use client";

import type { Capability } from "@/lib/api/types";
import { cx } from "@/components/onboarding/primitives";

const CAP_STYLE: Record<Capability, string> = {
  read: "text-muted-2",
  earn: "text-accent",
  spend: "text-[#ff8a84]",
};

/** A read/earn/spend chip, tiered by privilege. */
export function CapabilityBadge({ capability }: { capability: Capability }) {
  return (
    <span
      className={cx(
        "shrink-0 rounded-full border hairline px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]",
        CAP_STYLE[capability],
      )}
    >
      {capability}
    </span>
  );
}

/** Shared revoke text-button; runs an optional window.confirm before revoking. */
export function RevokeButton({
  onRevoke,
  disabled,
  confirmMessage,
}: {
  onRevoke: () => void;
  disabled?: boolean;
  confirmMessage?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (confirmMessage && !window.confirm(confirmMessage)) return;
        onRevoke();
      }}
      className="shrink-0 text-[11.5px] text-[#ff8a84] underline-offset-2 hover:underline disabled:opacity-50"
    >
      Revoke
    </button>
  );
}
