/**
 * Versioned legal texts, and the gate that keeps a draft away from a real customer.
 *
 * A legal text is a sentence a person signs. Its version names exactly one template, so a changed
 * sentence is a new version, and a superseded version stays in its module: a stored declaration
 * names the version it was made under.
 *
 * Every text carries a status. A `draft` is wording not yet approved for real customers; only a
 * sandbox deployment serves one. A production deployment refuses to serve or accept a draft.
 */

export type LegalTextStatus = "draft" | "approved";

export interface LegalText<F> {
  /** The same across versions, e.g. "statement-of-authority". */
  readonly id: string;
  /** Names exactly one template, e.g. "2026-10-draft-1". */
  readonly version: string;
  readonly status: LegalTextStatus;
  /** The sentence with its `{field}` placeholders: what the version pins. */
  readonly template: string;
  render(fields: F): string;
}

export class LegalTextNotApprovedError extends Error {
  constructor(
    readonly textId: string,
    readonly version: string,
  ) {
    super(
      `legal text "${textId}" version "${version}" is a draft, and a production deployment does not serve a draft`,
    );
    this.name = "LegalTextNotApprovedError";
  }
}

/** Throws LegalTextNotApprovedError when `environment` is "production" and any text is a draft. */
export function assertTextsServable(
  environment: "sandbox" | "production",
  texts: readonly LegalText<never>[],
): void {
  // Only a sandbox deployment may serve a draft. Any other value is held to the production rule,
  // and anything but `approved` counts as a draft.
  if (environment === "sandbox") return;
  for (const text of texts)
    if (text.status !== "approved") throw new LegalTextNotApprovedError(text.id, text.version);
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * Builds a legal text whose `render` fills in its own template.
 *
 * `render` replaces every `{name}` with the field of that name in ONE pass over the template: a
 * value is never scanned again, so a field that holds `{guardian}` stays that text. A value goes in
 * exactly as given, never trimmed or changed (the replacer is a function, so a `$` in a value is
 * plain text). A placeholder with no string field is refused, never rendered as "undefined".
 *
 * `render` is an own property that closes over the template, so a copy made with a spread keeps a
 * working `render`. The text itself is frozen.
 */
export function defineLegalText<F extends object>(text: {
  id: string;
  version: string;
  status: LegalTextStatus;
  template: string;
}): LegalText<F> {
  const { id, template } = text;
  return Object.freeze({
    id,
    version: text.version,
    status: text.status,
    template,
    render: (fields: F): string =>
      template.replace(PLACEHOLDER, (_placeholder, name: string) => {
        const value: unknown = Object.hasOwn(fields, name)
          ? (fields as Record<string, unknown>)[name]
          : undefined;
        if (typeof value !== "string")
          throw new Error(`legal text "${id}": placeholder {${name}} has no string field`);
        return value;
      }),
  });
}
