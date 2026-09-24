import type { Metadata } from "next";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/Nav";
import { SectionLabel } from "@/components/landing/SectionLabel";
import { Mark, Wordmark } from "@/components/landing/Wordmark";

export const metadata: Metadata = {
  title: "Novi Corpus brand kit",
  description: "Marks and color for Novi Corpus. Download the lockup and the N.",
};

const marks: {
  title: string;
  note: string;
  src: string;
  file: string;
  wide?: boolean;
}[] = [
  {
    title: "Full lockup",
    note: "Wordmark with the line Autonomous entities. The file includes a black field. Place it on dark backgrounds.",
    src: "/novi-corpus-logo.jpg",
    file: "novi-corpus-logo.jpg",
    wide: true,
  },
  {
    title: "Mark",
    note: "The N with the blue dot, cropped square. Use this when the full wordmark will not fit.",
    src: "/novi-corpus-icon-n.png",
    file: "novi-corpus-icon-n.png",
  },
  {
    title: "Mark, wide",
    note: "The same N on a wide black field, for covers and slides.",
    src: "/novi-corpus-icon-n-original.jpg",
    file: "novi-corpus-icon-n-original.jpg",
  },
];

const colors: { name: string; hex: string; role: string }[] = [
  { name: "Paper", hex: "#090909", role: "Page background" },
  { name: "Paper 2", hex: "#111111", role: "Raised surface" },
  { name: "Paper 3", hex: "#1A1A1A", role: "Deeper band" },
  { name: "Ink", hex: "#F2F0EA", role: "Primary text" },
  { name: "Muted", hex: "#9C9A92", role: "Secondary text" },
  { name: "Accent", hex: "#4D8EF7", role: "Links and the blue dot" },
  { name: "Accent soft", hex: "#93C5FD", role: "Accent on dark" },
  { name: "Highlight", hex: "#6366F1", role: "Secondary accent" },
  { name: "Mark cream", hex: "#EDE8DE", role: "The N" },
];

export default function BrandPage() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main className="flex flex-1 flex-col">
        <section className="relative bg-paper">
          <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-10 lg:py-20">
            <SectionLabel index="01" label="Marks" />
            <h1 className="mt-4 text-[24px] font-medium tracking-[-0.01em]">
              Logo files
            </h1>
            <div className="mt-8 grid gap-4 lg:grid-cols-2">
              {marks.map((mark) => (
                <figure
                  key={mark.file}
                  className={`overflow-hidden rounded-2xl border hairline bg-black ${
                    mark.wide ? "lg:col-span-2" : ""
                  }`}
                >
                  <div
                    className={`flex items-center justify-center bg-black ${
                      mark.wide ? "h-56 sm:h-72" : "h-64"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mark.src}
                      alt={mark.title}
                      className="h-full w-full object-contain"
                    />
                  </div>
                  <figcaption className="border-t hairline bg-paper px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-[15px] font-medium">{mark.title}</div>
                        <p className="mt-1 max-w-xl text-[13.5px] leading-[1.55] text-muted">
                          {mark.note}
                        </p>
                      </div>
                      <a
                        href={mark.src}
                        download={mark.file}
                        className="inline-flex shrink-0 items-center rounded-full border hairline-strong px-4 py-2 text-[13px] text-ink hover:bg-paper-2"
                      >
                        Download
                      </a>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border hairline bg-paper-2 p-5">
                <div className="text-[11.5px] uppercase tracking-[0.22em] text-muted-2">
                  In the product
                </div>
                <div className="mt-5 flex items-center gap-6">
                  <Wordmark />
                  <Mark />
                </div>
                <p className="mt-4 text-[13.5px] leading-[1.55] text-muted">
                  Navigation and the favicon use this N, set in Georgia, with no blue dot.
                </p>
                <a
                  href="/icon.svg"
                  download="novi-corpus-icon.svg"
                  className="mt-4 inline-flex items-center text-[13px] text-accent-soft hover:text-ink"
                >
                  Download app icon
                </a>
              </div>
              <div className="rounded-2xl border hairline bg-paper-2 p-5">
                <div className="text-[11.5px] uppercase tracking-[0.22em] text-muted-2">
                  Name
                </div>
                <p className="mt-5 text-[28px] font-medium leading-none tracking-[-0.02em]">
                  Novi Corpus
                </p>
                <p className="mt-3 text-[13px] uppercase tracking-[0.22em] text-muted">
                  Autonomous entities
                </p>
                <p className="mt-4 text-[13.5px] leading-[1.55] text-muted">
                  Say the name as two words. The lockup line stays in small capitals.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t hairline bg-paper-2">
          <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-10 lg:py-20">
            <SectionLabel index="02" label="Color" />
            <h2 className="mt-4 text-[24px] font-medium tracking-[-0.01em]">
              Palette
            </h2>
            <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {colors.map((color) => (
                <li
                  key={color.hex}
                  className="flex items-center gap-4 rounded-2xl border hairline bg-paper p-4"
                >
                  <span
                    className="h-12 w-12 shrink-0 rounded-xl border hairline-strong"
                    style={{ background: color.hex }}
                  />
                  <span>
                    <span className="block text-[14px] font-medium">{color.name}</span>
                    <span className="mt-0.5 block font-mono text-[12px] uppercase tracking-[0.08em] text-muted">
                      {color.hex}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-muted-2">
                      {color.role}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
