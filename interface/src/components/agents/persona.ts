import type { EntityStatus } from "@/lib/api/types";

/** How the face feels. The drawing stays put; only the mouth follows this. */
export type AgentMood = "ready" | "setting" | "attention";

/**
 * Bound and funded are finished agents (the list used to mark both with the accent).
 * Failed is the only state that asks for a look. Everything earlier is still in setup.
 */
export function agentMood(status: EntityStatus): AgentMood {
  if (status === "failed") return "attention";
  if (status === "bound" || status === "funded") return "ready";
  return "setting";
}

export function agentMoodLabel(mood: AgentMood): string {
  if (mood === "ready") return "Ready";
  if (mood === "attention") return "Needs attention";
  return "Setting up";
}
