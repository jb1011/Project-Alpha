export function Footer() {
  return (
    <footer className="border-t hairline bg-paper">
      <div className="mx-auto max-w-[1240px] px-6 py-5 lg:px-10">
        <p className="text-[12.5px] text-muted">
          © {new Date().getFullYear()} Novi Corpus Labs, Inc.
        </p>
      </div>
    </footer>
  );
}
