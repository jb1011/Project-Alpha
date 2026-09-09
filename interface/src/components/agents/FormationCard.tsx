"use client";

import Link from "next/link";
import { useCompanyQuery, usePublicConfigQuery } from "@/lib/api/hooks";
import { formationCopyOf, parkSummary } from "@/lib/formation/copy";
import { requiredActionCopy } from "@/lib/formation/documents";
import { DocumentList } from "@/components/agents/DocumentList";
import { FactRow } from "@/components/agents/FactRow";
import {
  formationEnvironmentOf,
  type FormationEnvironment,
} from "@/lib/api/formationEnvironment";
import { type EntityView, type FormationStatus } from "@/lib/api/types";
import { filingTone, mayRenderConfirmed } from "@/lib/formation/honesty";
import { formatDate } from "@/lib/format";
import { AmberPill, Card, SectionTitle, cx } from "@/components/onboarding/primitives";

type Formation = NonNullable<EntityView["formation"]>;

/**
 * The legal body, as far as it exists (design §8).
 *
 * THE INVARIANT THIS CARD ENFORCES: a sandbox filing is amber and says "demo", always. Not "green
 * with a small note" — amber, in the badge, in the status line and in the documents list, because
 * a sandbox company has been filed with nobody, exists in no state's register, and its EIN is not
 * an EIN. The guardian-waiver card set the precedent: an honest-but-unverified state gets its own
 * colour rather than borrowing the confirmed one.
 *
 * The confirmed colour therefore requires an explicit "production" and nothing else. A row whose
 * `environment` this build cannot read — a value from a newer backend, an absent field — is
 * `unknown`, and unknown is amber too: green is a claim that a real company exists in a real
 * register, and the one thing worse than calling a real filing a demo is calling an unverifiable
 * one real. Note the environment comes from the ENTITY's own record, not from `GET /config`: an
 * agent filed in sandbox stays a sandbox filing on a box that later flips to production.
 *
 * Rendered only for entities that HAVE a formation block — a legacy or stub row has none, forever,
 * and inventing a "not formed" card for it would describe an absence as a stage.
 */
