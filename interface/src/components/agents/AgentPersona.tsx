import { agentPortrait } from "@/components/agents/portrait";
import type { AgentMood } from "@/components/agents/persona";

export function AgentPersona({
  seed,
  mood,
  className,
}: {
  seed: string;
  mood: AgentMood;
  className?: string;
}) {
  return <img src={agentPortrait(seed, mood)} alt="" className={className} />;
}
