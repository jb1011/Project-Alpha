const stats = [
  {
    value: "842",
    label: "Agents live",
    sub: "On Arc testnet",
  },
  {
    value: "$18.4M",
    label: "Treasury volume",
    sub: "USDC on Arc",
  },
  {
    value: "12,400+",
    label: "Policy actions",
    sub: "Enforced on-chain",
  },
  {
    value: "~8 min",
    label: "Avg setup",
    sub: "Passkey to funded",
  },
];

export function Stats() {
  return (
    <section className="relative border-y hairline bg-paper-2">
      <div className="mx-auto max-w-[1240px] px-6 lg:px-10">
        <div className="grid grid-cols-2 divide-x divide-y hairline md:grid-cols-4 md:divide-y-0">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className={`group relative px-6 py-8 md:px-8 md:py-10 ${
                i === 0 ? "border-l-0" : ""
              }`}
            >
              <div className="text-[11px] uppercase tracking-[0.2em] text-muted-2">
                {String(i + 1).padStart(2, "0")} · {s.label}
              </div>
              <div className="mt-3 font-medium tabular-nums text-ink text-[36px] leading-none tracking-[-0.02em] sm:text-[44px] lg:text-[52px]">
                {s.value}
              </div>
              <div className="mt-2 text-[12.5px] text-muted">{s.sub}</div>
              <div
                aria-hidden
                className="pointer-events-none absolute right-4 top-4 h-1.5 w-1.5 rounded-full bg-accent/70 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
