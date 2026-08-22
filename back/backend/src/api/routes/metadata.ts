import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { formationSummary } from "../../formation/status";
import { usesManifestScheme } from "../../workflow/onboarding";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public, unauthenticated: resolve publicId -> entity -> served metadata JSON. Uniform 404 for
 *  malformed/unknown/missing-file (no existence oracle). The filename derives from the DB record's
 *  key, never raw URL input — the doc store's own containment guard is the last line of defense. */
export function mountMetadataRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/metadata/:publicId", (c) => {
    const publicId = c.req.param("publicId");
    if (!UUID.test(publicId)) throw new ApiError("not_found", 404, "metadata not found");
    const ent = deps.repo.findByPublicId(publicId);
    if (!ent) throw new ApiError("not_found", 404, "metadata not found");
    let body: string;
    try {
      body = deps.docStore.get(`meta-${ent.idempotencyKey}.json`);
    } catch {
      throw new ApiError("not_found", 404, "metadata not found");
    }
    // Public attestations layered onto the stored JSON: the ENSIP-25 binding (ENS) and the
    // guardian's proof-of-personhood (World). Both are additive and best-effort — a non-JSON
    // stored body is served as-is rather than 500.
    try {
      const meta = JSON.parse(body);
      let touched = false;

      // ENSIP-25 off-chain half: advertise the ENS name + registry binding so a verifier can obtain
      // the claimed name from the registry's metadata (on-chain half is setMetadata(id,"ens",...)).
      if (deps.ens && ent.agentId) {
        meta.ens = `${publicId}.${deps.ens.parentName}`;
        meta.registrations = [
          {
            agentId: ent.agentId,
            agentRegistry: `eip155:${deps.ens.chainId}:${deps.ens.identityRegistry}`,
          },
        ];
        touched = true;
      }

      // World ID: attest that this agent's guardian — the legally required natural person — is a
      // cryptographically verified unique human.
      //
      // PRIVACY: we publish sha256(nullifier), never the nullifier itself. The nullifier is
      // disclosed to us alone (World's model is app-scoped, unlinkable across apps); republishing
      // it would leak that datum to the world. The hash keeps the property that matters publicly —
      // two agents backed by the same human carry the same humanRef — while disclosing nothing
      // reusable elsewhere.
      const gv =
        deps.worldId && ent.ownerTenantId
          ? deps.worldId.store.findByTenant(ent.ownerTenantId, deps.worldId.cfg.action)
          : undefined;
      if (gv) {
        meta.worldId = {
          // A waiver is admin-granted ACCESS, not proof of personhood — claiming otherwise
          // here would be exactly the fabricated-trust problem the frontend audit flagged.
          humanVerified: gv.credential !== "waiver",
          credential: gv.credential,
          humanRef: createHash("sha256").update(gv.nullifier).digest("hex"),
          verifiedAt: gv.verifiedAt,
          environment: gv.environment,
        };
        touched = true;
      }

      // ── Formation + the CURRENT anchor, layered at SERVE time (design §8, audit M10).
      //
      // The stored JSON is written once, during translate. Everything below changes afterwards:
      // a formation completes, an EIN issues, and (from PR 3) a new manifest version is anchored
      // through the timelock. Serving the stored values forever would publish, on a public
      // unauthenticated surface, an anchor that the chain has already moved past and a formation
      // status that stopped being true weeks ago — the fabrication class the frontend audit
      // flagged and this design forbids. So these three read the DB on every request.
      // ONE derivation, shared with `/transparency` and the authenticated view — a public
      // surface and a private one must never disagree about what an entity's formation IS.
      const formation = formationSummary(ent, deps.formationSteps?.(ent.idempotencyKey) ?? []);
      if (formation) {
        // The environment is REQUIRED whenever this block exists: a sandbox filing must never be
        // publishable as a real one by omission (the honesty invariant, §2).
        meta.formation = { environment: formation.environment, status: formation.status };
        // What is NOT here, and must never be: the EIN (a tax identifier, authenticated views
        // only), the filing number, doola's company id, and anything at all from
        // `formation_parties`. This route has no authentication of any kind.
        touched = true;
      }

      if (usesManifestScheme(ent) && meta.legalBody && typeof meta.legalBody === "object") {
        // A verifier holding only the chain compares `legalBody.oaHash` against
        // `LegalManager.meta.operatingAgreementHash`. Those must agree, so the served value has
        // to track the column the anchor sub-saga writes — not the one translate rendered.
        meta.legalBody.oaHash = ent.oaHash;
        meta.legalBody.manifestVersion = ent.oaManifestVersion ?? null;
        touched = true;
      }

      if (touched) body = JSON.stringify(meta);
    } catch {
      // Non-JSON stored body: serve as-is rather than 500.
    }
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(body);
  });
}
