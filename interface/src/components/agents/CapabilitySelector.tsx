"use client";

import type { Capability } from "@/lib/api/types";
import { cx } from "@/components/onboarding/primitives";
import type { CapabilityOption } from "./capabilityCopy";

export function CapabilitySelector({
  options,
  value,
  onChange,
  disabled,
}: {
  options: CapabilityOption[];
  value: Capability;
  onChange: (c: Capability) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50",
            value === o.value ? "border-accent/40 bg-accent/[0.06]" : "hairline-strong hover:bg-paper-2",
          )}
        >
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <span
              className={cx(
                "h-3.5 w-3.5 rounded-full border",
                value === o.value ? "border-accent bg-accent" : "border-line-strong",
              )}
            />
            {o.label}
          </div>
          <div className="mt-1 pl-[22px] text-[11.5px] leading-[1.45] text-muted-2">{o.description}</div>
        </button>
      ))}
    </div>
  );
}
