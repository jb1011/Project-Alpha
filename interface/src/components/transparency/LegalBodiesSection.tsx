"use client";

import { shortAddress } from "@/components/onboarding/types";
import type { TransparencyView } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { transparencyRow, transparencySection } from "@/lib/legalBody/transparency";

const T = LEGAL_BODY_COPY.transparency;

const LINK_CLASS = "whitespace-nowrap text-[13px] text-accent underline-offset-2 hover:underline";

/**
 * The legal bodies on customer-owned identities, on the public transparency page.
 *
 * It reads the view the page already fetched and decides on the view's own legal-body keys
 * (`transparencySection`): nothing at all on a backend without them or when the page's one fetch
 * failed, a sentence when the list could not be read or is empty, otherwise the table. Every word
 * and tone comes from `src/lib/legalBody`; this component decides nothing.
 */
export function LegalBodiesSection({
  view,
  failed,
}: {
  view: TransparencyView | null;
  failed: boolean;
}) {
  const section = transparencySection(view, failed);
  if (section.kind === "absent") return null;

  return (
    <section className="border-t hairline bg-paper">
      <div className="mx-auto max-w-[1240px] px-6 py-16 lg:px-10 lg:py-20">
        <h2 className="text-[24px] font-medium tracking-[-0.01em]">{T.heading}</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.65] text-muted">{T.intro}</p>

        {section.kind === "unavailable" && (
          <p className="mt-8 text-[15px] text-muted">{T.unavailable}</p>
        )}

        {section.kind === "empty" && <p className="mt-8 text-[15px] text-muted">{T.empty}</p>}

        {section.kind === "rows" && (
          <div className="mt-8 overflow-x-auto rounded-2xl border hairline">
            <table className="w-full min-w-[960px] border-collapse text-left">
              <thead>
                <tr className="border-b hairline bg-paper-2 text-[11px] uppercase tracking-[0.18em] text-muted-2">
                  <th className="px-4 py-3 font-normal">{T.columns.agentId}</th>
                  <th className="px-4 py-3 font-normal">{T.columns.legalName}</th>
                  <th className="px-4 py-3 font-normal">{T.columns.filingNumber}</th>
                  <th className="px-4 py-3 font-normal">{T.columns.body}</th>
                  <th className="px-4 py-3 font-normal">{T.columns.linkedSince}</th>
                  <th className="px-4 py-3 font-normal">{T.columns.environment}</th>
                  <th className="px-4 py-3 font-normal">{T.columns.statement}</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((raw) => {
                  const r = transparencyRow(raw);
                  return (
                    <tr key={r.key} className="border-b hairline last:border-b-0">
                      <td className="px-4 py-3.5 font-mono text-[13.5px] text-muted">#{r.agentId}</td>
                      <td className="px-4 py-3.5 text-[14.5px] font-medium">{r.legalName}</td>
                      <td className="px-4 py-3.5 font-mono text-[13.5px] text-muted">{r.filingNumber}</td>
                      <td className="px-4 py-3.5 font-mono text-[13px]">
                        {r.body.href ? (
                          <a
                            href={r.body.href}
                            target="_blank"
                            rel="noreferrer"
                            title={r.body.address}
                            className={LINK_CLASS}
                          >
                            {shortAddress(r.body.address)} ↗
                          </a>
                        ) : (
                          <span className="break-all text-muted">{r.body.address}</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-[13.5px] tabular-nums text-muted">{r.linkedSince}</td>
                      <td className="px-4 py-3.5">
                        {r.environment.tone === "amber" ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/35 bg-amber-300/[0.08] px-2.5 py-1 text-[12px] text-amber-300">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                            {r.environment.label}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border hairline-strong px-2.5 py-1 text-[12px] text-muted">
                            {r.environment.label}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        {r.statement.href ? (
                          <a
                            href={r.statement.href}
                            target="_blank"
                            rel="noreferrer"
                            title={r.statement.text}
                            className={LINK_CLASS}
                          >
                            {T.statementLink} ↗
                          </a>
                        ) : (
                          <span className="break-all font-mono text-[12.5px] text-muted">
                            {r.statement.text}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
