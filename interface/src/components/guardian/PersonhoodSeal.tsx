"use client";

import * as React from "react";
import { cx } from "@/components/onboarding/primitives";

/**
 * The guardian's mark of record.
 *
 * The bezel is constant — it belongs to Novi Corpus. The figure inside is derived from the
 * seed (the World ID nullifier), so it is the same every time for the same human and
 * different for everyone else: the record, drawn.
 */
export function PersonhoodSeal({
  seed,
  verified,
  struck = false,
  compact = false,
  className,
}: {
  seed: string;
  verified: boolean;
  /** One-shot strike animation, played the moment a verification lands. */
  struck?: boolean;
  /** Drops the fine engraving so the mark still reads at thumbnail size. */
  compact?: boolean;
  className?: string;
}) {
  const figure = React.useMemo(() => buildFigure(seed), [seed]);
  const ink = verified ? "#6ee7b7" : "var(--muted-2)";
  const ticks = compact ? BEZEL.filter((t) => t.major) : BEZEL;

  return (
    <svg
      viewBox="0 0 200 200"
      className={cx("h-full w-full", struck && "seal-settle", className)}
      role="img"
      aria-label={verified ? "Guardian seal, struck" : "Guardian seal, unstruck"}
    >
      <title>{verified ? "Guardian seal, struck" : "Guardian seal, unstruck"}</title>

      {/* Bloom — a single ring pushed outward at the moment of the strike. */}
      {struck && (
        <circle cx="100" cy="100" r="86" fill="none" stroke={ink} strokeWidth="1" className="seal-bloom" />
      )}

      {/* Outer rule — the edge of the seal, so the mark reads as struck metal and not a drawing */}
      <circle
        cx="100"
        cy="100"
        r="94"
        fill="none"
        stroke={verified ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.13)"}
        strokeWidth="1"
        strokeDasharray={verified ? undefined : "3 5"}
      />

      {/* Bezel ticks — turns slowly once a human is on record, still while the page waits. */}
      <g className={verified ? "seal-bezel" : undefined} opacity={verified ? 1 : 0.5}>
        {ticks.map((t) => (
          <line
            key={t.a}
            x1={100 + Math.cos(t.a) * (t.major ? 80 : 84)}
            y1={100 + Math.sin(t.a) * (t.major ? 80 : 84)}
            x2={100 + Math.cos(t.a) * 88}
            y2={100 + Math.sin(t.a) * 88}
            stroke={t.major ? ink : "rgba(255,255,255,0.17)"}
            strokeWidth={t.major ? 1.2 : 0.9}
            strokeLinecap="round"
          />
        ))}
      </g>

      {/* Inner rule — fine engraving, dropped at thumbnail size where it would only muddy */}
      {!compact && (
        <circle cx="100" cy="100" r="72" fill="none" stroke="var(--line)" strokeWidth="1" />
      )}

      {/* The figure. Hidden entirely until there is a human to draw. */}
      {verified && (
        <g>
          {!compact &&
            figure.spokes.map((s, i) => (
            <line
              key={s.key}
              x1={100 + Math.cos(s.a) * 12}
              y1={100 + Math.sin(s.a) * 12}
              x2={100 + Math.cos(s.a) * s.r}
              y2={100 + Math.sin(s.a) * s.r}
              stroke={ink}
              strokeWidth="0.9"
              strokeLinecap="round"
              opacity="0.42"
              className={struck ? "seal-rise" : undefined}
              style={struck ? { animationDelay: `${140 + i * 26}ms` } : undefined}
            />
          ))}

          <path
            d={figure.path}
            fill="none"
            stroke={ink}
            strokeWidth={compact ? 3 : 1.4}
            strokeLinejoin="round"
            pathLength={1}
            className={struck ? "seal-draw" : undefined}
          />

          {!compact &&
            figure.spokes.map((s, i) => (
            <circle
              key={`${s.key}-node`}
              cx={100 + Math.cos(s.a) * s.r}
              cy={100 + Math.sin(s.a) * s.r}
              r={s.node}
              fill={ink}
              opacity="0.85"
              className={struck ? "seal-rise" : undefined}
              style={struck ? { animationDelay: `${420 + i * 26}ms` } : undefined}
            />
          ))}

          <circle cx="100" cy="100" r="4.5" fill="none" stroke={ink} strokeWidth="1.2" opacity="0.7" />
          <circle cx="100" cy="100" r="1.4" fill={ink} />
        </g>
      )}

      {/* Unstruck: an empty field, so the difference between the two states is legible at a glance. */}
      {!verified && (
        <g opacity="0.5">
          <circle cx="100" cy="100" r="4.5" fill="none" stroke="var(--muted-2)" strokeWidth="1" strokeDasharray="2 3" />
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const BEZEL: { a: number; major: boolean }[] = Array.from({ length: 60 }, (_, i) => ({
  a: (i / 60) * Math.PI * 2,
  major: i % 5 === 0,
}));

const SPOKES = 14;

/** Deterministic star figure: spoke lengths and node sizes read straight out of the seed bytes. */
function buildFigure(seed: string) {
  const bytes = seedBytes(seed, SPOKES * 2);
  const spokes = Array.from({ length: SPOKES }, (_, i) => {
    const a = (i / SPOKES) * Math.PI * 2 - Math.PI / 2;
    return {
      key: `s${i}`,
      a,
      r: 26 + (bytes[i] / 255) * 40,
      node: 1 + (bytes[i + SPOKES] / 255) * 1.7,
    };
  });
  const path = `${spokes
    .map((s, i) => `${i === 0 ? "M" : "L"}${(100 + Math.cos(s.a) * s.r).toFixed(2)} ${(100 + Math.sin(s.a) * s.r).toFixed(2)}`)
    .join(" ")} Z`;
  return { spokes, path };
}

/** Bytes from a hex seed; anything else (or anything too short) is stretched with FNV-1a. */
function seedBytes(seed: string, count: number): number[] {
  const hex = seed.startsWith("0x") ? seed.slice(2) : seed;
  const out: number[] = [];
  if (/^[0-9a-fA-F]+$/.test(hex)) {
    for (let i = 0; i + 1 < hex.length && out.length < count; i += 2) {
      out.push(Number.parseInt(hex.slice(i, i + 2), 16));
    }
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  while (out.length < count) {
    h = Math.imul(h ^ out.length, 0x01000193) >>> 0;
    out.push(h & 0xff);
  }
  return out;
}
