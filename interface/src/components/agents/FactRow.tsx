"use client";

import { cx } from "@/components/onboarding/primitives";

/**
 * ONE key/value row of a facts list — the shape both the dashboard's formation card and the
 * company page's filing panel render.
 *
 * A four-line component, duplicated character for character in two files, and the duplication was
 * not free: the two are read side by side by the same owner, and a padding or truncation tweak
 * applied to one of them makes the same facts look like different kinds of fact.
 */
export function FactRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-2">{k}</dt>
      <dd className={cx("min-w-0 truncate text-right text-ink", mono && "font-mono text-[11.5px]")}>
        {v}
      </dd>
    </div>
  );
}
