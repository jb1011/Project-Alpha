import { Wordmark } from "./Wordmark";

const columns: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Onboarding", href: "/onboarding" },
      { label: "Spending policy", href: "#features" },
      { label: "Guardian controls", href: "#features" },
      { label: "MCP self-config", href: "#mcp" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: "#docs" },
      { label: "MCP server", href: "#mcp" },
      { label: "Policy schema", href: "#docs" },
      { label: "Arc contracts", href: "#docs" },
      { label: "Status", href: "#status" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#about" },
      { label: "Manifesto", href: "#manifesto" },
      { label: "Customers", href: "#customers" },
      { label: "Careers", href: "#careers" },
      { label: "Press", href: "#press" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Disclosures", href: "#legal" },
      { label: "Privacy", href: "#privacy" },
      { label: "Terms", href: "#terms" },
      { label: "Wyoming DAO LLC act", href: "#wyoming" },
      { label: "Compliance", href: "#compliance" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t hairline bg-paper-2">
      <div className="mx-auto max-w-[1240px] px-6 py-16 lg:px-10 lg:py-20">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-6">
          <div className="col-span-2">
            <Wordmark />
            <p className="mt-5 max-w-xs text-[13.5px] leading-[1.55] text-muted">
              Non-custodial autonomous agents with on-chain spending rules,
              Wyoming DAO LLC operating agreements, and guardian controls.
            </p>
            <div className="mt-6 flex items-center gap-2">
              {socials.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  aria-label={s.label}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border hairline-strong bg-paper text-muted hover:text-ink hover:bg-paper-3 transition-colors"
                >
                  {s.icon}
                </a>
              ))}
            </div>
          </div>

          {columns.map((c) => (
            <div key={c.title}>
              <div className="text-[11px] uppercase tracking-[0.2em] text-muted-2">
                {c.title}
              </div>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      className="text-[13.5px] text-ink/80 hover:text-ink"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-4 border-t hairline pt-6 sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted">
            <span>© {new Date().getFullYear()} Novi Corpus Labs, Inc.</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Arc testnet · Simulation
            </span>
          </div>
          <div className="text-[11.5px] uppercase tracking-[0.2em] text-muted-2">
            Cheyenne · Wyoming · USA
          </div>
        </div>
      </div>
    </footer>
  );
}

const socials = [
  {
    label: "GitHub",
    href: "#",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 .5a11.5 11.5 0 00-3.63 22.4c.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.5-3.87-1.5-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.3-5.24-1.28-5.24-5.7 0-1.26.46-2.3 1.2-3.1-.12-.3-.52-1.48.1-3.08 0 0 .98-.31 3.2 1.18a11 11 0 015.83 0c2.22-1.5 3.2-1.18 3.2-1.18.62 1.6.23 2.78.11 3.08.74.8 1.2 1.84 1.2 3.1 0 4.42-2.7 5.4-5.27 5.69.42.36.78 1.06.78 2.14v3.18c0 .3.2.66.79.55A11.5 11.5 0 0012 .5z" />
      </svg>
    ),
  },
  {
    label: "X",
    href: "#",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.244 2H21l-6.52 7.45L22 22h-6.78l-4.78-6.27L4.8 22H2l7-7.99L1.5 2h6.93l4.32 5.71L18.244 2zm-2.38 18.4h1.83L7.23 3.5H5.3l10.56 16.9z" />
      </svg>
    ),
  },
  {
    label: "Discord",
    href: "#",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.317 4.37A19.9 19.9 0 0016.558 3a14.6 14.6 0 00-.687 1.41 18.5 18.5 0 00-5.74 0A14.4 14.4 0 009.443 3a19.7 19.7 0 00-3.762 1.37C2.114 9.84 1.42 15.16 1.764 20.4a19.9 19.9 0 005.99 3.03c.484-.66.91-1.36 1.28-2.09a13 13 0 01-2.02-.97c.17-.13.34-.27.5-.4a14.27 14.27 0 0012.97 0c.16.14.33.28.5.4-.65.39-1.33.71-2.03.97.37.74.8 1.44 1.28 2.1a19.9 19.9 0 005.99-3.03c.42-6.04-.7-11.32-3.91-16.03zM8.02 17.07c-1.18 0-2.16-1.08-2.16-2.41 0-1.33.96-2.41 2.16-2.41 1.19 0 2.17 1.09 2.16 2.41 0 1.33-.96 2.41-2.16 2.41zm7.96 0c-1.18 0-2.16-1.08-2.16-2.41 0-1.33.96-2.41 2.16-2.41 1.19 0 2.17 1.09 2.16 2.41 0 1.33-.95 2.41-2.16 2.41z" />
      </svg>
    ),
  },
];
