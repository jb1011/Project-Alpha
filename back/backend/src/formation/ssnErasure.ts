import { opsLog } from "../observability/opsLog";

/**
 * SSN ERASURE, as ONE operation that cannot be performed without an audit line (design §4.4/§4.6a).
 *
 * There are four places an SSN dies, and they are deliberately in four different modules: the
 * filer's `provider_ref` transaction, the sweeper's two clock clauses, and the §4.7 re-capture.
 * Each of them used to call `eraseSsn` and then write its own `formation_ssn_erased` line, which
 * is four chances to erase a number and leave no record that it happened — and the record is the
 * only thing that remains once the value is gone.
 *
 * So the erase and its line are ONE function, the reason is a required argument, and the reason
 * is also WRITTEN TO THE ROW (`formation_parties.ssn_erased_reason`). The row's copy is what
 * makes the erasure legible to code rather than only to an operator: a filing that finds the SSN
 * gone needs to know whether the clock took it (park — see `resolveSsn`) or whether the value was
 * never there.
 */

/**
 * Why an SSN was erased.
 *
 * `none` is not an erasure — it is the mark a human leaves by deciding to file WITHOUT one after
 * the clock erased theirs (§4.6a). It shares the column because the question the column answers
 * is "what does this row's missing SSN MEAN?", and "the owner said go ahead" is one of the
 * answers.
 */
export type SsnErasedReason =
  | "provider_persisted"
  | "terminal"
  | "ttl"
  | "intake_reopened"
  | "none";

/** The narrow slice of the party repository this needs — structural, so nothing here imports the
 *  persistence layer and the sweeper's fakes satisfy it for free. */
export interface SsnEraser {
  eraseSsn(companyId: string, reason: SsnErasedReason): boolean;
}

/**
 * Erase a company's SSN and record that it happened.
 *
 * Returns whether anything was erased — false is the ordinary answer for every backstop pass
 * after the first, and it deliberately logs nothing: an erasure line per tick for a row that has
 * been empty for a month is noise that trains an operator to ignore the event.
 *
 * The line carries the COMPANY, the reason and the environment. Never the party, never a
 * fragment of the value — an erasure line that named the person would be the one place their
 * data outlived the erasure.
 */
export function eraseSsnLogged(
  parties: SsnEraser,
  companyId: string,
  reason: Exclude<SsnErasedReason, "none">,
  environment: string,
): boolean {
  if (!parties.eraseSsn(companyId, reason)) return false;
  opsLog("formation_ssn_erased", { companyId, reason, environment });
  return true;
}
