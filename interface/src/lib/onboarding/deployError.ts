import type { EntityView } from "@/lib/api/types";

/**
 * What the deploy step says went wrong, from the two things its poll returns.
 *
 * A failed onboarding comes first: the backend's reason, or a plain "Onboarding failed." where it
 * gave none. Then a poll that could not be read at all. Nothing wrong reads as `null`, so the
 * message is derived during render and clears by itself the moment the poll recovers, rather than
 * being copied into state by an effect and kept until something else overwrote it.
 */
export function deployPollError(entity: EntityView | null, pollError: unknown): string | null {
  if (entity?.status === "failed") return entity.error ?? "Onboarding failed.";
  if (pollError) {
    return pollError instanceof Error ? pollError.message : "Failed to poll entity status.";
  }
  return null;
}