export function FormationCard({ formation }: { formation: Formation }) {
  const { data: config } = usePublicConfigQuery();
  // ONE table for the three parks — the same sentences the Companies page renders beside the form
  // that clears each, taken in the summary register. This card held a fourth hand-written
  // paraphrase of them, which is a second description of one behaviour and the one nobody looks
  // at is the one that goes stale.
  const copy = formationCopyOf(config);

  const companyId = formation.companyId;
  const environment = formationEnvironmentOf(formation.environment);
  /**
   * The company row, for the ONE thing an entity view cannot carry: whether this filing is PARKED
   * waiting on a human (§4.6a/§4.7).
   *
   * The three parks are a property of the COMPANY, and a dashboard that showed "filing in
   * progress" over a filing that stopped three weeks ago and is waiting for its owner is the
   * failure this whole phase exists to fix. What the card does NOT do is offer the forms: those
   * live on the company page, once, so an owner is never editing an identity in two places.
   */
  const company = useCompanyQuery(companyId);
  const park = company.data?.park;
  const parked = park
    ? (["awaitingIntakeEdit", "awaitingPartyEdit", "awaitingSsnDecision"] as const).filter(
        (k) => park[k],
      )
    : [];
  /**
   * The §7 SHARING LABEL. `sharedWith` is the TOTAL attached, including this agent, so "1" means
   * not shared — the subtraction happens HERE, once, where the sentence is written. `null`/absent
   * is a backend that did not count, and it renders nothing rather than "not shared".
   */
  const sharedWith = formation.sharedWith ?? null;
  const confirmedReal = environment === "production";
  // Amber covers "sandbox" AND "unknown" — everything that is not a confirmed real filing.
  const sandbox = environment === "sandbox";
  const documents = formation.documents ?? [];
  const requiredActions = formation.requiredActions ?? [];

  return (
    <Card className={cx("p-5", !confirmedReal && "border-[#febc2e]/25 bg-[#febc2e]/[0.04]")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Legal formation</SectionTitle>
        {confirmedReal ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border hairline-strong bg-paper-3/60 px-3 py-1 text-[11.5px] text-muted-2">
            Production filing
          </span>
        ) : (
          <AmberPill>
            {sandbox ? "Demo formation (sandbox)" : "Filing environment not reported"}
          </AmberPill>
        )}
      </div>

      <div
        className={cx(
          "mt-3 text-[13px] leading-[1.5]",
          statusTone(formation.status, environment),
        )}
      >
        {statusHeadline(formation.status, environment)}
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-muted-2">
        {statusDetail(formation.status, environment)}
      </p>

      <dl className="mt-4 flex flex-col gap-3 text-[12.5px]">
        <FactRow k="Filing agent" v={formation.provider} />
        {formation.providerRef && <FactRow k="Provider reference" v={formation.providerRef} mono />}
        {/* The view carries unix SECONDS; the shared formatter takes milliseconds and the
            conversion is written here, where the unit is visible. */}
        <FactRow k="Filed" v={formation.filedAt ? formatDate(formation.filedAt * 1000) : "—"} />
        <FactRow k="Filing number" v={formation.filingNumber ?? "—"} mono={!!formation.filingNumber} />
        {/* Owner-visible only: the authenticated entity view is the ONLY surface that carries it,
            and this dashboard is the only place it is rendered. */}
        <FactRow k="EIN" v={formation.ein ?? "—"} mono={!!formation.ein} />
        {sharedWith !== null && (
          <FactRow
            k="Shared with"
            v={
              sharedWith > 1
                ? `${sharedWith - 1} other agent${sharedWith === 2 ? "" : "s"}`
                : "No other agents"
            }
          />
        )}
      </dl>

      {/* The filing has STOPPED and is waiting on this owner. It sits above the documents, and
          it links rather than duplicating the forms: an identity edited in two places is an
          identity edited in the wrong one. */}
      {parked.length > 0 && companyId && (
        <div className="mt-5 rounded-xl border border-[#febc2e]/30 bg-[#febc2e]/[0.07] px-4 py-3">
          <div className="text-[12px] font-medium text-ink">
            This filing has stopped and is waiting on you
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {parked.map((k) => (
              <li key={k} className="text-[11.5px] leading-[1.5] text-[#f3cd72]">
                {parkSummary(copy, k)}
              </li>
            ))}
          </ul>
          <Link
            href={`/agents/companies/${encodeURIComponent(companyId)}`}
            className="mt-3 inline-flex text-[11.5px] text-accent-soft underline-offset-2 hover:underline"
          >
            Open the company to fix it →
          </Link>
        </div>
      )}

      {requiredActions.length > 0 && (
        <div className="mt-5 rounded-xl border border-[#febc2e]/30 bg-[#febc2e]/[0.07] px-4 py-3">
          <div className="text-[12px] font-medium text-ink">Action needed before this can file</div>
          <ul className="mt-2 flex flex-col gap-2">
            {requiredActions.map((code) => (
              <li key={code} className="text-[11.5px] leading-[1.5] text-[#f3cd72]">
                {requiredActionCopy(code)}
                <span className="ml-1.5 font-mono text-[10.5px] text-muted-2">{code}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 border-t hairline pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle>Legal documents{sandbox && " (demo)"}</SectionTitle>
          {companyId && (
            <Link
              href={`/agents/companies/${encodeURIComponent(companyId)}`}
              className="text-[11.5px] text-muted transition-colors hover:text-ink"
            >
              The company →
            </Link>
          )}
        </div>
        <DocumentList
          companyId={companyId ?? null}
          documents={documents}
          emptyNote="None yet. The filing agent produces the Articles of Organization and the Operating Agreement once the company is filed; they appear here, and their hashes go into the next version of the on-chain anchor."
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */


/** Amber for everything that is not a CONFIRMED real filing — never the confirmed colour,
 *  whatever the sub-status says, never for an environment we could not read, and never for a
 *  status this build has never heard of. */
function statusTone(status: FormationStatus, environment: FormationEnvironment): string {
  const tone = filingTone(environment, status);
  if (tone === "failed") return "text-[#ff8a84]";
  if (!mayRenderConfirmed(tone)) return "text-[#f3cd72]";
  if (status === "filed" || status === "complete") return "text-emerald-300";
  return "text-muted";
}

/**
 * The status line, with a DEFAULT branch.
 *
 * The switches below are exhaustive over the union this build compiled against, which is not the
 * same thing as exhaustive over what the backend sends: the backend derives this status in
 * `src/formation/status.ts`, deploys independently of the interface, and there is a window after
 * every backend release where a new state arrives that this bundle has never heard of. Without a
 * default the function returned `undefined` and the card rendered a blank line where the legal
 * status of a company should be — silence being the worst possible answer to "is this filed?".
 */
function statusHeadline(status: FormationStatus, environment: FormationEnvironment): string {
  const demo = environment === "sandbox";
  const real = environment === "production";
  switch (status) {
    case "none":
      return "Not started";
    case "in_progress":
      return demo ? "Demo filing in progress" : "Filing in progress";
    // "the company legally exists" is a CLAIM, and it needs a confirmed production environment
    // behind it. Unknown gets the bare fact the sub-saga reported and nothing added to it.
    case "filed":
      return demo
        ? "Demo filed — nothing legally exists"
        : real
          ? "Filed — the company legally exists"
          : "Filed";
    case "complete":
      return demo
        ? "Demo complete — sandbox EIN issued"
        : real
          ? "Complete — EIN issued"
          : "Complete";
    case "failed":
      return "Filing failed";
    default:
      return "Unknown state — contact the operator";
  }
}

function statusDetail(status: FormationStatus, environment: FormationEnvironment): string {
  if (environment === "sandbox") {
    return "This deployment files in the provider's sandbox. No state register was touched, the documents are demo documents, and the EIN is not a tax identifier.";
  }
  if (environment !== "production") {
    return "This record does not say which environment it was filed in, so nothing here claims the company does or does not legally exist. Treat the documents and any EIN below as unverified and contact the operator.";
  }
  switch (status) {
    case "none":
      return "Nothing has been opened with the filing agent for this entity yet.";
    case "in_progress":
      return "The filing agent has the request. Nothing is legally true until the state files it.";
    case "filed":
      return "The state has filed the company. The EIN follows from the IRS, which typically takes weeks.";
    case "complete":
      return "The company is filed and the IRS has issued its EIN. No further legal fact follows.";
    case "failed":
      return "Nothing was filed and the step that would have filed it is in error. Contact the operator.";
    default:
      return "This deployment reported a formation state this page does not recognise, so nothing here describes what it means. The operator can say what it is.";
  }
}


