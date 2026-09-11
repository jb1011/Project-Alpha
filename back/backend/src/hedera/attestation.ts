import type { ApiDeps } from "../api/app";
import { type FormationFacts, formationOf } from "../api/routes/legalBodies";
import type { LegalBodyLookupDeps } from "../api/routes/legalBodies";
import { readStanding } from "../payments/legalBody";
import type { Address, EntityRecord } from "../types";

/**
 * The attestation body `GET /verify/:publicId` serves once a payment has settled (design D9).
 *
 * ONE rule about every string in here: the claims ceiling. This document answers "is this a
 * registered legal body in good standing?" and nothing beyond it — never "verified company",
 * never "KYC'd", never "licensed". Which is also why `standing` is the SAME `readStanding` every
 * other surface resolves through (D1): a body suspended on Arc cannot read as active on a
 * document someone paid for.
 *
 * UNSIGNED in this task. The EIP-712 signature arrives in task 13, as a `signature` field this
 * body deliberately does not carry yet: an empty or placeholder field is one a verifier could
 * read as "checked", which is worse than an absent one.
 */
export interface AttestationBody {
  subject: {
    publicId: string;
    name: string;
    agentId: string | null;
    /** CAIP-10 for the ERC-8004 identity registry the agent id lives in. Empty on a deployment
     *  with no registry wired: a chain-less id would be an identifier nothing can resolve. */
    registry: string;
    treasury: string;
    /** The HCS-14 universal agent id (task 9); null until that column is written. */
    uaid: string | null;
  };
  standing: "active" | "inactive" | "unknown";
  formation: FormationFacts | null;
  controller: {
    /** The guardian — the legally required natural person — is a cryptographically verified
     *  unique human. A WAIVER is admin-granted access, never proof of personhood. */
    humanVerified: boolean;
    credential: string | null;
  };
  legalBody: { oaHash: string | null; manifestVersion: number | null };
  issuedAt: string;
  expiresAt: string;
}

/**
 * How long a served attestation claims to be good for.
 *
 * The same 300 s `/transparency` and `/metadata` cache for, and for the same reason: standing is a
 * live on-chain fact, and a guardian suspension has to bite inside minutes rather than hours. The
 * body carries the window explicitly so a verifier holding the JSON alone can tell whether what
 * it is reading has expired, without having to know our cache policy.
 */
const TTL_MS = 300_000;

export async function buildAttestation(
  entity: EntityRecord,
  deps: {
    lookup: LegalBodyLookupDeps;
    worldId?: ApiDeps["worldId"];
    chainId: number;
    identityRegistry: string;
    now: () => number;
  },
): Promise<AttestationBody> {
  // Fail CLOSED, exactly as `check_policy` does (D8): a deployment with no chain reads wired
  // cannot confirm standing, and `unknown` is the honest word for that — never `active`.
  const standing = deps.lookup.chainReads
    ? await readStanding(
        deps.lookup.chainReads,
        entity.proxy as Address,
        entity.treasury as Address,
      )
    : "unknown";

  // The guardian's proof-of-personhood, read exactly as the metadata route reads it — the same
  // store, the same action, the same waiver rule. NOT here, and never: the nullifier (disclosed
  // to us alone), its hash, and the tenant the verification is keyed on.
  const gv =
    deps.worldId && entity.ownerTenantId
      ? deps.worldId.store.findByTenant(entity.ownerTenantId, deps.worldId.cfg.action)
      : undefined;

  const issuedAt = deps.now();
  return {
    subject: {
      publicId: entity.publicId ?? "",
      name: entity.name,
      // A DECIMAL STRING, as every other public surface serves it: an agent id is a uint256 token
      // id, and a JSON number silently loses precision above 2^53.
      agentId: entity.agentId ?? null,
      registry: deps.identityRegistry ? `eip155:${deps.chainId}:${deps.identityRegistry}` : "",
      treasury: entity.treasury ?? "",
      uaid: entity.uaid ?? null,
    },
    standing,
    formation: formationOf(deps.lookup, entity),
    controller: {
      humanVerified: gv ? gv.credential !== "waiver" : false,
      credential: gv?.credential ?? null,
    },
    legalBody: {
      // The values a verifier holding only the chain compares against `LegalManager.meta`, read
      // from the columns the anchor sub-saga writes rather than anything rendered at translate.
      oaHash: entity.oaHash ?? null,
      manifestVersion: entity.oaManifestVersion ?? null,
    },
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + TTL_MS).toISOString(),
  };
}
