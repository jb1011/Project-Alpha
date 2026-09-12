import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiDeps } from "../api/app";
import { type FormationFacts, formationOf } from "../api/routes/legalBodies";
import type { LegalBodyLookupDeps } from "../api/routes/legalBodies";
import { readStanding } from "../payments/legalBody";
import type { Address, EntityRecord, Hex } from "../types";

/**
 * The attestation body `GET /verify/:publicId` serves once a payment has settled (design D9).
 *
 * ONE rule about every string in here: the claims ceiling. This document answers "is this a
 * registered legal body in good standing?" and nothing beyond it — never "verified company",
 * never "KYC'd", never "licensed". Which is also why `standing` is the SAME `readStanding` every
 * other surface resolves through (D1): a body suspended on Arc cannot read as active on a
 * document someone paid for.
 *
 * SIGNED ONLY WHERE A KEY IS CONFIGURED (task 13). `attestor` and `signature` appear together or
 * not at all: an empty or placeholder field is one a verifier could read as "checked", which is
 * worse than an absent one. A deployment with no `NOVI_ATTESTATION_KEY` serves the same document
 * without them, and it is still worth what it says — just only as far as the caller trusts the
 * host it came from.
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
  /**
   * The same instant as `issuedAt`, in unix SECONDS, as a decimal string.
   *
   * Why both: the signature is over the unix seconds (EIP-712 has no date type, and `uint256` is
   * the only form a Solidity verifier can compare), while the ISO string is what a human reading
   * the JSON wants. Serving only one of them would make a verifier re-derive the other and hope
   * it re-derives it the way we did — a rounding rule is a bad thing to leave implicit under a
   * signature. A STRING, not a number, for the reason `agentId` is one: JSON numbers are doubles.
   *
   * UNCONDITIONAL, unlike `attestor` and `signature`: an unsigned body and a signed one differ
   * only by the two signature fields, so nothing downstream has to branch on the pair's presence
   * to find a timestamp.
   */
  issuedAtUnix: string;
  expiresAt: string;
  /** `expiresAt` in unix seconds, as a decimal string. See `issuedAtUnix`. */
  expiresAtUnix: string;
  /** The address that signed, present only where this deployment holds an attestation key. It is
   *  in the JSON so a verifier need not be told out of band which key to check against — and it
   *  is then compared against the `attestor` the `/metadata/:publicId` block publishes, which is
   *  the half a forged body cannot restate. */
  attestor?: Address;
  /** The EIP-712 signature over `attestationMessage(this)`, present with `attestor` or not at
   *  all. 65 bytes, r ‖ s ‖ v. */
  signature?: Hex;
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
    issuedAtUnix: unixSeconds(issuedAt),
    expiresAt: new Date(issuedAt + TTL_MS).toISOString(),
    expiresAtUnix: unixSeconds(issuedAt + TTL_MS),
  };
}

/** Milliseconds to a unix-seconds decimal string, FLOORED. One rule, used for both timestamps and
 *  for nothing else, so `issuedAt` and `expiresAt` can never round in different directions. */
function unixSeconds(ms: number): string {
  return String(Math.floor(ms / 1000));
}

// ── EIP-712 (task 13, design Component 3, audit C12) ────────────────────────────────────────────

/**
 * The EIP-712 domain, from the naming table.
 *
 * NO `chainId` and NO `verifyingContract`, deliberately. This statement is not about a chain: it
 * is Novi Corpus saying something about a company, and the same sentence is true whether the
 * reader is on Hedera, on Arc, or holding the JSON in a file. Binding it to one chain id would
 * make a verifier on the other reject a document that is perfectly valid — and there is no
 * contract to replay it against, so the replay protection those two fields normally buy has
 * nothing to protect here. What bounds the statement instead is `expiresAt`, which is signed.
 */
export const ATTESTATION_DOMAIN = { name: "Novi Corpus Attestation", version: "1" } as const;

/**
 * The one primary type: the body flattened to twelve fields.
 *
 * FLAT, not nested, because the audience is a Solidity verifier as much as a TypeScript one, and
 * a nested EIP-712 struct is markedly more code to hash on chain. The price of flattening is that
 * this list and `attestationMessage` below must move together — which is why the test file
 * asserts the twelve names and types in order, and tampers with every one of them.
 *
 * NOT signed, and this is on purpose: `subject.name`, `subject.registry` and
 * `controller.credential`. The name is not an identifier (it is not unique and it can change);
 * the registry is derivable from the deployment's own chain id; and the credential names WHICH
 * proof-of-personhood the guardian holds, where the claim the document actually makes is the
 * boolean beside it. A verifier that wants any of the three reads them from the JSON and treats
 * them as unattested, which they are.
 *
 * COVERED WITHOUT APPEARING: `formation.filed` and `formation.einIssued` are pure functions of
 * `formationStatus` (`formationOf`: filed = `filed | complete`, einIssued = `complete`), so
 * signing the status signs them. And the ISO `issuedAt` / `expiresAt` strings are NOT signed —
 * only their `…Unix` counterparts are, which is what a `uint256` can hold. A verifier therefore
 * reads the window off `issuedAtUnix` / `expiresAtUnix`; the ISO pair is for humans, and a
 * document whose two forms disagree is one where the signed pair is the one that counts.
 */
