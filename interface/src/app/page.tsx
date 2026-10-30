import type { Metadata } from "next";
import { AgentCTA } from "@/components/landing/AgentCTA";
import { Faq } from "@/components/landing/Faq";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Stats } from "@/components/landing/Stats";
import { Why } from "@/components/landing/Why";
import { SITE_TITLE } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main id="content" className="flex flex-1 flex-col">
        <Hero />
        <Stats />
        <Why />
        <HowItWorks />
        <Faq />
        <AgentCTA />
      </main>
      <Footer />
    </div>
  );
}
