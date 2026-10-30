import Link from "next/link";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/Nav";
import { LANDING } from "@/components/landing/copy";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main id="content" className="flex flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-6 py-24">
          <h1 className="text-[40px] font-medium leading-[1.1] tracking-[-0.02em] text-ink sm:text-[52px]">
            {LANDING.notFound.title}
          </h1>
          <p className="mt-4 text-[16px] leading-[1.6] text-muted">
            {LANDING.notFound.body}
          </p>
          <Link
            href="/"
            className="mt-8 inline-flex w-fit items-center rounded-full bg-ink px-5 py-3 text-[14px] font-medium text-paper hover:bg-ink-hover"
          >
            {LANDING.notFound.home}
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