export const ATTESTATION_TYPES = {
  LegalBodyAttestation: [
    { name: "publicId", type: "string" },
    { name: "agentId", type: "string" },
    { name: "treasury", type: "address" },
    { name: "uaid", type: "string" },
    { name: "standing", type: "string" },
    { name: "formationStatus", type: "string" },
    { name: "formationEnvironment", type: "string" },
    { name: "humanVerified", type: "bool" },
    { name: "oaHash", type: "bytes32" },
    { name: "manifestVersion", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/** `bytes32(0)`: the `oaHash` sentinel. */
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
/** `address(0)`: what an absent treasury flattens to. */
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

/**
 * The ONE place the served body is flattened into the twelve signed fields.
 *
 * Shared by `signAttestation` and `verifyAttestation` on purpose, and it is the most important
 * line in this file: two copies of this mapping that drift by one null produce a signature that
 * verifies nowhere, or — far worse — a verifier that accepts a body the signer never saw.
 *
 * THE NULL MAPPING (design Component 3, audit C12). EIP-712 has no null, so every nullable field
 * needs a sentinel, and each one below is a value the real field can never legitimately take:
 *
 *   - `oaHash` null          → `0x` + 64 zeros   (a real keccak256 is never zero)
 *   - `manifestVersion` null → `0`               (versions start at 1)
 *   - `uaid` null            → `""`              (a real UAID starts `uaid:`)
 *   - `agentId` null         → `""`              (a real agent id is a decimal string)
 *
 * Two more the brief does not name, on the same rule, because the typed data has no room for
 * "absent" either:
 *
 *   - `formation` null       → `formationStatus` and `formationEnvironment` both `""`. Neither
 *     union has an empty member (`status` is `none | in_progress | filed | complete | failed`),
 *     so "we have no formation record" cannot be confused with any state one could be in. Both
 *     halves go empty together: an environment without a status would let a sandbox filing read
 *     as a real one by omission, which is the honesty invariant `formationOf` exists to hold.
 *   - `treasury` empty       → `address(0)`. `buildAttestation` writes `""` for a row with no
 *     treasury, and `""` is not an address viem can encode; the paid route cannot serve such a
 *     row anyway (`isPublicOnChain` gates it), so this is a totality guard, not a live path.
 */
export function attestationMessage(body: AttestationBody) {
  return {
    publicId: body.subject.publicId,
    agentId: body.subject.agentId ?? "",
    treasury: (body.subject.treasury || ZERO_ADDRESS) as Address,
    uaid: body.subject.uaid ?? "",
    standing: body.standing,
    formationStatus: body.formation?.status ?? "",
    formationEnvironment: body.formation?.environment ?? "",
    humanVerified: body.controller.humanVerified,
    oaHash: (body.legalBody.oaHash ?? ZERO_BYTES32) as Hex,
    manifestVersion: BigInt(body.legalBody.manifestVersion ?? 0),
    issuedAt: BigInt(body.issuedAtUnix),
    expiresAt: BigInt(body.expiresAtUnix),
  };
}

/**
 * The attestor address for a key, derived once.
 *
 * `privateKeyToAccount` does a secp256k1 public-key derivation, and `/metadata/:publicId` would
 * otherwise redo it on every public read to print one constant. The memo holds one entry and no
 * more of the secret than `cfg.hedera.attestationKey` already holds for the process's lifetime.
 */
let attestorMemo: { key: Hex; address: Address } | undefined;
export function attestorAddress(key: Hex): Address {
  if (attestorMemo?.key !== key) attestorMemo = { key, address: privateKeyToAccount(key).address };
  return attestorMemo.address;
}

/** Sign a served body. The caller puts both halves on the body it serves, or neither. */
export async function signAttestation(
  body: AttestationBody,
  key: Hex,
): Promise<{ attestor: Address; signature: Hex }> {
  const account = privateKeyToAccount(key);
  const signature = await account.signTypedData({
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "LegalBodyAttestation",
    message: attestationMessage(body),
  });
  return { attestor: account.address, signature };
}

/**
 * Recompute the typed data from a body and check the signature over it.
 *
 * TOTAL: `false`, never a throw, for anything malformed — a signature that is not 65 bytes, an
 * `oaHash` that is not 32, an `attestor` that is not an address. A verifier asks one question
 * ("was this signed by that key?") and every wrong answer to it is the same answer.
 *
 * It does NOT decide whether the attestor is one you should trust, and it does not look at
 * `expiresAt`. Both are the caller's: compare `attestor` against the address
 * `/metadata/:publicId` publishes, and compare `expiresAt` against your own clock.
 */
export async function verifyAttestation(
  body: AttestationBody,
  attestor: Address,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: attestor,
      domain: ATTESTATION_DOMAIN,
      types: ATTESTATION_TYPES,
      primaryType: "LegalBodyAttestation",
      message: attestationMessage(body),
      signature,
    });
  } catch {
    return false;
  }
}
