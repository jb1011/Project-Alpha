import { AgentCTA } from "@/components/landing/AgentCTA";
import { CLIShowcase } from "@/components/landing/CLIShowcase";
import { Features } from "@/components/landing/Features";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Stats } from "@/components/landing/Stats";
import { Wyoming } from "@/components/landing/Wyoming";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main className="flex flex-1 flex-col">
        <Hero />
        <Stats />
        <HowItWorks />
        <Features />
        <CLIShowcase />
        <Wyoming />
        <AgentCTA />
      </main>
      <Footer />
    </div>
  );
}
