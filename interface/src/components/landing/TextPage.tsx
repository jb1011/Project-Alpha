import type { ReactNode } from "react";
import { Footer } from "./Footer";
import { Nav } from "./Nav";
import { SectionLabel } from "./SectionLabel";

export function TextPage({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main id="content" className="flex flex-1 flex-col">
        <article className="mx-auto w-full max-w-[720px] px-6 py-16 lg:px-10 lg:py-24">
          <SectionLabel label={label} />
          <h1 className="mt-4 text-[36px] font-medium leading-[1.1] tracking-[-0.02em] text-ink sm:text-[48px]">
            {title}
          </h1>
          <div className="mt-8 space-y-5 text-[16px] leading-[1.65] text-muted">
            {children}
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}
