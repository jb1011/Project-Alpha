"use client";

import { useEffect, useState } from "react";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/Nav";
import { SectionLabel } from "@/components/landing/SectionLabel";
import { getTransparency } from "@/lib/api/client";
import type { TransparencyEntity, TransparencyView } from "@/lib/api/types";
import { API_URL } from "@/lib/api/config";
import { addressUrl } from "@/lib/chain";

/** Atomic USDC (6 decimals) -> "1,234.56". Display-only, so float precision is fine. */
function formatAtomicUsdc(atomic: string): string {
  const n = Number(atomic) / 1e6;
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border hairline bg-paper p-6">
      <div className="text-[32px] font-medium tabular-nums tracking-[-0.02em] sm:text-[40px]">
        {value}
      </div>
      <div className="mt-1 text-[13px] uppercase tracking-[0.18em] text-muted-2">
        {label}
      </div>
    </div>
  );
}

function HumanChip({ entity }: { entity: TransparencyEntity }) {
  // A waiver grants access, not personhood — the backend already reports it as humanVerified:false,
  // and it must never wear the verified green here either. Amber, named for what it is.
  if (entity.credential === "waiver") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/35 bg-amber-300/[0.08] px-2.5 py-1 text-[12px] text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        Waiver on record · not verified
      </span>
    );
  }
  if (entity.humanVerified) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-accent/[0.08] px-2.5 py-1 text-[12px] text-accent-soft">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        Human-verified{entity.credential ? ` · ${entity.credential}` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border hairline-strong px-2.5 py-1 text-[12px] text-muted">
      Unverified
    </span>
  );
}

function VerifyLinks({ entity }: { entity: TransparencyEntity }) {
  const links: { label: string; href: string }[] = [];
  if (entity.legalManager)
    links.push({ label: "LegalManager", href: addressUrl(entity.legalManager) });
  if (entity.treasury)
    links.push({ label: "Treasury", href: addressUrl(entity.treasury) });
  if (entity.publicId)
    links.push({ label: "Metadata", href: `${API_URL}/metadata/${entity.publicId}` });
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noreferrer"
          className="whitespace-nowrap text-[13px] text-accent underline-offset-2 hover:underline"
        >
          {l.label} ↗
        </a>
      ))}
    </span>
  );
}

export default function TransparencyPage() {
  const [view, setView] = useState<TransparencyView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTransparency()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main className="flex flex-1 flex-col">
        <section className="relative bg-paper">
          <div className="mx-auto max-w-[1240px] px-6 py-20 lg:px-10 lg:py-28">
            <SectionLabel index="01" label="Transparency" />
            <h1 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] sm:text-[48px]">
              Every agent entity, publicly verifiable.
            </h1>
            <p className="mt-5 max-w-2xl text-[16px] leading-[1.6] text-muted">
              Novi Corpus runs on Arc testnet. Every entity below is a real
              on-chain deployment: its own governance contracts, an ERC-8004
              identity, and USDC job settlements. Nothing on this page requires
              trusting us: every row links to Arcscan.
            </p>
          </div>
        </section>

        <section className="border-t hairline bg-paper-2">
          <div className="mx-auto max-w-[1240px] px-6 py-14 lg:px-10 lg:py-16">
            {failed ? (
              <p className="text-[15px] text-muted">
                Couldn&apos;t load the registry. The API may be briefly
                unreachable — please try again in a moment.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatTile
                  label="Agent entities on Arc"
                  value={view ? String(view.stats.entities) : "—"}
                />
                <StatTile
                  label="Jobs settled"
                  value={view ? String(view.stats.jobsSettled) : "—"}
                />
                <StatTile
                  label="USDC settled"
                  value={view ? `$${formatAtomicUsdc(view.stats.usdcSettledAtomic)}` : "—"}
                />
              </div>
            )}
          </div>
        </section>

        <section className="border-t hairline bg-paper">
          <div className="mx-auto max-w-[1240px] px-6 py-16 lg:px-10 lg:py-20">
            <h2 className="text-[24px] font-medium tracking-[-0.01em]">
              The entity registry
            </h2>
            <p className="mt-3 max-w-2xl text-[15px] leading-[1.65] text-muted">
              Each entity is deployed by our factory as a LegalManager
              (governance) plus an immutable AgentTreasury (spending rules), and
              registered in the ERC-8004 identity registry. A human-verified
              badge means the guardian behind the entity proved unique
              personhood with World ID.
            </p>

            {view && view.entities.length > 0 && (
              <div className="mt-8 overflow-x-auto rounded-2xl border hairline">
                <table className="w-full min-w-[880px] border-collapse text-left">
                  <thead>
                    <tr className="border-b hairline bg-paper-2 text-[11px] uppercase tracking-[0.18em] text-muted-2">
                      <th className="px-4 py-3 font-normal">Entity</th>
                      <th className="px-4 py-3 font-normal">Agent ID</th>
                      <th className="px-4 py-3 font-normal">Accountable human</th>
                      <th className="px-4 py-3 font-normal">Custody</th>
                      <th className="px-4 py-3 font-normal">Jobs · USDC</th>
                      <th className="px-4 py-3 font-normal">Verify on-chain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.entities.map((e) => (
                      <tr
                        key={e.agentId}
                        className="border-b hairline last:border-b-0"
                      >
                        <td className="px-4 py-3.5">
                          <div className="text-[14.5px] font-medium">{e.name}</div>
                          {e.createdAt && (
                            <div className="mt-0.5 text-[12px] text-muted-2">
                              {e.createdAt.slice(0, 10)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3.5 font-mono text-[13.5px] text-muted">
                          #{e.agentId}
                        </td>
                        <td className="px-4 py-3.5">
                          <HumanChip entity={e} />
                        </td>
                        <td className="px-4 py-3.5 text-[13.5px] text-muted">
                          {e.walletProvider === "circle" ? "Circle wallet" : "Turnkey"}
                        </td>
                        <td className="px-4 py-3.5 text-[13.5px] tabular-nums text-muted">
                          {e.jobsSettled} · ${formatAtomicUsdc(e.usdcSettledAtomic)}
                        </td>
                        <td className="px-4 py-3.5">
                          <VerifyLinks entity={e} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {view && view.entities.length === 0 && (
              <p className="mt-8 text-[15px] text-muted">
                No entities yet on this deployment.
              </p>
            )}
            {!view && !failed && (
              <p className="mt-8 text-[15px] text-muted-2">Loading registry…</p>
            )}
          </div>
        </section>

        <section className="border-t hairline bg-paper-2">
          <div className="mx-auto max-w-[1240px] px-6 py-16 lg:px-10 lg:py-20">
            <h2 className="text-[24px] font-medium tracking-[-0.01em]">
              Honest numbers, by design
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-[1.65] text-muted">
              These are testnet figures from a guarded beta, not vanity
              metrics. Legal formation is simulated until Arc mainnet; the
              on-chain governance, identity, and USDC settlement around each
              entity are real and independently checkable. This page will carry
              the same role on mainnet: if we claim it, you can verify it.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
