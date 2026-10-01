import { type Address, type Hex, isAddressEqual } from "viem";
import { LegalBodyGasTooHighError } from "../adapters/arc/legalBodyChain";
import { ContractRevertError } from "../adapters/arc/relay";
import {
  type LegalBodyLink,
  canonicalLinkSignature,
  deadlineInWindow,
  isErc6492Wrapped,
  linkShapeProblem,
  offChainLinkDigest,
} from "./link";

/**
 * The chain questions {checkLink} asks. Each read takes the block it is pinned to. The simulation
 * of the create takes none: it is the node's verdict on the exact call that would be relayed.
 */
export interface LinkChainPort {
  readonly chainId: number;
  readonly factory: Address;
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  identityOwner(agentId: bigint, blockNumber?: bigint): Promise<Address | undefined>;
  hasCode(address: Address, blockNumber?: bigint): Promise<boolean>;
  linkDigest(link: LegalBodyLink, blockNumber?: bigint): Promise<Hex>;
  predictLegalBody(linkDigest: Hex, blockNumber?: bigint): Promise<Address>;
  bodyCreator(legalBody: Address, blockNumber?: bigint): Promise<Address | undefined>;
  estimateCreate(link: LegalBodyLink, signature: Hex): Promise<bigint>;
}

/** Why a signed link cannot become a body, as of the block it was checked at. */
export type LinkRefusalCode =
  | "malformed_link"
  | "guardian_mismatch"
  | "agreement_mismatch"
  | "delay_mismatch"
  | "deadline_out_of_window"
  | "identity_not_found"
  | "unsupported_signer"
  | "bad_signature"
  | "already_created"
  | "gas_too_high"
  | "create_would_revert";

/**
 * What {checkLink} decided.
 *
 * Accepted: `signature` is the one to send, `observedAtBlock` the head every read was pinned to,
 * and `gasLimit` the LIMIT {LinkChainPort.estimateCreate} returned.
 *
 * Refused: an answer about the link at that block, with the facts established before the refusal.
 * `createdFor` is the identity owner the factory recorded as the body's creator, `errorName` the
 * contract error behind a `create_would_revert`, and `gasEstimate` the node's raw estimate, on
 * `gas_too_high` only.
 */
export type LinkCheck =
  | {
      ok: true;
      identityOwner: Address;
      linkDigest: Hex;
      bodyAddress: Address;
      signature: Hex;
      observedAtBlock: number;
      gasLimit: bigint;
    }
  | {
      ok: false;
      code: LinkRefusalCode;
      identityOwner?: Address;
      linkDigest?: Hex;
      bodyAddress?: Address;
      createdFor?: Address;
      errorName?: string;
      gasEstimate?: bigint;
    };

/** The byte lengths an ECDSA signature can have: 64 (EIP-2098 compact) and 65 (r, s, v). */
const ECDSA_SIGNATURE_BYTES: ReadonlySet<number> = new Set([64, 65]);

/**
 * Can this signed link become a legal body? Nothing is sent and nothing is written.
 *
 * In this order:
 *  1. the shape of the link and of its signature;
 *  2. the backend's own rules, with no chain call: the guardian is the tenant, and the agreement
 *     hash (whatever its letter case) and the delay are the ones on record;
 *  3. the chain's head: every read below is pinned to it, so the facts describe one state;
 *  4. the deadline, against the head's time;
 *  5. the identity exists;
 *  6. the factory's digest is the one computed here, for the port's chain and factory; a
 *     difference is a deployment or configuration fault, and throws;
 *  7. no body exists at the address the digest predicts;
 *  8. the owner's own ECDSA signature is rewritten into the one form the factory accepts
 *     ({canonicalLinkSignature}); from here on, that is the signature;
 *  9. a simulation of the exact relayed create, the only judge of the signature;
 * 10. after the contract answered `BadSignature`, and only then, local facts choose its name.
 *
 * Nothing local refuses a signature. A read can lag the chain: a node one block behind reports no
 * code for a smart account deployed a moment ago. The factory checks every kind of owner itself,
 * so the simulation is the answer that cannot be wrong about it.
 *
 * A question the chain could not answer is not a refusal, and neither is a fault in the
 * platform's setup (`LegalBodyChainFaultError`): both throw.
 */
