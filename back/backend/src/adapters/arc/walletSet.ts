import type { Address, TypedDataDefinition } from "viem";

/**
 * The live Arc ERC-8004 registry's verified EIP-712 domain, read from its eip712Domain() (EIP-5267)
 * on 2026-06-15 (registry 0x8004A818BFB912233c491871b3d84c89A494BD9e, chainId 5042002):
 *   name = "ERC8004IdentityRegistry", version = "1".
 * NOTE: this is NOT the ERC-721 token name — name() returns "AgentIdentity". Do not conflate them.
 * These are defaults; production callers should still read eip712Domain() at runtime (see
 * ArcAdapter.eip712Domain) and pass the live values, so a future registry redeploy can't silently
 * desync the signature.
 */
export const LIVE_EIP712_DOMAIN_NAME = "ERC8004IdentityRegistry";
export const LIVE_EIP712_DOMAIN_VERSION = "1";

export interface WalletSetArgs {
  agentId: bigint;
  newWallet: Address; // == agentWallet == operator (the wallet that MUST sign)
  owner: Address; // current NFT owner (== manager after createEntity)
  deadline: bigint;
  chainId: number;
  registry: Address; // EIP-712 verifyingContract
  domainName?: string; // EIP-712 domain name; defaults to the verified live value
  domainVersion?: string; // EIP-712 domain version; defaults to the verified live value
}

/**
 * Build the EIP-712 AgentWalletSet typed data the registry verifies. The field order MUST match the
 * canonical typehash exactly:
 *   AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)
 *
 * The signature must be produced by `newWallet` (the bound wallet); the on-chain caller must be `owner`.
 *
 * Domain name/version default to the VERIFIED live values (see LIVE_EIP712_DOMAIN_NAME), but callers
 * may override them — the production saga reads eip712Domain() from the target registry and passes the
 * live values so the off-chain digest can never silently diverge from on-chain.
 *
 * RESIDUAL CAVEAT: the typehash field list/order is still inferred (the live registry exposes no public
 * typehash getter, and we hold no live agentId to simulate against). The selector
 * setAgentWallet(uint256,address,uint256,bytes) is verified; confirm the full typehash via verified
 * source or a live simulate before mainnet.
 */
export function buildWalletSetTypedData(args: WalletSetArgs): TypedDataDefinition {
  return {
    domain: {
      name: args.domainName ?? LIVE_EIP712_DOMAIN_NAME,
      version: args.domainVersion ?? LIVE_EIP712_DOMAIN_VERSION,
      chainId: args.chainId,
      verifyingContract: args.registry,
    },
    types: {
      // EIP712Domain MUST be declared explicitly. viem's hashTypedData auto-injects it (so local
      // signing + on-chain recovery work without it), but serializeTypedData() drops the domain to
      // {} when it is absent. Enclave/remote signers (e.g. @turnkey/viem) sign the serialized form
      // server-side, so an absent EIP712Domain makes them sign an EMPTY-domain digest and the bind
      // reverts "invalid wallet sig". Declaring it keeps hashTypedData byte-identical and fixes that.
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: {
      agentId: args.agentId,
      newWallet: args.newWallet,
      owner: args.owner,
      deadline: args.deadline,
    },
  };
}
