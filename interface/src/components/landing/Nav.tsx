import { Wordmark } from "./Wordmark";

const links = [
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#mcp", label: "MCP" },
  { href: "/agents", label: "My agents" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-50">
      <div className="absolute inset-0 -z-10 backdrop-blur-md bg-paper/75 border-b hairline" />
      <nav className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-6 lg:px-10">
        <Wordmark />

        <div className="hidden md:flex items-center gap-1">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3.5 py-2 text-[13.5px] text-muted hover:text-ink hover:bg-paper-2 transition-colors"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href="#docs"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border hairline-strong px-3.5 py-2 text-[13px] text-ink hover:bg-paper-2 transition-colors"
          >
            <span>Docs</span>
          </a>
          <a
            href="/onboarding"
            className="group inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink-hover transition-colors"
          >
            <span>Create agent</span>
            <span
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </a>
        </div>
      </nav>
    </header>
  );
}
