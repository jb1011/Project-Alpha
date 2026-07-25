"use client";

import Link from "next/link";
import * as React from "react";
import { PersonhoodSeal } from "@/components/guardian/PersonhoodSeal";
import { cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";
import type { WorldIdMe } from "@/lib/api/types";

/**
 * The tenant of record — one instrument, same grammar as the guardian page: the account's
 * identity at the head, its standing in a ledger strip, then what operates under it. Presentation
 * only; the page owns the data and passes the connection/passkey panels in as slots.
 */
export function TenantRecord({
  address,
  ensName,
  me,
  entityCount,
  connections,
  passkeys,
}: {
  address?: string;
  /** ENS primary name for the wallet, when it has one. */
  ensName?: string | null;
  me: WorldIdMe | null;
  entityCount: number | null;
  connections: React.ReactNode;
  passkeys: React.ReactNode;
}) {
  const verified = me?.verified ?? false;
  const formationReady = me?.formationReady ?? false;

  return (
    <div className="mx-auto max-w-[1000px]">
      <div className="overflow-hidden rounded-2xl border hairline bg-paper-2/40 backdrop-blur-sm">
        {/* Head — whose account this is */}
        <div className="flex flex-col items-center gap-6 p-6 text-center sm:flex-row sm:items-center sm:gap-8 sm:p-8 sm:text-left">
          <div className="h-[92px] w-[92px] shrink-0">
            <PersonhoodSeal seed={me?.nullifier ?? address ?? "novi-corpus"} verified={verified} />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex items-center justify-center gap-3 sm:justify-between">
              <span className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">
                Tenant of record
              </span>
              <span
                className={cx(
                  "rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em]",
                  verified
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                    : "border-line-strong bg-paper-3/70 text-muted-2",
                )}
              >
                {verified ? "Human-backed" : "No human on record"}
              </span>
            </div>

            <h1 className="text-balance text-[26px] font-medium leading-[1.1] tracking-[-0.02em] text-ink sm:text-[30px]">
              {address ? <AddressTitle address={address} ensName={ensName} /> : "Your account"}
            </h1>

            <p className="max-w-[58ch] text-pretty text-[13px] leading-[1.65] text-muted">
              Everything under this account — its agents, connections, and keys — acts in the name
              of this wallet, and answers to the human behind it.
            </p>
          </div>
        </div>

        {/* Standing */}
        <div
          className={cx(
            "grid divide-y divide-line border-t hairline sm:divide-x sm:divide-y-0",
            formationReady ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3",
          )}
        >
          <Cell label="Guardian">
            <Link
              href="/guardian"
              className={cx(
                "group flex items-center gap-2 text-[14px]",
                verified ? "text-emerald-300" : "text-muted",
              )}
            >
              <span
                aria-hidden
                className={cx("h-1.5 w-1.5 rounded-full", verified ? "bg-emerald-300" : "bg-muted-2")}
              />
              <span className="underline-offset-2 group-hover:underline">
                {verified ? "Accountable human" : "Verify on the guardian page"}
              </span>
            </Link>
          </Cell>

          <Cell label="Credential" hint={verified ? "proof of personhood" : "none yet"}>
            <span className="text-[14px] text-ink">{verified ? (me?.credential ?? "verified") : "—"}</span>
          </Cell>

          <Cell label="Legal entities" hint="agents under this account">
            <span className="tabular-nums text-[14px] text-ink">{entityCount ?? "—"}</span>
          </Cell>

          {formationReady && (
            <Cell label="Formation-ready" hint="adult, document-backed">
              <span className="text-[14px] text-emerald-300">Age {me?.attestation?.minAge ?? 18}+ proven</span>
            </Cell>
          )}
        </div>

        {/* What operates under it */}
        <Section
          label="Active connections"
          intro="Keys that let an agent or tool act across the whole tenant. Per-agent connections live on each agent's dashboard."
        >
          {connections}
        </Section>

        <Section
          label="Guardian passkeys"
          intro="Device passkeys that may authorize creating new agents. Revoking one never touches existing agents."
        >
          {passkeys}
        </Section>
      </div>
    </div>
  );
}

/** The account's name where ENS gives it one, the address where it doesn't. Either way the raw
 *  address stays one click from the clipboard — a readable name must never hide the real value. */
function AddressTitle({ address, ensName }: { address: string; ensName?: string | null }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  if (ensName) {
    return (
      <span className="flex flex-col items-center gap-1 sm:items-start">
        <span className="flex items-center gap-2.5">
          <span className="truncate">{ensName}</span>
          <span
            title="Resolved from this wallet's ENS primary name"
            className="shrink-0 rounded-full border border-accent/30 bg-accent/[0.07] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-accent-soft"
          >
            ens
          </span>
        </span>
        <button
          type="button"
          onClick={copy}
          className="group inline-flex items-center gap-2 font-mono text-[12px] font-normal tracking-normal text-muted-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <span>{shortAddress(address)}</span>
          <span className="text-[11px]">{copied ? "copied" : "copy"}</span>
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      title="Copy address"
      onClick={copy}
      className="group inline-flex max-w-full items-baseline gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <span className="hidden truncate font-mono text-[22px] tracking-tight lg:inline">{address}</span>
      <span className="font-mono text-[24px] tracking-tight lg:hidden">{shortAddress(address)}</span>
      <span className="shrink-0 text-[11px] text-muted-2 transition-colors group-hover:text-ink">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}

function Cell({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 p-5 sm:p-6">
      <span className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-[1.5] text-muted-2">{hint}</span>}
    </div>
  );
}

function Section({
  label,
  intro,
  children,
}: {
  label: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 border-t hairline p-6 sm:p-7">
      <div className="flex flex-col gap-1">
        <h2 className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">{label}</h2>
        <p className="max-w-[68ch] text-[11.5px] leading-[1.55] text-muted-2">{intro}</p>
      </div>
      {children}
    </section>
  );
}
