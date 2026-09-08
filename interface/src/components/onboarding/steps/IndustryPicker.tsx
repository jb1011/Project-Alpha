"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { IndustryIndex } from "@/lib/formation/companyIntake";
import { Field, TextInput, cx } from "../primitives";

/**
 * The industry field — a TYPE-AHEAD over 821 federal labels (design §5/§7).
 *
 * A `<select>` was the obvious thing and it is the wrong thing: 821 options is a list nobody
 * scrolls, and the field is chosen at the very top of the create funnel where a founder has one
 * word in mind ("consulting", "coffee") and no idea what the reference table calls it. So it is a
 * text input that filters, and the LABEL it commits is always one the backend served —
 * `onChange` fires only for a value picked from the list, never for what was typed.
 *
 * That last property is the one that matters: the create door accepts exactly the labels in its
 * own array, so a free-typed near-miss would reach doola and come back `rejected` on a real fee.
 * A partial query leaves the committed value EMPTY rather than guessing at the closest match.
 */
export function IndustryPicker({
  value,
  industries,
  error,
  loading,
  onChange,
}: {
  value: string;
  /**
   * The list, PREPARED ONCE (`industryIndex`).
   *
   * It used to be the raw array, and this component walked all 821 labels three times per
   * keystroke: once to filter, once for the exact-match hint, and once inside `onChange`. All
   * three lowercased every label each time, for a list that changes on a deploy.
   */
  industries: IndustryIndex;
  error?: string;
  loading?: boolean;
  onChange: (label: string) => void;
}) {
  const id = useId();
  // What is TYPED, which is not what is committed. It starts as the committed value so a form
  // that comes back (a validation pass, a step revisit) shows the choice rather than a blank box.
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return industries.options.slice(0, MAX_SUGGESTIONS);
    // Prefix matches first — a founder typing "cons" means "Consulting", not "Air conditioning
    // contractors" — then everything else that contains the query, capped.
    const starts: string[] = [];
    const contains: string[] = [];
    for (const { label, lower } of industries.lowered) {
      if (lower.startsWith(q)) starts.push(label);
      else if (lower.includes(q)) contains.push(label);
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [query, industries]);

  // O(1), and it hands back the label in its CANONICAL casing — which is what must be committed,
  // because the create door accepts the labels exactly as it ships them.
  const exact = industries.byLower.get(query.trim().toLowerCase());

  function commit(label: string) {
    setQuery(label);
    setOpen(false);
    onChange(label);
  }

  return (
    <Field
      label="Industry"
      htmlFor={id}
      hint={loading ? "Loading the list…" : `${industries.options.length} to choose from`}
      error={error}
    >
      <div className="relative">
        <TextInput
          id={id}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          placeholder={loading ? "…" : "Start typing — e.g. software, consulting, coffee"}
          disabled={loading}
          value={query}
          invalid={!!error}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // A click on a suggestion blurs the input BEFORE it fires, so the list has to outlive
            // the blur by a frame. Cancelled by the option's own mousedown handler.
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // The committed value follows the TEXT only when the text is exactly a label. Anything
            // else clears it: a half-typed query is not a choice, and committing the nearest match
            // would file under an industry nobody picked.
            const hit = industries.byLower.get(e.target.value.trim().toLowerCase());
            onChange(hit ?? "");
          }}
        />
        {open && matches.length > 0 && (
          <ul
            id={`${id}-list`}
            role="listbox"
            className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border hairline-strong bg-paper-2 py-1 shadow-lg"
          >
            {matches.map((label) => (
              <li key={label}>
                <button
                  type="button"
                  role="option"
                  aria-selected={label === value}
                  onMouseDown={(e) => {
                    // Before the blur, so the list is still there when the click lands.
                    e.preventDefault();
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                    commit(label);
                  }}
                  className={cx(
                    "block w-full cursor-pointer px-3.5 py-2 text-left text-[12.5px] transition-colors hover:bg-paper-3",
                    label === value ? "text-accent-soft" : "text-muted",
                  )}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* The honest state between "typing" and "chosen". Without it a founder who typed a query
          and moved on would find the field empty at submit with no idea why. */}
      {!error && query.trim() !== "" && !exact && (
        <span className="text-[11px] text-muted-2">
          Pick one from the list — the filing agent accepts only these labels.
        </span>
      )}
    </Field>
  );
}

/** Enough to choose from, few enough to read. The list is 821 long. */
const MAX_SUGGESTIONS = 12;
