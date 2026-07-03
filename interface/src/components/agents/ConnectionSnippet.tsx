"use client";

import * as React from "react";
import type { ConnectionSnippets } from "@/lib/api/types";
import { Button, cx } from "@/components/onboarding/primitives";
import { CONNECT_TARGETS } from "./connectTargets";

export function ConnectionSnippet({ snippets }: { snippets: ConnectionSnippets }) {
  const available = CONNECT_TARGETS.filter((t) => snippets[t.key]);
  const [selected, setSelected] = React.useState<keyof ConnectionSnippets>(
    available[0]?.key ?? "claudeCode",
  );
  const [copied, setCopied] = React.useState(false);

  const target = available.find((t) => t.key === selected) ?? available[0];
  const snippet = target ? snippets[target.key] ?? "" : "";
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;

  async function copy() {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* fall through to the manual-select hint */
    }
  }

  if (!target) return null;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-1.5">
        {available.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSelected(t.key)}
            className={cx(
              "rounded-full border px-3 py-1 text-[11.5px] transition-colors",
              t.key === selected
                ? "border-accent/40 bg-accent/10 text-accent-soft"
                : "hairline text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-muted-2">{target.hint}</div>
      {target.key === "claudeCode" && (
        <div className="mt-1 text-[11px] text-muted-2">
          This command puts your key in your shell history — prefer a config-file option for a long-lived key.
        </div>
      )}
      <pre className="mt-2 select-text overflow-x-auto rounded-xl border hairline bg-paper-2/60 p-3 text-[11px] leading-relaxed text-muted">
        {snippet}
      </pre>
      {canCopy ? (
        <Button variant="ghost" size="md" className="mt-2" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy snippet"}
        </Button>
      ) : (
        <div className="mt-2 text-[11px] text-muted-2">Select the text above and copy manually.</div>
      )}
    </div>
  );
}
