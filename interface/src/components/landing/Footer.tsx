import Link from "next/link";

const links = [
  { href: "https://docs.novicorpus.com", label: "Docs", external: true },
  { href: "/privacy", label: "Privacy", external: false },
  { href: "/terms", label: "Terms", external: false },
  { href: "/brand", label: "Marketing kit", external: false },
] as const;

export function Footer() {
  return (
    <footer className="border-t hairline bg-paper">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-5 lg:px-10">
        <p className="text-[14px] text-muted">
          © {new Date().getFullYear()} Novi Corpus Labs, Inc.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {links.map((link) =>
            link.external ? (
              <a
                key={link.href}
                href={link.href}
                className="text-[14px] text-muted hover:text-ink"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                className="text-[14px] text-muted hover:text-ink"
              >
                {link.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}
