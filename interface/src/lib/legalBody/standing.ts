/**
 * The record a stranger reads: a legal body's public standing in a few words, the facts of its
 * statement that matter to someone deciding whether to deal with the agent, and the statement a
 * counterparty can check for itself.
 *
 * Everything comes from the public by-agent answer, and the answer is read only once the order is
 * `linked`: before that there is no public link to read, and after a break a held answer is old.
 * The words stay inside the claims ceiling: the four standing words as the API gives them, the yes
 * sentence only for `active`, `unknown` neutral and never a negative, a read that could not be
 * made never turned into an answer, and the sandbox said out loud. There is no green tone: `active`
 * takes the accent.
 *
 * Every decision the done page and the legal body's own page make about the record is here; the
 * screens only render the answers.
 */
import type { PublicRead } from "@/lib/api/legalBodyClient";
import type {
  BindingState,
  LegalBodyByAgent,
  LegalBodyOrderView,
  LegalBodyStatementJson,
  SignedStatementJson,
  Standing,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";

const D = LEGAL_BODY_COPY.done;

export type StandingPresentation = {
  label: "active" | "pending" | "unknown" | "inactive" | "could not check" | "not yet visible";
  tone: "accent" | "amber" | "neutral";
  sentences: string[];
};

type Environment = "sandbox" | "production";

/** An answer that carries a signed statement, and so its statement link. */
type StatedAnswer = Extract<
  LegalBodyByAgent,
  { legalBody: true; standing: Standing; statement: SignedStatementJson }
>;

/** The order states before the pointer is written: the record is still to come. */
const BEFORE_POINTER: readonly BindingState[] = ["draft", "reserved", "deployed"];

/** The public read runs for a linked order with its identity, and for nothing else. */
export function publicReadAllowed(
  order: Pick<LegalBodyOrderView, "state" | "agentId"> | null,
): boolean {
  return order !== null && order.state === "linked" && order.agentId !== null;
}

/** The answer the record may read: the read as served, but only for a linked order. */
function heldAnswer(
  read: PublicRead<LegalBodyByAgent> | null,
  orderState: BindingState,
): PublicRead<LegalBodyByAgent> | null {
  return orderState === "linked" ? read : null;
}

/** The answer with its signed statement, when there is one. */
function statedOf(read: PublicRead<LegalBodyByAgent> | null): StatedAnswer | null {
  if (read === null || read.kind !== "answer") return null;
  const body = read.body;
  return body.legalBody && body.statement !== null ? body : null;
}

/** The sandbox line: on a sandbox deployment, or for a statement that says sandbox. */
function sandboxLines(environment: Environment, stated: StatedAnswer | null): string[] {
  const sandbox =
    environment === "sandbox" || stated?.statement.message.environment === "sandbox";
  return sandbox ? [D.sandboxStatement] : [];
}

/**
 * The standing, in a few words, and the tone it is shown in.
 *
 *  - an order that is not `linked`: not yet visible, whatever read is held;
 *  - a linked order not read yet: being read;
 *  - a read that made no answer: could not check, with its reason;
 *  - no legal body for the agent: not yet visible, since the record appears within a minute of
 *    the pointer being seen;
 *  - a body with no statement: unknown, the chain could not be read, whatever standing came with
 *    it (an answer without a statement is never a yes);
 *  - a signed statement: its standing, explained, and the sandbox said out loud.
 */
export function standingPresentation(p: {
  read: PublicRead<LegalBodyByAgent> | null;
  orderState: BindingState;
  environment: Environment;
  paymentRequired: boolean;
}): StandingPresentation {
  if (p.orderState !== "linked") {
    const why = BEFORE_POINTER.includes(p.orderState) ? D.notYetVisible : D.notLinked;
    return { label: D.labels.notYetVisible, tone: "neutral", sentences: [why] };
  }
  const read = p.read;
  if (read === null) return { label: D.labels.notYetVisible, tone: "neutral", sentences: [D.reading] };
  if (read.kind === "could_not_check") {
    return {
      label: D.labels.couldNotCheck,
      tone: "neutral",
      sentences: [D.couldNotCheckReasons[read.reason], D.saysNothing],
    };
  }
  const body = read.body;
  if (!body.legalBody) {
    return { label: D.labels.notYetVisible, tone: "neutral", sentences: [D.notYetVisible] };
  }
  const stated = statedOf(read);
  const sandbox = sandboxLines(p.environment, stated);
  if (stated === null) {
    return { label: "unknown", tone: "neutral", sentences: [D.chainUnread, ...sandbox] };
  }

  const message = stated.statement.message;
  switch (stated.standing) {
    case "active":
      return { label: "active", tone: "accent", sentences: sandbox };
    case "pending":
      return {
        label: "pending",
        tone: "amber",
        sentences: [p.paymentRequired ? D.notYetPaid : D.checkNotStanding, ...sandbox],
      };
    case "unknown":
      return { label: "unknown", tone: "neutral", sentences: [D.filingFactsMissing, ...sandbox] };
    case "inactive":
      return {
        label: "inactive",
        tone: "amber",
        sentences: [
          fillCopy(D.inactiveWords, {
            attestationState: message.attestationState,
            bindingState: message.bindingState,
          }),
          ...sandbox,
        ],
      };
    default:
      // A standing a newer API grew that this build does not know: never a claim either way.
      return { label: "unknown", tone: "neutral", sentences: [D.standingNotKnown, ...sandbox] };
  }
}

/**
 * What a counterparty can check: the statement's URL exactly as the answer serves it, the
 * statement's own `environment` word, and what may be said. The yes sentence is given only for
 * `active`, and is otherwise empty; `sayInstead` says what to say in its place (the standing as it
 * is) or beside it (that a sandbox statement is a test), and is null only for an active statement
 * on production.
 */
export function counterpartyCheck(
  answer: Extract<LegalBodyByAgent, { legalBody: true; standing: Standing; statement: SignedStatementJson }>,
): { url: string; environment: Environment; yesSentence: string; sayInstead: string | null } {
  const environment = answer.statement.message.environment;
  const url = answer.links.statement;
  if (answer.standing === "active") {
    return {
      url,
      environment,
      yesSentence: D.yes,
      sayInstead: environment === "sandbox" ? D.sayWithSandbox : null,
    };
  }
  const asItIs = fillCopy(D.sayAsItIs, { standing: String(answer.standing) });
  return {
    url,
    environment,
    yesSentence: "",
    sayInstead: environment === "sandbox" ? `${asItIs} ${D.sayTest}` : asItIs,
  };
}

/**
 * The statement's facts a stranger cares about, in seven rows: identity, body, binding,
 * attestation, filing status, next due, environment. The rest (the owner at creation, the agent's
 * wallet, the registry and factory, the agreement's hash, the contract flags, the block and the
 * times, and the envelope's attestor) belongs to the tenant's own page.
 */
export function statementFactsForStranger(s: LegalBodyStatementJson): { label: string; value: string }[] {
  const F = D.facts;
  return [
    { label: F.identity, value: s.agentId },
    { label: F.body, value: s.legalBody },
    { label: F.binding, value: s.bindingState },
    { label: F.attestation, value: s.attestationState },
    { label: F.filingStatus, value: s.filingStatus },
    { label: F.nextDue, value: s.nextDue === "" ? D.notRecorded : s.nextDue },
    { label: F.environment, value: s.environment },
  ];
}

/** A served URL as a link target: only over http or https, so a value the answer carries can never
 *  be a script or a data document on this page. Otherwise null, and the URL is shown as text. */
export function linkableUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null;
}

