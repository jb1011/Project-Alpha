import type { ExternalRecordView } from "@/lib/api/types";

/**
 * Everything the external track-record card shows, decided here and tested here (design
 * 2026-10-23, section 4.6). The component only lays it out.
 *
 * Two rules hold in every state: a figure never appears without its source, and a read that
 * failed is never shown as a zero. Every string is plain English, written for a guardian about
 * to let a limit change through or veto it.
 */

export type CardFigure = { label: string; value: string; source: string };

export type ExternalRecordCardModel = {
  state: "loading" | "failed" | "ready";
  title: string;
  /** What the record is, who graded it, and that it is not advice. */
  intro: string;
  /** Always on: the card exists on testnet only. */
  sandbox: string;
  /** One sentence in place of the figures: loading, nothing graded yet, or a failed read. */
  status: string | null;
  figures: CardFigure[];
  /** Sentences the guardian should read beside the figures: disagreements, gaps. */
  notices: string[];
  link: { href: string; label: string } | null;
  /** Whether to offer a Retry button. */
  retry: boolean;
};

export const CARD_TITLE = "Independent track record";
/** The one sentence where the word "advice" may appear. */
export const NOT_ADVICE = "Independent record of outcomes, not advice.";
export const SANDBOX_LINE = "Arc testnet. Test agent, test calls.";

/** Basis points as a signed percentage with two decimals: -314 is "-3.14%", 120 is "+1.20%". */
export function formatMoveBps(bps: number): string {
  const pct = (Math.abs(bps) / 100).toFixed(2);
  if (bps < 0) return `-${pct}%`;
  if (bps > 0) return `+${pct}%`;
  return `${pct}%`;
}

/** Only an https link is ever offered; the backend already restricted it to the provider's host. */
function safeLink(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export type CardInput =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "ready"; view: ExternalRecordView };

/**
 * The card for one read.
 *
 * `formatDay` turns milliseconds into the day shown beside "Last graded"; the component passes
 * `formatDate` from `@/lib/format`, the tests pass a fixed one.
 */
export function externalRecordCardModel(
  input: CardInput,
  providerName: string,
  formatDay: (ms: number) => string,
): ExternalRecordCardModel {
  const base = {
    title: CARD_TITLE,
    intro: `Market calls graded by ${providerName} and posted to this agent's ERC-8004 identity on Arc testnet. ${NOT_ADVICE}`,
    sandbox: SANDBOX_LINE,
  };
  const recordSource = `${providerName}'s record`;

  if (input.phase === "loading")
    return {
      ...base,
      state: "loading",
      status: "Reading the record…",
      figures: [],
      notices: [],
      link: null,
      retry: false,
    };
  if (input.phase === "failed")
    return {
      ...base,
      state: "failed",
      status: "Could not read the record just now.",
      figures: [],
      notices: [],
      link: null,
      retry: true,
    };

  const { chain, record, agreement } = input.view;
  const href = safeLink(input.view.provider.recordUrl);
  const link = href ? { href, label: `See the full record on ${providerName}` } : null;
  const figures: CardFigure[] = [];
  const notices: string[] = [];
  let status: string | null = null;
  let retry = false;

  // The worst result, read from the provider's record. Absent from the figures when there is
  // nothing graded to be worst at; never invented when the record could not be read.
  const worstFigure = (): CardFigure | null => {
    if (record.status === "unavailable")
      return {
        label: "Worst result",
        value: "unavailable",
        source: `${recordSource} could not be read`,
      };
    if (record.status !== "ok") return null;
    if (record.worstMoveBps === null)
      return record.graded > 0
        ? { label: "Worst result", value: "not given", source: recordSource }
        : null;
    return { label: "Worst result", value: formatMoveBps(record.worstMoveBps), source: recordSource };
  };

  if (chain.status === "ok") {
    if (chain.graded === 0) {
      status = "No graded calls posted yet.";
    } else {
      figures.push({
        label: plural(chain.graded, "Graded call", "Graded calls"),
        value: String(chain.graded),
        source: "posted on Arc",
      });
      figures.push({ label: "Correct", value: String(chain.correct), source: "posted on Arc" });
      figures.push({ label: "Wrong", value: String(chain.wrong), source: "posted on Arc" });
      const worst = worstFigure();
      if (worst) figures.push(worst);
      figures.push(
        chain.lastGradedAt
          ? {
              label: "Last graded",
              value: formatDay(Date.parse(chain.lastGradedAt)),
              source: "Arc explorer",
            }
          : { label: "Last graded", value: "date unavailable", source: "Arc explorer" },
      );
    }
    if (chain.unrecognised > 0)
      notices.push(
        `${chain.unrecognised} ${plural(chain.unrecognised, "entry", "entries")} in a format this card does not read.`,
      );
  } else {
    // The chain half failed: say so where the counts would be, and show the provider's own
    // figures under its own name, never as if they had been posted on Arc.
    status = "Could not read Arc just now.";
    retry = true;
    if (record.status === "ok" && record.graded > 0) {
      figures.push({
        label: plural(record.graded, "Graded call", "Graded calls"),
        value: String(record.graded),
        source: recordSource,
      });
      figures.push({ label: "Correct", value: String(record.correct), source: recordSource });
      figures.push({ label: "Wrong", value: String(record.wrong), source: recordSource });
      const worst = worstFigure();
      if (worst) figures.push(worst);
    }
  }

  // With nothing graded on Arc there is no worst-result line to carry the failure, so it is said.
  if (record.status === "unavailable" && chain.status === "ok" && chain.graded === 0)
    notices.push(`${recordSource} could not be read just now.`);
  if (record.status === "unavailable") retry = true;
  if (record.status === "not_linked") notices.push(`This identity names no ${providerName} wallet.`);
  if (agreement === "differ" && chain.status === "ok" && record.status === "ok")
    notices.push(
      `${providerName}'s record lists ${record.graded} ${plural(record.graded, "graded call", "graded calls")}; ${chain.graded} ${plural(chain.graded, "is", "are")} posted on Arc for this agent.`,
    );

  return { ...base, state: "ready", status, figures, notices, link, retry };
}
