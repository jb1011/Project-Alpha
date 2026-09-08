"use client";

import { useState } from "react";
import { downloadDocument } from "@/lib/api/client";
import type { FormationDocument } from "@/lib/api/types";
import { formatBytes, humanDocType } from "@/lib/formation/documents";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Spinner } from "@/components/onboarding/primitives";

/**
 * THE LEGAL DOCUMENTS, and the one way to fetch their bytes (design §7).
 *
 * Two surfaces list them — the agent dashboard's `FormationCard` and the company page — and both
 * held their own copy of the same forty lines: the busy id, the error string, the fetch → blob →
 * objectURL dance (an `<a href>` cannot carry a Bearer token and the route is owner-only), and
 * the `URL.revokeObjectURL` that keeps a downloaded PDF from being pinned in memory for the life
 * of the tab. Two copies of a download is two chances to forget the revoke, or to build the URL
 * out of an entity key the route stopped taking in A3.
 *
 * The download STATE belongs here rather than to either caller, because it is state about this
 * list and nothing else: which row is in flight, and what went wrong.
 */
export function DocumentList({
  companyId,
  documents,
  emptyNote,
}: {
  /** The route is COMPANY-keyed since A3 — documents belong to the FILING, not to an agent. A
   *  backend that predates the field reports none, and the buttons say so rather than 404ing. */
  companyId: string | null;
  documents: FormationDocument[];
  emptyNote: string;
}) {
  const { session } = useAuth();
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(doc: FormationDocument) {
    const token = session?.token;
    if (!token) {
      setError("Sign in again to download documents.");
      return;
    }
    if (!companyId) {
      setError("This deployment does not report which company these documents belong to yet.");
      return;
    }
    setError(null);
    setBusyDocId(doc.id);
    try {
      // fetch → blob → objectURL, because an `<a href>` cannot carry a Bearer token and this
      // route is owner-only. The filename comes from the response when the proxy forwarded the
      // header, and from the document's own derived name when it did not.
      const { blob, filename } = await downloadDocument(token, companyId, doc.id);
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

  if (documents.length === 0)
    return <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">{emptyNote}</p>;

  return (
    <>
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
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border hairline-strong px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyDocId === doc.id && <Spinner className="h-3 w-3" />}
              {busyDocId === doc.id ? "Downloading…" : "Download PDF"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-[11.5px] leading-[1.4] text-[#ff8a84]">{error}</p>}
    </>
  );
}
