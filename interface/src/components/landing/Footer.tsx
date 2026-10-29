import Link from "next/link";

const links = [
  { label: "Transparency", href: "/transparency" },
  { label: "Personhood", href: "/personhood" },
] as const;

export function Footer() {
  return (
    <footer className="border-t hairline bg-paper">
      <div className="mx-auto flex max-w-[1240px] flex-col items-start gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-10">
        <p className="text-[12.5px] text-muted">
          © {new Date().getFullYear()} Novi Corpus Labs, Inc.
        </p>
        <nav aria-label="Footer" className="flex items-center gap-5">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13px] text-ink/80 transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
