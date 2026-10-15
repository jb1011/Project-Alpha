"use client";

import { AmberPill, Button, Card, SectionTitle, cx } from "@/components/onboarding/primitives";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import type { BindingState, LegalBodyByAgent } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { legalBodyRecordView, type StandingPresentation } from "@/lib/legalBody/standing";

const D = LEGAL_BODY_COPY.done;

/** The standing's tones. There is no green: `active` takes the accent. */
const TONE_CLASS: Record<StandingPresentation["tone"], string> = {
  accent: "border-accent/30 bg-accent/10 text-accent-soft",
  amber: "border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72]",
  neutral: "border-line-strong bg-paper-2/70 text-muted",
};

/** Amber words: the sandbox said out loud. */
const AMBER_TEXT = "text-[#f3cd72]";

/**
 * A legal body's public record, as a stranger reads it: the standing in a few words, the facts of
 * the signed statement that matter, the statement's URL and the transparency page, and what a
 * counterparty can check.
 *
 * Every word and tone comes from `legalBodyRecordView`; this component reads nothing and decides
 * nothing. The done page renders it, as can any page that shows the record; it says sandbox on its
 * own, with an amber marker, for a page without the flow's banner. The caller reads the public
 * answer, and only for a linked order; Try again is the caller's read, on a click.
 */
export function LegalBodyRecord({
  read,
  orderState,
  environment,
  paymentRequired,
  onRetry,
  retrying,
}: {
  read: PublicRead<LegalBodyByAgent> | null;
  orderState: BindingState;
  environment: "sandbox" | "production";
  paymentRequired: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const view = legalBodyRecordView({ read, orderState, environment, paymentRequired });
  const { standing, facts, links, check } = view;

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <SectionTitle>{D.standingHeading}</SectionTitle>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span
            className={cx(
              "inline-flex items-center rounded-full border px-3 py-1 text-[13px] font-medium",
              TONE_CLASS[standing.tone],
            )}
          >
            {standing.label}
          </span>
          {view.sandbox && <AmberPill size="sm">{D.sandboxPill}</AmberPill>}
        </div>
        {view.standingLines.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {view.standingLines.map((line) => (
              <p
                key={line.text}
                className={cx("text-[13px] leading-[1.6]", line.tone === "amber" ? AMBER_TEXT : "text-muted")}
              >
                {line.text}
              </p>
            ))}
          </div>
        )}
        {view.retry && (
          <div className="mt-4">
            <Button variant="ghost" onClick={onRetry} loading={retrying}>
              {D.retry}
            </Button>
          </div>
        )}
      </Card>

      {facts && (
        <Card className="p-6">
          <SectionTitle>{D.factsHeading}</SectionTitle>
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,180px)_1fr]">
            {facts.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-[12px] text-muted-2">{row.label}</dt>
                <dd className="break-all font-mono text-[12.5px] text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {links && (
        <Card className="p-6">
          <SectionTitle>{D.linksHeading}</SectionTitle>
          <div className="mt-4 flex flex-col gap-4">
            {links.statement && (
              <ShownLink label={D.statementLink} text={links.statement.text} href={links.statement.href} />
            )}
            {links.transparency && (
              <ShownLink
                label={D.transparencyLink}
                text={links.transparency.text}
                href={links.transparency.href}
              />
            )}
          </div>
        </Card>
      )}

      {check && (
        <Card className="p-6">
          <SectionTitle>{D.checkHeading}</SectionTitle>
          <p className="mt-3 text-[13px] leading-[1.6] text-muted">{D.checkIntro}</p>
          <p className="mt-3 break-all rounded-xl border hairline bg-paper/60 px-3.5 py-2.5 font-mono text-[12.5px] text-ink">
            {check.href ? (
              <a href={check.href} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                {check.url}
              </a>
            ) : (
              check.url
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted-2">
            <span>{D.environmentLabel}</span>
            {check.environmentTone === "amber" ? (
              <AmberPill size="sm">{check.environment}</AmberPill>
            ) : (
              <span className={cx("rounded-full border px-2 py-0.5 text-[10.5px]", TONE_CLASS.neutral)}>
                {check.environment}
              </span>
            )}
          </div>
          {check.sayBefore && (
            <p className={cx("mt-4 text-[13px] leading-[1.6]", check.sayTone === "amber" ? AMBER_TEXT : "text-muted")}>
              {check.sayBefore}
            </p>
          )}
          {check.yesSentence && (
            <div className="mt-4">
              <div className="text-[12px] text-muted-2">{check.sayLabel}</div>
              <p className="mt-1 text-[14px] leading-[1.6] text-accent-soft">{check.yesSentence}</p>
            </div>
          )}
          {check.sayAfter && (
            <p className={cx("mt-3 text-[13px] leading-[1.6]", check.sayTone === "amber" ? AMBER_TEXT : "text-muted")}>
              {check.sayAfter}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/** A URL as served: its text always, and a link only when `linkableUrl` allowed it. */
function ShownLink({ label, text, href }: { label: string; text: string; href: string | null }) {
  return (
    <div>
      <div className="text-[12px] text-muted-2">{label}</div>
      <p className="mt-1 break-all font-mono text-[12.5px] text-ink">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
            {text}
          </a>
        ) : (
          text
        )}
      </p>
    </div>
  );
}
