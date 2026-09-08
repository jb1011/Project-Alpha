"use client";

import type { FormationCopy } from "@/lib/formation/copy";
import { Field, TextInput } from "../primitives";

/**
 * ⚠ THE SSN FIELD (§4.1) — the single worst input in this codebase to get wrong, so there is one
 * of it.
 *
 * Two screens collect one: the create form (`PartyFields`) and the §4.6a re-capture on a parked
 * company. They had two copies of the same box, and the copies had already drifted — one rendered
 * the `help` sentence and the other did not, so the same field explained itself on one screen and
 * not on the other.
 *
 * `type="password"` and `autoComplete="off"` are not security — the value is in the DOM either
 * way — but they keep it out of the browser's form-fill store and off the screen in a shared
 * room, which are the two ways it leaks from here.
 *
 * ⚠ The value is passed in and out as its own prop and is NEVER a field of any object the wizard
 * persists. The gate on whether this renders at all is the caller's, and it is the DEPLOYMENT's
 * environment: the backend refuses the field outright anywhere but production.
 */
export function SsnInput({
  id,
  value,
  onChange,
  copy,
  showHelp = true,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Served by `/config` where the backend answered, bundled where it did not — always present. */
  copy: FormationCopy["ssn"];
  /** The create form explains the choice; the re-capture screen has already explained it above. */
  showHelp?: boolean;
  className?: string;
}) {
  return (
    <Field label={copy.label} htmlFor={id} hint="Optional" className={className}>
      <TextInput
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder="XXX-XX-XXXX"
        className="max-w-[220px] font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {showHelp && (
        <p className="mt-1 text-[11.5px] leading-[1.55] text-muted-2">{copy.help}</p>
      )}
      {/* The retention promise, ALWAYS — it is the claim the backend is the one keeping. */}
      <p className="mt-1.5 text-[11.5px] leading-[1.55] text-muted-2">{copy.retention}</p>
    </Field>
  );
}
