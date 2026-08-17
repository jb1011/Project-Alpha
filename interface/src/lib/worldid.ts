import { CredentialRequest, any as anyOf } from "@worldcoin/idkit";

/**
 * The credential tiers a guardian may verify with, bound to the tenant signal.
 *
 * Mirrors the backend's request (guardianGate.ts) and MUST stay a subset of its
 * ACCEPTED_CREDENTIALS: any tier offered here that the server refuses would let someone
 * scan successfully in World App and then be rejected on /world-id/verify.
 *
 * Orb (proof_of_human) plus the government-document tiers (NFC passport, Japan's My
 * Number Card) — device/selfie stay excluded, they don't prove uniqueness strongly
 * enough for guardianship.
 */
export const guardianConstraints = (signal: string) =>
  anyOf(
    CredentialRequest("proof_of_human", { signal }),
    CredentialRequest("passport", { signal }),
    CredentialRequest("mnc", { signal }),
  );
