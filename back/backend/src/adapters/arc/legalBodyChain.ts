import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { iIdentityRegistryAbi, legalBodyFactoryAbi } from "../../abis/generated";
import type { LegalBodyLink } from "../../legalBody/link";
import type { ArcAdapter } from "./arcAdapter";

/**
 * The part of the ArcAdapter a LegalBodyChain uses: the relay seam a create goes through, the
 * executor that signs it and its mined nonce, and the chain it signs for.
 */
export type RelaySeam = Pick<
  ArcAdapter,
  | "estimateRelayedCall"
  | "prepareRelayedCall"
  | "signRelayedCall"
  | "sendRawRelayedCall"
  | "platformAddress"
  | "platformNonce"
  | "chainId"
>;

export interface LegalBodyChainDeps {
  publicClient: PublicClient;
  arc: RelaySeam;
  /** The chain the factory is on. It must be the chain the relay seam signs for. */
  chainId: number;
  factory: Address;
  identityRegistry: Address;
  /** Wall clock in milliseconds, for the head-age check. Defaults to `Date.now`. */
  now?: () => number;
  /** The oldest head, in seconds against `now()`, that {LegalBodyChain.head} believes. Unset: no
   *  check. */
  maxHeadAgeSeconds?: number;
}

/** `ERC721NonexistentToken(uint256)`: the registry's `ownerOf` revert for an identity that does
 *  not exist. */
const NONEXISTENT_TOKEN_SELECTOR = "0x7e273289";

/**
 * True ONLY when the node answered with a revert whose bytes start with `ERC721NonexistentToken`.
 *
 * The error class is not evidence. viem raises a node's JSON-RPC `-32603` (an internal error, not
 * an answer) as a `ContractFunctionRevertedError` too, and a code-3 revert may carry no bytes at
 * all. So the revert bytes decide: `raw` holds them whether or not the ABI declares the error
 * (`signature` is set only when it does not, so it cannot be relied on).
 */
function isNonexistentToken(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return false;
  return reverted.raw?.toLowerCase().startsWith(NONEXISTENT_TOKEN_SELECTOR) === true;
}

/**
 * The backend's reads of the LegalBodyFactory and of the ERC-8004 identity registry it reads
 * owners from.
 *
 * Every read that takes a `blockNumber` sends it to the node. A caller that checks several facts
 * about one link pins them all to one block, so they describe one state of the chain and cannot
 * disagree with each other. Without a block number, a read is at the latest block.
 *
 * A read that could not be made throws. It is never turned into an answer such as "no owner" or
 * "no body".
 */
export class LegalBodyChain {
  constructor(private readonly d: LegalBodyChainDeps) {
    if (d.chainId !== d.arc.chainId)
      throw new Error(
        `LegalBodyChain: chain id ${d.chainId} differs from the relay seam's ${d.arc.chainId}: refusing to read one chain and sign for another`,
      );
  }

  get chainId(): number {
    return this.d.chainId;
  }
  get factory(): Address {
    return this.d.factory;
  }
  /** The address that signs and pays for a create: the relay seam's platform account. */
  get executor(): Address | undefined {
    return this.d.arc.platformAddress;
  }

  /**
   * The latest block's number and timestamp. With `maxHeadAgeSeconds` set, a head older than that
   * against `now()` throws: a node that has stopped following the chain must not be believed.
   */
  async head(): Promise<{ number: bigint; timestamp: bigint }> {
    const block = await this.d.publicClient.getBlock({ blockTag: "latest" });
    const maxAge = this.d.maxHeadAgeSeconds;
    if (maxAge !== undefined) {
      const ageSeconds = (this.d.now ?? Date.now)() / 1000 - Number(block.timestamp);
      if (ageSeconds > maxAge)
        throw new Error(
          `LegalBodyChain: the node's head (block ${block.number}) is ${ageSeconds} s old, above the ${maxAge} s limit: a stale node is not believed`,
        );
    }
    return { number: block.number, timestamp: block.timestamp };
  }

  async hasCode(address: Address, blockNumber?: bigint): Promise<boolean> {
    const code = await this.d.publicClient.getCode({ address, blockNumber });
    return code !== undefined && code !== "0x";
  }

  /** The identity's owner, or `undefined` when the registry says the identity does not exist.
   *  Every other failure throws (see {isNonexistentToken}). */
  async identityOwner(agentId: bigint, blockNumber?: bigint): Promise<Address | undefined> {
    try {
      return await this.d.publicClient.readContract({
        address: this.d.identityRegistry,
        abi: iIdentityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
        blockNumber,
      });
    } catch (e) {
      if (isNonexistentToken(e)) return undefined;
      throw e;
    }
  }

  /** The digest the identity owner signs for `link`, as the factory computes it. */
  linkDigest(link: LegalBodyLink, blockNumber?: bigint): Promise<Hex> {
    return this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "linkDigest",
      args: [
        link.agentId,
        link.guardian,
        link.amendmentDelay,
        link.operatingAgreementHash,
        link.deadline,
      ],
      blockNumber,
    });
  }

  /** The address the body for this link digest has, or will have. */
  predictLegalBody(linkDigest: Hex, blockNumber?: bigint): Promise<Address> {
    return this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "predictLegalBody",
      args: [linkDigest],
      blockNumber,
    });
  }

  /** The identity owner whose signature created this body, or `undefined` when the factory did not
   *  create it (its `identityOwnerAtCreation` is the zero address). */
  async bodyCreator(legalBody: Address, blockNumber?: bigint): Promise<Address | undefined> {
    const creator = await this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "identityOwnerAtCreation",
      args: [legalBody],
      blockNumber,
    });
    return isAddressEqual(creator, zeroAddress) ? undefined : creator;
  }

  /**
   * What the chain says about a body meant to be created at `bodyAddress` for `identityOwner`,
   * whatever became of the transaction: `absent` when the factory recorded no creator, `created`
   * when the creator is `identityOwner`, `foreign` when it is someone else.
   *
   * One read is the whole fact. Only the factory can put code at a predicted address, and it
   * records the creator in the same transaction.
   */
  async createdState(p: {
    bodyAddress: Address;
    identityOwner: Address;
    blockNumber?: bigint;
  }): Promise<"created" | "absent" | "foreign"> {
    const creator = await this.bodyCreator(p.bodyAddress, p.blockNumber);
    if (creator === undefined) return "absent";
    return isAddressEqual(creator, p.identityOwner) ? "created" : "foreign";
  }

  /** The body this agent is linked to right now, by the factory's own predicate, or `undefined`. */
  async linkedLegalBody(agentId: bigint): Promise<Address | undefined> {
    const body = await this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "linkedLegalBody",
      args: [agentId],
    });
    return isAddressEqual(body, zeroAddress) ? undefined : body;
  }

  /** The exact pointer bytes the identity owner writes to link the agent to `legalBody`. */
  encodePointer(legalBody: Address): Promise<Hex> {
    return this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "encodePointer",
      args: [legalBody],
    });
  }

  /** The executor's MINED transaction count, never the pending one. */
  executorNonce(): Promise<number> {
    return this.d.arc.platformNonce();
  }
}