export async function checkLink(
  chain: LinkChainPort,
  input: {
    link: LegalBodyLink;
    signature: Hex;
    expected: { tenant: Address; operatingAgreementHash: Hex; amendmentDelay: bigint };
  },
): Promise<LinkCheck> {
  const { link, expected } = input;

  if (linkShapeProblem(link, input.signature) !== undefined)
    return { ok: false, code: "malformed_link" };
  if (!isAddressEqual(link.guardian, expected.tenant))
    return { ok: false, code: "guardian_mismatch" };
  if (link.operatingAgreementHash.toLowerCase() !== expected.operatingAgreementHash.toLowerCase())
    return { ok: false, code: "agreement_mismatch" };
  if (link.amendmentDelay !== expected.amendmentDelay) return { ok: false, code: "delay_mismatch" };

  const head = await chain.head();
  const at = head.number;
  if (!deadlineInWindow(link.deadline, head.timestamp))
    return { ok: false, code: "deadline_out_of_window" };

  const identityOwner = await chain.identityOwner(link.agentId, at);
  if (identityOwner === undefined) return { ok: false, code: "identity_not_found" };

  const linkDigest = await chain.linkDigest(link, at);
  const computed = offChainLinkDigest({ chainId: chain.chainId, factory: chain.factory, link });
  if (linkDigest.toLowerCase() !== computed.toLowerCase())
    throw new Error(
      `checkLink: the factory's link digest ${linkDigest} differs from ${computed}, computed for chain ${chain.chainId} and factory ${chain.factory}: the configuration does not match the deployed factory`,
    );

  const bodyAddress = await chain.predictLegalBody(linkDigest, at);
  const createdFor = await chain.bodyCreator(bodyAddress, at);
  if (createdFor !== undefined)
    return {
      ok: false,
      code: "already_created",
      identityOwner,
      linkDigest,
      bodyAddress,
      createdFor,
    };

  const signature = await canonicalLinkSignature({
    digest: linkDigest,
    owner: identityOwner,
    signature: input.signature,
  });
  const known = { identityOwner, linkDigest, bodyAddress };

  let gasLimit: bigint;
  try {
    gasLimit = await chain.estimateCreate(link, signature);
  } catch (e) {
    if (e instanceof LegalBodyGasTooHighError)
      return { ok: false, code: "gas_too_high", ...known, gasEstimate: e.estimate };
    if (!(e instanceof ContractRevertError)) throw e;
    switch (e.errorName) {
      case "BadSignature":
        return {
          ok: false,
          code: await badSignatureCode(chain, identityOwner, signature, at),
          ...known,
        };
      case "LegalBodyExists":
        return { ok: false, code: "already_created", ...known };
      case "BadDeadline":
        return { ok: false, code: "deadline_out_of_window", ...known };
      default:
        return e.errorName
          ? { ok: false, code: "create_would_revert", ...known, errorName: e.errorName }
          : { ok: false, code: "create_would_revert", ...known };
    }
  }
  return { ok: true, ...known, signature, observedAtBlock: Number(at), gasLimit };
}

/**
 * The name of a `BadSignature` the contract answered. It chooses between two names and never
 * refuses anything:
 *  - an ERC-6492 wrapped signature is `unsupported_signer`: the factory does not unwrap it;
 *  - so is a signature neither 64 nor 65 bytes long from an owner with no code at the pinned
 *    block: an owner without code signs with its key, and a key's signature is ECDSA;
 *  - anything else is `bad_signature`, a compact signature from a wrong key included.
 *
 * The owner's code is read only when the name depends on it.
 */
async function badSignatureCode(
  chain: LinkChainPort,
  owner: Address,
  signature: Hex,
  blockNumber: bigint,
): Promise<"unsupported_signer" | "bad_signature"> {
  if (isErc6492Wrapped(signature)) return "unsupported_signer";
  const bytes = (signature.length - 2) / 2;
  if (!ECDSA_SIGNATURE_BYTES.has(bytes) && !(await chain.hasCode(owner, blockNumber)))
    return "unsupported_signer";
  return "bad_signature";
}
