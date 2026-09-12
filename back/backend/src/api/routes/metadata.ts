import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { formationSummary } from "../../formation/status";
import { HEDERA_IDENTITY_REGISTRY } from "../../hedera/registry";
import type { EntityRecord } from "../../types";
import { usesManifestScheme } from "../../workflow/onboarding";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CAIP-2 for Hedera testnet, where the second ERC-8004 registry lives. A literal, and only
 *  because it is HEDERA's chain id: this deployment's own chain is always `deps.chainId`. */
const HEDERA_CAIP2 = "eip155:296";

/** One ERC-8004 registration: the agent id, and the CAIP-10 registry it lives in. */
export interface AgentRegistration {
  agentId: string;
  agentRegistry: string;
}

/**
 * The ERC-8004 registrations this entity holds — the home chain first, then the Hedera rail.
 *
 * UNGATED from ENS (design 2026-09-10, task 11). This array used to be emitted only where an ENS
 * gateway was configured, because it arrived as ENSIP-25's off-chain half. A Hedera registration
 * is a fact about the entity whether or not we ever run a gateway, and a buyer resolving a company
 * from Hedera reads exactly this array — so it is built from the entity's own ids plus the chain
 * facts that sit on `ApiDeps` (`chainId`, `identityRegistry`), never off the optional `ens` block.
 *
 * The Hedera registry address is the `HEDERA_IDENTITY_REGISTRY` constant: a public, immutable
 * address, never an environment variable (audit C3).
 *
 * Addresses are LOWERCASED. A CAIP-10-shaped id is compared as a string by whoever reads it, so
 * one form has to win, and lowercase is the form CAIP-10 writes eip155 accounts in.
 */
export function registrationsFor(deps: ApiDeps, ent: EntityRecord): AgentRegistration[] {
  const out: AgentRegistration[] = [];
  if (ent.agentId && deps.identityRegistry)
    out.push({
      agentId: ent.agentId,
      agentRegistry: `eip155:${deps.chainId}:${deps.identityRegistry.toLowerCase()}`,
    });
  if (ent.hederaAgentId)
    out.push({
      agentId: ent.hederaAgentId,
      agentRegistry: `${HEDERA_CAIP2}:${HEDERA_IDENTITY_REGISTRY.toLowerCase()}`,
    });
  return out;
}

/**
 * The base every public per-entity url is composed from, trailing slashes trimmed.
 *
 * The SAME base `/legal-bodies/:address` composes its `links.metadata` from, so a buyer that walks
 * lookup -> metadata -> profile -> verify never crosses a host boundary, and on prod every one of
 * those is a prod url (D28). Null where no legal-body lookup is wired: a url is not invented for a
 * deployment that has told us no public base.
 */
export function metadataBaseOf(deps: ApiDeps): string | null {
  const base = deps.legalBody?.links.metadataBase;
  return base ? base.replace(/\/+$/, "") : null;
}

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

      // Every chain this entity is registered on, ENS or no ENS (see `registrationsFor`).
      const registrations = registrationsFor(deps, ent);
      if (registrations.length) {
        meta.registrations = registrations;
        touched = true;
      }

      // ENSIP-25 off-chain half: advertise the ENS NAME so a verifier can obtain the claimed name
      // from the registry's metadata (on-chain half is setMetadata(id,"ens",...)). Still gated on
      // the gateway, because a name we do not serve is a name nothing resolves; the registry
      // binding above is not, because it is true of the entity either way.
      if (deps.ens && ent.agentId) {
        meta.ens = `${publicId}.${deps.ens.parentName}`;
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
      const formation = ent.companyId
        ? formationSummary(
            deps.company?.(ent.companyId),
            deps.formationSteps?.(ent.companyId) ?? [],
          )
        : null;
      if (formation) {
        // The environment is REQUIRED whenever this block exists: a sandbox filing must never be
        // publishable as a real one by omission (the honesty invariant, §2).
        meta.formation = { environment: formation.environment, status: formation.status };
        // What is NOT here, and must never be: the EIN (a tax identifier, authenticated views
        // only), the filing number, doola's company id, and anything at all from
        // `formation_parties`. This route has no authentication of any kind.
        touched = true;
      }

      // ── The Hedera rail's cross-links (task 11) ──────────────────────────────────────────────
      //
      // Both are written ONLY once the thing they name exists. An empty `uaid`, or a profile url
      // for an entity that was never registered, is a link a resolver follows to nothing — and on
      // a public surface that reads as a capability this entity does not have.

      // The HCS-14 universal agent id (task 9): the one identifier that names this company across
      // both chains, and the string a demo buyer starts from.
      if (ent.uaid) {
        meta.uaid = ent.uaid;
        touched = true;
      }

      // The two entry points a buyer that found us on Hedera needs next: the free profile document
      // and the paid standing check. Composed from the SAME base as `/legal-bodies`' metadata link.
      const base = metadataBaseOf(deps);
      if (ent.hederaAccountId && base) {
        meta.hedera = {
          accountId: ent.hederaAccountId,
          verifyUrl: `${base}/verify/${publicId}`,
          profileUrl: `${base}/metadata/${publicId}/profile`,
        };
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
