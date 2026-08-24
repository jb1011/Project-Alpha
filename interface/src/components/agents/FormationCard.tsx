"use client";

import { useState } from "react";
import { downloadDocument } from "@/lib/api/client";
import {
  formationEnvironmentOf,
  type FormationEnvironment,
} from "@/lib/api/formationEnvironment";
import type { EntityView, FormationDocument } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { AmberPill, Card, SectionTitle, Spinner, cx } from "@/components/onboarding/primitives";

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
export function FormationCard({
  entityId,
  formation,
}: {
  entityId: string;
  formation: Formation;
}) {
  const { session } = useAuth();
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const environment = formationEnvironmentOf(formation.environment);
  const confirmedReal = environment === "production";
  // Amber covers "sandbox" AND "unknown" — everything that is not a confirmed real filing.
  const sandbox = environment === "sandbox";
  const documents = formation.documents ?? [];
  const requiredActions = formation.requiredActions ?? [];

  async function download(doc: FormationDocument) {
    const token = session?.token;
    if (!token) {
      setError("Sign in again to download documents.");
      return;
    }
    setError(null);
    setBusyDocId(doc.id);
    try {
      // fetch -> blob -> objectURL, because an `<a href>` cannot carry a Bearer token and this
      // route is owner-only. The filename comes from the response when the proxy forwarded the
      // header, and from the document's own derived name when it did not.
      const { blob, filename } = await downloadDocument(token, entityId, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? doc.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download the document.");
    } finally {
      setBusyDocId(null);
    }
  }

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
        <Row k="Filing agent" v={formation.provider} />
        {formation.providerRef && <Row k="Provider reference" v={formation.providerRef} mono />}
        {/* The view carries unix SECONDS; the shared formatter takes milliseconds and the
            conversion is written here, where the unit is visible. */}
        <Row k="Filed" v={formation.filedAt ? formatDate(formation.filedAt * 1000) : "—"} />
        <Row k="Filing number" v={formation.filingNumber ?? "—"} mono={!!formation.filingNumber} />
        {/* Owner-visible only: the authenticated entity view is the ONLY surface that carries it,
            and this dashboard is the only place it is rendered. */}
        <Row k="EIN" v={formation.ein ?? "—"} mono={!!formation.ein} />
      </dl>

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
        <SectionTitle>Legal documents{sandbox && " (demo)"}</SectionTitle>
        {documents.length === 0 ? (
          <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
            None yet. The filing agent produces the Articles of Organization and the Operating
            Agreement once the company is filed; they appear here, and their hashes go into the
            next version of the on-chain anchor.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {documents.map((doc) => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border hairline bg-paper/50 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] text-ink">{humanDocType(doc.type)}</div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-2">
                    sha256 {doc.sha256.slice(0, 18)}… · {formatBytes(doc.size)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void download(doc)}
                  disabled={busyDocId !== null}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border hairline-strong px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyDocId === doc.id && <Spinner className="h-3 w-3" />}
                  {busyDocId === doc.id ? "Downloading…" : "Download PDF"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mt-2 text-[11.5px] leading-[1.4] text-[#ff8a84]">{error}</p>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-2">{k}</dt>
      <dd className={cx("min-w-0 truncate text-right text-ink", mono && "font-mono text-[11.5px]")}>
        {v}
      </dd>
    </div>
  );
}

/** Amber for everything that is not a CONFIRMED real filing — never the confirmed colour,
 *  whatever the sub-status says, and never for an environment we could not read. */
function statusTone(status: Formation["status"], environment: FormationEnvironment): string {
  if (status === "failed") return "text-[#ff8a84]";
  if (environment !== "production") return "text-[#f3cd72]";
  if (status === "filed" || status === "complete") return "text-emerald-300";
  return "text-muted";
}

function statusHeadline(status: Formation["status"], environment: FormationEnvironment): string {
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
  }
}

function statusDetail(status: Formation["status"], environment: FormationEnvironment): string {
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
  }
}

/**
 * The two required-action codes the provider can raise, in plain language.
 *
 * The CODE is always shown beside the sentence: the sentence is ours and can go stale, and the
 * code is what an operator searches for. An unrecognised code renders as itself rather than as a
 * guess — the view deliberately never carries the provider's free-text reason, which their
 * operators write and which can name the responsible party.
 */
function requiredActionCopy(code: string): string {
  switch (code) {
    case "FORMATION_NAME_OPTIONS_EXHAUSTED":
      return "Every company name you offered was rejected by the state. New name options are needed before this can file.";
    case "FORMATION_SIGNATURE_SS4_RESET":
      return "The SS-4 signature session expired. A replacement signature is needed; this closes itself once you complete it.";
    default:
      return "The filing agent is waiting on something before this can proceed:";
  }
}

function humanDocType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
