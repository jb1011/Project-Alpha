/**
 * The buyer's own copy of the attestation's EIP-712 shape, so a served `/verify` body can be
 * checked offline.
 *
 * COPIED, NOT IMPORTED, from `back/backend/src/hedera/attestation.ts`: the domain, the twelve
 * signed fields, the flattener with its null mapping, and `verifyAttestation`. Copied because
 * this package is the CUSTOMER's client and must not depend on the server package — a verifier
 * that has to install the thing it is verifying is not verifying much. The consequence is the
 * one every copy has: this file and the server's must move together, and the round-trip test
 * beside it is what catches a drift. The signing half (`signAttestation`, `attestorAddress`) is
 * deliberately absent; a buyer never signs an attestation.
 *
 * Behaviour is verbatim. The only edits are the type imports (viem's `Address` and `Hex` rather
 * than the server's re-exports) and `AttestationBody`, trimmed to the fields a buyer reads off
 * the wire, with `formation` widened because it arrives as parsed JSON rather than as the
 * server's own `FormationFacts`.
 */
import { type Address, type Hex, verifyTypedData } from "viem";

/** The `/verify` document, as much of it as a buyer reads. */
export interface AttestationBody {
  subject: {
    publicId: string;
    name: string;
    agentId: string | null;
    registry: string;
    treasury: string;
    uaid: string | null;
  };
  standing: "active" | "inactive" | "unknown";
  formation: { status?: string; environment?: string } | null;
  controller: { humanVerified: boolean; credential: string | null };
  legalBody: { oaHash: string | null; manifestVersion: number | null };
  issuedAt: string;
  issuedAtUnix: string;
  expiresAt: string;
  expiresAtUnix: string;
  /** Present only where the deployment holds an attestation key, always with `signature`. */
  attestor?: Address;
  /** The EIP-712 signature over `attestationMessage(this)`. 65 bytes, r ‖ s ‖ v. */
  signature?: Hex;
}

/**
 * The EIP-712 domain, from the naming table.
 *
 * NO `chainId` and NO `verifyingContract`, deliberately. This statement is not about a chain: it
 * is Novi Corpus saying something about a company, and the same sentence is true whether the
 * reader is on Hedera, on Arc, or holding the JSON in a file. What bounds it instead is
 * `expiresAt`, which is signed.
 */
export const ATTESTATION_DOMAIN = { name: "Novi Corpus Attestation", version: "1" } as const;

/**
 * The one primary type: the body flattened to twelve fields.
 *
 * FLAT, not nested, because the audience is a Solidity verifier as much as a TypeScript one.
 *
 * NOT signed, and this is on purpose: `subject.name`, `subject.registry` and
 * `controller.credential`. The name is not an identifier, the registry is derivable from the
 * deployment's chain id, and the credential names WHICH proof-of-personhood the guardian holds
 * where the claim is the boolean beside it. Likewise `formation.filed` / `formation.einIssued`
 * and the ISO `issuedAt` / `expiresAt` strings are served but unattested: a verifier derives the
 * first pair from the signed `formationStatus` and reads the window off the `…Unix` pair.
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
 * THE NULL MAPPING (design Component 3, audit C12). EIP-712 has no null, so every nullable field
 * needs a sentinel, and each one below is a value the real field can never legitimately take:
 *
 *   - `oaHash` null          → `0x` + 64 zeros   (a real keccak256 is never zero)
 *   - `manifestVersion` null → `0`               (versions start at 1)
 *   - `uaid` null            → `""`              (a real UAID starts `uaid:`)
 *   - `agentId` null         → `""`              (a real agent id is a decimal string)
 *   - `formation` null       → `formationStatus` and `formationEnvironment` both `""`, together
 *   - `treasury` empty       → `address(0)`, a totality guard rather than a live path
 *
 * @param body - The served attestation document
 * @returns The twelve fields, in the order `ATTESTATION_TYPES` names them
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
 * Recompute the typed data from a body and check the signature over it.
 *
 * TOTAL: `false`, never a throw, for anything malformed — a signature that is not 65 bytes, an
 * `oaHash` that is not 32, an `attestor` that is not an address. A verifier asks one question
 * ("was this signed by that key?") and every wrong answer to it is the same answer.
 *
 * It does NOT decide whether the attestor is one you should trust, and it does not look at
 * `expiresAt`. Both are the caller's: compare `attestor` against the address
 * `/metadata/:publicId` publishes, and compare `expiresAt` against your own clock.
 *
 * @param body - The served attestation document
 * @param attestor - The address the signature is checked against
 * @param signature - The EIP-712 signature the body carries
 * @returns Whether that address signed this body
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
