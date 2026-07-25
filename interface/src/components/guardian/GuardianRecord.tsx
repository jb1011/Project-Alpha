"use client";

import * as React from "react";
import type { WorldIdMe } from "@/lib/api/types";
import { PersonhoodSeal } from "@/components/guardian/PersonhoodSeal";
import { WorldErrorNote } from "@/components/guardian/WorldErrorNote";
import { Button, cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

/**
 * The guardian record, presentation only — the page owns session state and World's widget.
 * Kept separate so the instrument can be rendered against fixed data for design review.
 */
export function GuardianRecord({
  me,
  address,
  busy,
  loading,
  struck,
  error,
  onVerify,
}: {
  me: WorldIdMe | null;
  address?: string;
  busy: boolean;
  loading: boolean;
  struck: boolean;
  error: string | null;
  onVerify: () => void;
}) {
  const verified = me?.verified ?? false;
  const seed = me?.nullifier ?? address ?? "novi-corpus";

  return (
    <div className="mx-auto max-w-[1000px]">
      <div className="overflow-hidden rounded-2xl border hairline bg-paper-2/40 backdrop-blur-sm">
        {/* The instrument head: the mark, and who it binds */}
        <div className="flex flex-col items-center gap-8 p-6 text-center sm:flex-row sm:gap-11 sm:p-9 sm:text-left">
          <div className="h-[170px] w-[170px] shrink-0 sm:h-[188px] sm:w-[188px]">
            <PersonhoodSeal seed={seed} verified={verified} struck={struck} />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* The chip holds the far edge of the head, so the composition has two anchors. */}
            <div className="flex items-center justify-center gap-3 sm:justify-between">
              <span className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">
                Proof of personhood
              </span>
              <StatusChip verified={verified} loading={loading} />
            </div>

            <h1 className="text-balance text-[28px] font-medium leading-[1.08] tracking-[-0.025em] text-ink sm:text-[34px]">
              {loading
                ? "Reading your record…"
                : verified
                  ? "A human is on record."
                  : "No human is on record."}
            </h1>

            <p className="max-w-[54ch] text-pretty text-[13.5px] leading-[1.65] text-muted">
              Wyoming law requires a natural person behind every DAO LLC. World ID proves one
              unique human is here — and tells us nothing else about them.
            </p>

            <div className="flex flex-col items-center gap-3 pt-1 sm:flex-row sm:gap-5">
              <Button
                variant={verified ? "ghost" : "primary"}
                onClick={onVerify}
                loading={busy}
                disabled={loading}
              >
                {verified ? "Verify again" : "Verify with World ID"}
              </Button>
              <dl className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11.5px] text-muted-2 sm:justify-start">
                {address && (
                  <div className="flex gap-1.5">
                    <dt>Wallet</dt>
                    <dd className="tabular-nums text-muted">{shortAddress(address)}</dd>
                  </div>
                )}
                {verified && me?.verifiedAt && (
                  <div className="flex gap-1.5">
                    <dt>Struck</dt>
                    <dd className="tabular-nums text-muted">{formatDate(me.verifiedAt)}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </div>

        {/* Standing, at a glance */}
        <div className="grid divide-y divide-line border-t hairline sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <LedgerCell label="Standing">
            <span
              className={cx(
                "flex items-center gap-2 text-[14px]",
                verified ? "text-emerald-300" : "text-muted",
              )}
            >
              <span
                aria-hidden
                className={cx(
                  "h-1.5 w-1.5 rounded-full",
                  verified ? "bg-emerald-300" : "bg-muted-2",
                )}
              />
              {verified ? "Accountable human" : "Not on record"}
            </span>
          </LedgerCell>

          <LedgerCell label="Credential" hint="Orb or document grade">
            <span className="text-[14px] text-ink">
              {verified ? (me?.credential ?? "verified") : "—"}
            </span>
          </LedgerCell>

          <LedgerCell
            label="Legal entities"
            hint={
              me?.maxEntities != null
                ? `this account is capped at ${me.maxEntities}`
                : "no ceiling — one human may form as many as they like"
            }
          >
            <div className="flex items-center gap-3">
              <span className="tabular-nums text-[14px] text-ink">
                {verified || me?.entitiesUsed != null
                  ? me?.maxEntities != null
                    ? `${me.entitiesUsed ?? 0} / ${me.maxEntities}`
                    : `${me?.entitiesUsed ?? 0}`
                  : "—"}
              </span>
              {me?.maxEntities != null && <Pips used={me.entitiesUsed ?? 0} max={me.maxEntities} />}
            </div>
          </LedgerCell>
        </div>

        {/* What we hold, and what it binds */}
        <div className="grid divide-y divide-line border-t hairline md:grid-cols-2 md:divide-x md:divide-y-0">
          <section className="flex flex-col gap-3 p-6 sm:p-7">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">
                What we hold on you
              </h2>
              {verified && me?.nullifier && <CopyLine value={me.nullifier} />}
            </div>

            {verified && me?.nullifier ? (
              <code className="block break-all rounded-xl border hairline bg-paper/60 px-3.5 py-3 font-mono text-[11.5px] leading-[1.7] text-emerald-300/90">
                {me.nullifier}
              </code>
            ) : (
              <div className="rounded-xl border border-dashed border-line-strong bg-paper/40 px-3.5 py-5 text-center text-[12px] text-muted-2">
                Nothing on file
              </div>
            )}

            <p className="text-[12.5px] leading-[1.65] text-muted">
              A nullifier: one value, unique to you inside Novi Corpus and meaningless anywhere
              else. It is the whole of your identity here — no name, no document, no wallet
              linkage.
            </p>

            {/* Says out loud where the mark above comes from. */}
            <div className="mt-auto flex items-center gap-3 border-t hairline pt-4">
              <div className="h-11 w-11 shrink-0 opacity-90">
                <PersonhoodSeal seed={seed} verified={verified} compact />
              </div>
              <p className="text-[11.5px] leading-[1.55] text-muted-2">
                {verified
                  ? "Your mark is drawn from this value. The same human always strikes the same figure."
                  : "Your mark is struck from that value the moment you verify."}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-4 p-6 sm:p-7">
            <h2 className="text-[10.5px] uppercase tracking-[0.24em] text-muted-2">
              What the record binds
            </h2>
            <dl className="flex flex-col gap-3.5">
              <Clause term="Control">
                Every agent under this account inherits a named controller who can pause it, claw
                back its funds, and dissolve the company.
              </Clause>
              <Clause term="Uniqueness">
                One person cannot quietly run many accounts. The same human is refused a second
                guardianship.
              </Clause>
              <Clause term="Privacy">
                The proof travels without you. We learn that a unique human verified, never which
                one.
              </Clause>
            </dl>
          </section>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <WorldErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function StatusChip({ verified, loading }: { verified: boolean; loading: boolean }) {
  const label = loading ? "Reading" : verified ? "In force" : "Unstruck";
  return (
    <span
      className={cx(
        "rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em]",
        verified
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
          : "border-line-strong bg-paper-3/70 text-muted-2",
      )}
    >
      {label}
    </span>
  );
}

function LedgerCell({
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

/** A configured cap is a real limit, so it gets a shape and not only a number. */
function Pips({ used, max }: { used: number; max: number }) {
  if (max > 12) return null;
  // Already past the ceiling (a cap lowered after the fact) — a row of pips would imply headroom.
  if (used > max) return <span className="text-[11px] text-[#f3cd72]">over the cap</span>;
  return (
    <div aria-hidden className="flex gap-1">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={`pip-${max}-${i}`}
          className={cx(
            "h-1.5 w-5 rounded-full transition-colors",
            i < used ? "bg-emerald-300/85" : "bg-line-strong",
          )}
        />
      ))}
    </div>
  );
}

function Clause({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-l hairline-strong pl-3.5">
      <dt className="text-[10.5px] uppercase tracking-[0.2em] text-muted-2">{term}</dt>
      <dd className="text-[12.5px] leading-[1.65] text-muted">{children}</dd>
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="self-start rounded-full px-2 py-1 text-[11px] text-muted-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {copied ? "Copied" : "Copy nullifier"}
    </button>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

