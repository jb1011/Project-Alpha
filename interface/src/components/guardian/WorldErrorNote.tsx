"use client";

import { Callout } from "@/components/onboarding/primitives";

/**
 * Turns World/API failures into something a person can act on.
 *
 * Shared by the guardian record and the onboarding step — it lived in both and drifted, which is
 * how `nullifier_replayed` reached a user as a raw code.
 */
export function WorldErrorNote({ error }: { error: string }) {
  const code = error.startsWith("world:") ? error.slice(6) : "";

  // World refuses a second proof from the same human for the same action. Not a failure — it is
  // the uniqueness rule, seen from the outside.
  if (code === "nullifier_replayed" || code === "max_verifications_reached")
    return (
      <Callout tone="warn" title="This human is already on record">
        World won&apos;t issue a second proof for the same person here, so this account can&apos;t
        be verified by a human who already backs another one. That&apos;s the guarantee working:
        one person, one account.
      </Callout>
    );

  if (code === "user_rejected" || code === "verification_rejected")
    return (
      <Callout tone="warn" title="Verification cancelled">
        You dismissed the request in World App. Nothing was recorded — start again whenever
        you&apos;re ready.
      </Callout>
    );

  if (code === "credential_unavailable")
    return (
      <Callout tone="warn" title="Orb credential required">
        Guardianship needs an Orb or document-grade credential. A device-only World ID isn&apos;t
        enough to be legally accountable for an agent.
      </Callout>
    );

  if (code === "invalid_network" || code === "invalid_merkle_root")
    return (
      <Callout tone="warn" title="World ID couldn&apos;t be checked right now">
        World rejected the proof as out of date. Reopen World App so it can refresh, then try
        again.
      </Callout>
    );

  if (error.toLowerCase().includes("already the guardian"))
    return (
      <Callout tone="warn" title="This human already backs another account">
        The uniqueness rule, working as intended: one person cannot quietly hold two separate
        guardianships.
      </Callout>
    );

  return (
    <Callout tone="warn" title="Not verified">
      {code || error}
    </Callout>
  );
}
