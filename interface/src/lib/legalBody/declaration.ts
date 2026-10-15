/**
 * The company step's decisions, each pure: the declaration's field rules, the request it sends,
 * what the screen does after a refusal (the door's, the gate's, the wallet's), the offer to
 * continue with a company of the tenant's own that already declared the number, and which
 * sub-screen a state of the check shows.
 *
 * The field rules mirror the declaration doors', in their order and with their own problems, so a
 * field the door would refuse is stopped under the field before any door is spent. The door has
 * the last word: when it answers a field's problem, that problem is shown instead.
 *
 * The form is never stored: it lives in the screen's state, and this module only reads it.
 */
import {
  ApiError,
  type CompanyView,
  type CustomerStatementInput,
  type StatementMessageAnswer,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import type { CompanyStep, LegalBodyNotice } from "./flow";
import { noticeSentence, type NoticeSentence } from "./notice";
import { normaliseDeclaredText } from "./typedData";

/** Why an operator's check failed, one sentence per reason code. Kept with every other sentence
 *  in `copy.ts`, where the copy test walks it; offered here beside the step's other decisions. */
export { CHECK_REASON_SENTENCES } from "./copy";

export type DeclarationForm = {
  companyName: string;
  filingNumber: string;
  declarantName: string;
  declarantTitle: string;
};

export type DeclarationProblems = Partial<Record<keyof DeclarationForm, string>>;

type Environment = "sandbox" | "production";

const C = LEGAL_BODY_COPY.company;
const P = C.problems;
const N = LEGAL_BODY_COPY.notices;

/** The form's fields, in the order the doors check them. */
const FORM_FIELDS: readonly (keyof DeclarationForm)[] = [
  "declarantName",
  "declarantTitle",
  "companyName",
  "filingNumber",
];

// ---------------------------------------------------------------------------------------------
// The field rules
// ---------------------------------------------------------------------------------------------

/** A control, format (a zero-width character, a direction override), surrogate, private-use or
 *  unassigned character. */
const CONTROL_OR_INVISIBLE = /\p{C}/u;
/** A separator other than U+0020: a non-breaking space, a line separator, an ideographic space. */
const OTHER_SPACE = /(?! )\p{Z}/u;

type TextRule = {
  /** Inclusive, in code points, after the spaces are normalised. */
  min: number;
  max: number;
  /** The characters the field may hold, as a whole-string test. */
  chars: RegExp;
  charsProblem: string;
  /** A further pattern the value must match. */
  also?: { pattern: RegExp; problem: string };
};

const DECLARANT_NAME: TextRule = {
  min: 2,
  max: 120,
  chars: /^[\p{L}\p{M} '.-]+$/u,
  charsProblem: P.declarantNameCharset,
};
const DECLARANT_TITLE: TextRule = {
  min: 2,
  max: 80,
  chars: /^[\p{L}\p{M}0-9 '.&/,-]+$/u,
  charsProblem: P.declarantTitleCharset,
};
/** The characters a Wyoming entity name takes: A-Z, a-z, 0-9, the space and & ' - , . ( ) +. */
const COMPANY_NAME: TextRule = {
  min: 2,
  max: 200,
  chars: /^[A-Za-z0-9 &'\-,.()+]+$/,
  charsProblem: C.nameCharset,
};
/** On a sandbox, a name that says it is a test, so a test record cannot pass for a company's. */
const SANDBOX_COMPANY_NAME: TextRule = {
  ...COMPANY_NAME,
  also: { pattern: /\btest\b/i, problem: P.nameTest },
};
const FILING_NUMBER: TextRule = {
  min: 4,
  max: 32,
  chars: /^[0-9A-Za-z-]+$/,
  charsProblem: P.numberCharset,
};
/** On a sandbox, a test number, so a test declaration can never name a real filing. */
const SANDBOX_FILING_NUMBER: TextRule = {
  ...FILING_NUMBER,
  also: { pattern: /^TEST-[0-9A-Z-]{4,27}$/, problem: P.numberTest },
};

/**
 * One field through the rules, in the doors' order: NFC; then a control or invisible character, a
 * space other than U+0020, or a double quote is refused, never cleaned; then the U+0020 at the
 * ends are stripped and runs of them collapsed; then the length in code points, the characters,
 * and the further pattern. A field left empty is refused as required.
 */
function textProblem(raw: string, rule: TextRule): string | undefined {
  const nfc = raw.normalize("NFC");
  if (CONTROL_OR_INVISIBLE.test(nfc)) return P.control;
  if (OTHER_SPACE.test(nfc)) return P.otherSpace;
  if (nfc.includes('"')) return P.doubleQuote;
  const value = normaliseDeclaredText(nfc);
  if (value === "") return P.required;
  const length = [...value].length;
  if (length < rule.min || length > rule.max)
    return fillCopy(P.length, { min: String(rule.min), max: String(rule.max) });
  if (!rule.chars.test(value)) return rule.charsProblem;
  if (rule.also && !rule.also.pattern.test(value)) return rule.also.problem;
  return undefined;
}

/**
 * Every field that breaks a rule, with its problem. A sandbox names its own declarant, so it
 * checks the company's name and number only; production checks the four.
 */
export function validateDeclaration(form: DeclarationForm, environment: Environment): DeclarationProblems {
  const sandbox = environment === "sandbox";
  const rules: [keyof DeclarationForm, TextRule][] = sandbox
    ? [
        ["companyName", SANDBOX_COMPANY_NAME],
        ["filingNumber", SANDBOX_FILING_NUMBER],
      ]
    : [
        ["declarantName", DECLARANT_NAME],
        ["declarantTitle", DECLARANT_TITLE],
        ["companyName", COMPANY_NAME],
        ["filingNumber", FILING_NUMBER],
      ];
  const problems: DeclarationProblems = {};
  for (const [field, rule] of rules) {
    const problem = textProblem(form[field], rule);
    if (problem !== undefined) problems[field] = problem;
  }
  return problems;
}

/** Whether any field has a problem. */
export function hasProblems(problems: DeclarationProblems): boolean {
  return Object.keys(problems).length > 0;
}

/**
 * The statement-message request, normalised as the door normalises it. A sandbox sends the name,
 * the number and `synthetic: true`, and never a declarant; production sends the four fields and no
 * `synthetic` key. Call it on a form `validateDeclaration` accepted.
 */
export function declarationInput(form: DeclarationForm, environment: Environment): CustomerStatementInput {
  const companyName = normaliseDeclaredText(form.companyName);
  const filingNumber = normaliseDeclaredText(form.filingNumber);
  if (environment === "sandbox") return { companyName, filingNumber, synthetic: true };
  return {
    declarantName: normaliseDeclaredText(form.declarantName),
    declarantTitle: normaliseDeclaredText(form.declarantTitle),
    companyName,
    filingNumber,
  };
}

// ---------------------------------------------------------------------------------------------
// After a refusal
// ---------------------------------------------------------------------------------------------

/**
 * - `refetch`: ask for a new statement and ask the person again, keeping the form;
 * - `fields`: the problems under their fields, as the door served them;
 * - `sentence`: the door's sentence, as served;
 * - `stop`: nothing more is sent until the person tries again; `problem` names why.
 */
export type StatementSubmitOutcome =
  | { kind: "refetch" }
  | { kind: "fields"; problems: DeclarationProblems }
  | { kind: "sentence"; sentence: string }
  | { kind: "stop"; problem: string };

/** The problem word of a stop on which no answer came back. */
export const NO_ANSWER = "no_answer";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An own property only: nothing inherited is read. */
function own(v: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined;
}

/** The form's fields a `validation_error` names, each with its first problem. Fields outside the
 *  form (the signature, `issuedAt`) and malformed entries are left out. */
function fieldProblemsOf(details: unknown): DeclarationProblems {
  const problems: DeclarationProblems = {};
  if (!Array.isArray(details)) return problems;
  for (const entry of details) {
    if (!isRecord(entry)) continue;
    const field = own(entry, "field");
    const problem = own(entry, "problem");
    // Matched against the list, never by indexing, so `constructor` is not taken for a field.
    const known = FORM_FIELDS.find((f) => f === field);
    if (known === undefined || typeof problem !== "string") continue;
    if (problems[known] === undefined) problems[known] = problem;
  }
  return problems;
}

/**
 * What the screen does after the statement door or the create door refused:
 * `statement_stale` asks again; a `validation_error` naming fields of the form puts each problem
 * under its field; every other refusal of the API, the caps among them, is its sentence as served;
 * anything that is not the API's answer (the network, an answer that could not be read) is a stop.
 */
export function statementSubmitOutcome(e: unknown): StatementSubmitOutcome {
  if (!(e instanceof ApiError)) return { kind: "stop", problem: NO_ANSWER };
  if (e.code === "statement_stale") return { kind: "refetch" };
  if (e.code === "validation_error") {
    const problems = fieldProblemsOf(e.details);
    if (hasProblems(problems)) return { kind: "fields", problems };
  }
  return { kind: "sentence", sentence: e.message };
}

/**
 * What a refusal of the gate means. On a statement just served it is a stop with its problem word:
 * the wallet is never opened for it. On a statement already on screen, which passed the gate when
 * it arrived, a refusal of the time window alone means the person took longer than the server
 * allows: a new one is asked for. Any other rule broken is a stop even then.
 */
export function gateRefusalOutcome(problem: string, alreadyOnScreen: boolean): StatementSubmitOutcome {
  if (alreadyOnScreen && problem === "issued_at_window") return { kind: "refetch" };
  return { kind: "stop", problem };
}

/** The sentence of a stop: no answer says so; a refusal of the gate names its problem. */
export function stopSentence(problem: string): string {
  return problem === NO_ANSWER ? C.noAnswer : fillCopy(C.refused, { problem });
}

/**
 * The sentence after the wallet did not sign. A wallet on another chain than the statement's may
 * refuse to sign it, so the person is told which network it is for.
 */
export function declinedSentence(
  walletChainId: number | undefined,
  config: { chainId: number; environment: Environment },
): string {
  if (walletChainId === undefined || walletChainId === config.chainId) return C.declined;
  const { networkSandbox, networkProduction } = LEGAL_BODY_COPY.pointer;
  const network = config.environment === "sandbox" ? networkSandbox : networkProduction;
  return fillCopy(C.declinedOtherNetwork, { network });
}

/** The abandon door's refusal as served; when no answer came back, a sentence that says so. */
export function abandonRefusalSentence(e: unknown): string {
  return e instanceof ApiError ? e.message : C.abandonNoAnswer;
}

/**
 * The statement as the page shows it, under the wallet's prompt: the sentence the wallet is about
 * to sign, its wording version, and the draft badge. Only an approved wording goes without the
 * badge: a status this build does not know reads as a draft. Call it on a statement the gate
 * accepted.
 */
export function statementOnScreen(served: StatementMessageAnswer): {
  sentence: string;
  wordingVersion: string;
  draft: boolean;
} {
  return {
    sentence: served.typedData.message.statement,
    wordingVersion: fillCopy(C.wordingVersion, { version: served.wordingVersion }),
    draft: served.textStatus !== "approved",
  };
}

// ---------------------------------------------------------------------------------------------
// A number one of the tenant's own companies already declared
// ---------------------------------------------------------------------------------------------

/** How the doors' refusal of a test number already declared on the deployment begins. */
export const ALREADY_DECLARED = "is already declared on this deployment";

/** Whether the refusal is the doors' "already declared" answer about the filing number. */
export function isAlreadyDeclared(outcome: StatementSubmitOutcome): boolean {
  if (outcome.kind !== "fields") return false;
  const problem = outcome.problems.filingNumber;
  return typeof problem === "string" && problem.startsWith(ALREADY_DECLARED);
}

/** The once-only key the declaration doors hold a filing number under: the number as the doors
 *  normalise it, in upper case, with its hyphens dropped. */
export function filingKeyOf(filingNumber: string): string {
  return normaliseDeclaredText(filingNumber).toUpperCase().replace(/-/g, "");
}

/**
 * On the "already declared" refusal, the tenant's own company that declared the typed number, if
 * there is one: a declared company, not abandoned, whose declared number has the typed number's
 * once-only key (`filingKeyOf`), the key the doors refuse a second declaration by. Among several,
 * the one whose check passed; otherwise the first in the list, which the API serves newest first.
 * The screen offers to continue with it instead of only showing the sentence.
 */
export function ownCompanyWithNumber(
  outcome: StatementSubmitOutcome,
  typedNumber: string,
  companies: readonly CompanyView[],
): string | null {
  if (!isAlreadyDeclared(outcome)) return null;
  const typed = filingKeyOf(typedNumber);
  const matches = companies.filter((c) => {
    const declared = c.declared?.filingNumber;
    return (
      c.provider === "customer" &&
      c.state !== "abandoned" &&
      typeof declared === "string" &&
      filingKeyOf(declared) === typed
    );
  });
  const match = matches.find((c) => c.verification?.state === "verified") ?? matches[0];
  return match?.companyId ?? null;
}

// ---------------------------------------------------------------------------------------------
// Which sub-screen
// ---------------------------------------------------------------------------------------------

export type CompanyScreen =
  | { kind: "form"; notice: NoticeSentence | null }
  | { kind: "loading" }
  | {
      kind: "status";
      title: string;
      lines: string[];
      /** The check's state as the API words it, where the screen shows it; null shows none. */
      stateWord: string | null;
      /** "Declare the company again" is offered. */
      newDeclaration: boolean;
      /** Abandon is offered; the door's refusal is shown as served. */
      abandon: boolean;
    };

/**
 * What the company step shows for each of its states:
 *  - `form`: the declaration, under the derivation's notice when there is one;
 *  - `waiting`: on production, the operator's check by a person, with no number of days, since
 *    none is decided; on a sandbox, that the company was put back to be checked again;
 *  - `evidence`: the upload is not on this screen yet;
 *  - `failed`: the reason's sentence and the way back, a new declaration, and on production the
 *    evidence, which is not on this screen yet; abandon is offered;
 *  - `revoked`: the API's word and a new declaration; abandon is offered.
 */
export function companyScreen(p: {
  step: CompanyStep;
  notice?: LegalBodyNotice;
  environment: Environment;
  verificationState: string | null;
}): CompanyScreen {
  const { step, notice, environment } = p;
  const status = (
    title: string,
    lines: string[],
    more: { stateWord?: string | null; newDeclaration?: boolean; abandon?: boolean } = {},
  ): CompanyScreen => ({
    kind: "status",
    title,
    lines,
    stateWord: more.stateWord ?? null,
    newDeclaration: more.newDeclaration ?? false,
    abandon: more.abandon ?? false,
  });

  switch (step) {
    case "form":
      return { kind: "form", notice: notice ? noticeSentence(notice, environment) : null };
    case "loading":
      return { kind: "loading" };
    case "waiting":
      return status(N.company_awaiting_check.title, [
        environment === "production" ? C.waiting : N.company_awaiting_check.sandbox,
      ]);
    case "evidence":
      return status(C.evidenceTitle, [C.evidenceUnavailable]);
    case "failed": {
      const failed =
        notice?.kind === "company_failed" ? notice : { kind: "company_failed" as const, reasonCode: null };
      const sentence = noticeSentence(failed, environment);
      const lines = environment === "production" ? [sentence.body, C.evidenceUnavailable] : [sentence.body];
      return status(sentence.title, lines, { newDeclaration: true, abandon: true });
    }
    case "revoked":
      return status(N.company_revoked.title, [N.company_revoked.body], {
        // The word as served; none is invented when the check could not be read.
        stateWord: p.verificationState,
        newDeclaration: true,
        abandon: true,
      });
  }
}
