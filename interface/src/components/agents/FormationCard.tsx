"use client";

import { useState } from "react";
import { downloadDocument } from "@/lib/api/client";
import type { EntityView, FormationDocument } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Card, Spinner, cx } from "@/components/onboarding/primitives";

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

  const sandbox = formation.environment === "sandbox";
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
    <Card className={cx("p-5", sandbox && "border-[#febc2e]/25 bg-[#febc2e]/[0.04]")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">Legal formation</div>
        {sandbox ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#febc2e]/40 bg-[#febc2e]/10 px-3 py-1 text-[11.5px] text-[#f3cd72]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#febc2e]" />
            Demo formation (sandbox)
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border hairline-strong bg-paper-3/60 px-3 py-1 text-[11.5px] text-muted-2">
            Production filing
          </span>
        )}
      </div>

      <div
        className={cx(
          "mt-3 text-[13px] leading-[1.5]",
          statusTone(formation.status, sandbox),
        )}
      >
        {statusHeadline(formation.status, sandbox)}
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-muted-2">
        {statusDetail(formation.status, sandbox)}
      </p>

      <dl className="mt-4 flex flex-col gap-3 text-[12.5px]">
        <Row k="Filing agent" v={formation.provider} />
        {formation.providerRef && <Row k="Provider reference" v={formation.providerRef} mono />}
        <Row k="Filed" v={formation.filedAt ? formatDate(formation.filedAt) : "—"} />
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
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
          Legal documents{sandbox && " (demo)"}
        </div>
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

/** Amber for every sandbox state — never the confirmed colour, whatever the sub-status says. */
function statusTone(status: Formation["status"], sandbox: boolean): string {
  if (status === "failed") return "text-[#ff8a84]";
  if (sandbox) return "text-[#f3cd72]";
  if (status === "filed" || status === "complete") return "text-emerald-300";
  return "text-muted";
}

function statusHeadline(status: Formation["status"], sandbox: boolean): string {
  switch (status) {
    case "none":
      return "Not started";
    case "in_progress":
      return sandbox ? "Demo filing in progress" : "Filing in progress";
    case "filed":
      return sandbox ? "Demo filed — nothing legally exists" : "Filed — the company legally exists";
    case "complete":
      return sandbox ? "Demo complete — sandbox EIN issued" : "Complete — EIN issued";
    case "failed":
      return "Filing failed";
  }
}

function statusDetail(status: Formation["status"], sandbox: boolean): string {
  if (sandbox) {
    return "This deployment files in the provider's sandbox. No state register was touched, the documents are demo documents, and the EIN is not a tax identifier.";
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

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
