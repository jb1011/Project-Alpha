import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { metadataBaseOf, registrationsFor } from "./metadata";

/**
 * GET /metadata/:publicId/profile — the HCS-11 profile document (design 2026-09-10 D11, task 11).
 *
 * Public and unauthenticated, like `/metadata/:publicId` beside it, and cached with the same
 * headers: this is the document a Hedera account's `hcs-11:` memo points at, so it is read by
 * agents that have never heard of us and hold no key of ours.
 *
 * WHAT IT IS NOT: a standing check. The document is STATIC — built from the entity's own row, with
 * no chain read on the path — and a body cached for five minutes cannot honestly carry a fact that
 * changes the moment a guardian suspends the treasury. So there is no `standing` field at any
 * level; `properties.verifyUrl` points at the paid route that reads Arc per request, and
 * `properties.description` says so in the vocabulary the claims ceiling allows (D9): "a registered
 * legal body", never "verified", never "KYC'd".
 *
 * THE 404 RULE: no UAID, no profile. The UAID is what an HCS-11 reader resolves the document BY,
 * and it is written only by the registration script (task 10) — an entity without one has nothing
 * to serve, and serving a document with a null identifier would advertise a resolvable identity
 * that does not exist. Malformed and unknown ids answer the same 404, exactly as the metadata
 * route does, so this surface is not an existence oracle either.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Travels on the wire, so the claims ceiling (D9) binds it. It defers the live question rather
 *  than answering it — which is the honest thing a cached static document can do. */
const DESCRIPTION = "a registered legal body; check standing at verifyUrl";

/** HCS-11 profile type 1 = an AI agent, and `aiAgent.type` 1 = autonomous. The model string names
 *  what this agent IS to a reader of the standard: a Novi Corpus legal body, not an LLM. */
const PROFILE_TYPE = 1;

export function mountProfileRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  app.get("/metadata/:publicId/profile", (c) => {
    const publicId = c.req.param("publicId");
    if (!UUID.test(publicId)) throw new ApiError("not_found", 404, "profile not found");
    const ent = deps.repo.findByPublicId(publicId);
    if (!ent?.uaid) throw new ApiError("not_found", 404, "profile not found");

    // Null rather than a guess wherever this deployment has not told us a public base: a url built
    // from nothing would send a resolver somewhere that is not us.
    const base = metadataBaseOf(deps);
    const body = {
      version: "1.0",
      type: PROFILE_TYPE,
      display_name: ent.name,
      uaid: ent.uaid,
      aiAgent: { type: PROFILE_TYPE, capabilities: [], model: "novi-corpus-legal-body" },
      properties: {
        description: DESCRIPTION,
        // The values a verifier holding only the chain cross-checks against `LegalManager.meta`
        // and the registry — every one of them read off the row, none derived, none invented.
        legalBody: {
          agentId: ent.agentId ?? null,
          treasury: ent.treasury ?? null,
          oaHash: ent.oaHash ?? null,
          manifestVersion: ent.oaManifestVersion ?? null,
        },
        verifyUrl: base ? `${base}/verify/${publicId}` : null,
        metadataUrl: base ? `${base}/metadata/${publicId}` : null,
        // The SAME array `/metadata/:publicId` serves, from the same builder: a profile and the
        // metadata beside it must never disagree about which chains this company is registered on.
        registrations: registrationsFor(deps, ent),
      },
    };

    // Cached exactly as `/metadata/:publicId` is, and for the same reason: nothing here is live.
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(body);
  });
}
