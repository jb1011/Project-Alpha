import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t hairline bg-paper">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-6 py-5 lg:px-10">
        <p className="text-[12.5px] text-muted">
          © {new Date().getFullYear()} Novi Corpus Labs, Inc.
        </p>
        <Link href="/brand" className="text-[12.5px] text-muted hover:text-ink">
          Marketing kit
        </Link>
      </div>
    </footer>
  );
}