type ShownUrl = { text: string; href: string | null };
const shown = (url: string): ShownUrl => ({ text: url, href: linkableUrl(url) });

export type LegalBodyRecordView = {
  standing: StandingPresentation;
  /** A Try again under the standing: the read made no answer, or found no record yet. */
  retry: boolean;
  /** The statement's seven rows, when there is a signed statement. */
  facts: { label: string; value: string }[] | null;
  /** The links as served, when there is a legal body to link to. */
  links: { statement: ShownUrl | null; transparency: ShownUrl | null } | null;
  /** The counterparty's box, when there is a signed statement; the environment word is amber on
   *  sandbox. */
  check:
    | (ReturnType<typeof counterpartyCheck> & {
        href: string | null;
        environmentTone: "amber" | "neutral";
      })
    | null;
};

/** Everything the record shows, from the same inputs as the standing. */
export function legalBodyRecordView(p: Parameters<typeof standingPresentation>[0]): LegalBodyRecordView {
  const standing = standingPresentation(p);
  const read = heldAnswer(p.read, p.orderState);
  const body = read?.kind === "answer" ? read.body : null;
  const retry =
    read !== null &&
    (read.kind === "could_not_check" || !read.body.legalBody || read.body.statement === null);
  const stated = statedOf(read);
  const links =
    body !== null && body.legalBody
      ? {
          statement: stated !== null ? shown(stated.links.statement) : null,
          transparency: shown(body.links.transparency),
        }
      : null;
  if (stated === null) return { standing, retry, facts: null, links, check: null };

  const check = counterpartyCheck(stated);
  return {
    standing,
    retry,
    facts: statementFactsForStranger(stated.statement.message),
    links,
    check: {
      ...check,
      href: linkableUrl(check.url),
      environmentTone: check.environment === "sandbox" ? "amber" : "neutral",
    },
  };
}
