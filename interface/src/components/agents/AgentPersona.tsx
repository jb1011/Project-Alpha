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
  const svg = agentPortrait(seed, mood).replace(
    'width="128" height="128"',
    'width="100%" height="100%"',
  );
  return (
    <span
      className={`inline-block ${className ?? ""}`}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
