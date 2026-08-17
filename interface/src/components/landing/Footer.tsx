import { Wordmark } from "./Wordmark";

const columns: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Onboarding", href: "/onboarding" },
      { label: "Spending policy", href: "#features" },
      { label: "Guardian controls", href: "#features" },
      { label: "MCP agent connect", href: "#mcp" },
      { label: "Proof of personhood", href: "/personhood" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Agent connect", href: "/agents/connect" },
      { label: "MCP server", href: "#mcp" },
      { label: "My agents", href: "/agents" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "How it works", href: "#how" },
      { label: "Wyoming jurisdiction", href: "#wyoming" },
      { label: "Transparency", href: "/transparency" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Wyoming DAO LLC act", href: "#wyoming" },
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
              Autonomous agents with enforceable spending rules, Wyoming DAO LLC
              operating agreements, custody choice, and guardian controls.
            </p>
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
              Live on Arc · Mainnet coming soon
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
