/**
 * Type-level checks, run by `tsc --noEmit`: what wagmi's `writeContractAsync` and
 * `signTypedDataAsync` accept, with their generics inferred from the argument as a screen would
 * call them. Nothing here runs: `typeLevel` is never called, and the one runtime test below only
 * lets vitest accept the file.
 *
 * Each `@ts-expect-error` is a shape wagmi must refuse. If one of them stops being an error, `tsc`
 * fails on the unused directive, and the shape has to be looked at again.
 */
import { expect, test } from "vitest";
import type { UseSignTypedDataReturnType, UseWriteContractReturnType } from "wagmi";
import {
  encodePointer,
  identityRegistryAbi,
  pointerCall,
  POINTER_KEY,
  registerCall,
  type CallContext,
  type WriteRequest,
} from "@/lib/legalBody/chain";
import {
  LINK_FIELDS,
  type LegalBodyOrderView,
  type LinkTypedDataWire,
  type StatementTypedDataWire,
} from "@/lib/api/types";

declare const sign: UseSignTypedDataReturnType["signTypedDataAsync"];
declare const write: UseWriteContractReturnType["writeContractAsync"];
declare const link: LinkTypedDataWire;
declare const statement: StatementTypedDataWire;
declare const order: LegalBodyOrderView;

/** The public testnet identity registry and factory, and the live test body. */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const CHAIN = 5042002;
const config: CallContext["config"] = { chainId: CHAIN, identityRegistry: REGISTRY, factory: FACTORY };

export async function typeLevel() {
  // The two register overloads and the pointer, their arguments written out as literal tuples.
  await write({ abi: identityRegistryAbi, address: REGISTRY, functionName: "register", args: [] });
  await write({
    abi: identityRegistryAbi,
    address: REGISTRY,
    functionName: "register",
    args: ["https://example.com/agent.json"],
  });
  await write({
    abi: identityRegistryAbi,
    address: REGISTRY,
    functionName: "setMetadata",
    args: [BigInt(1), POINTER_KEY, encodePointer(CHAIN, BODY)],
    chainId: CHAIN,
    gas: BigInt(100_000),
  });

  // The flow's own request, handed over as built: its `args` is wide, so wagmi cannot pick an
  // overload from it. It reaches the wallet through one adapter, never directly.
  const r: WriteRequest = registerCall(config, null);
  // @ts-expect-error the wide `args: readonly unknown[]` satisfies no `register` overload
  await write(r);
  const p = pointerCall(config, order);
  if ("ok" in p) return;
  // @ts-expect-error the wide `args` does not satisfy `setMetadata`'s tuple either
  await write(p);

  // Typed data in viem's own form: every uint256 a bigint, `EIP712Domain` left to viem.
  await sign({
    domain: link.domain,
    types: { LegalBodyLink: LINK_FIELDS },
    primaryType: "LegalBodyLink",
    message: {
      agentId: BigInt(link.message.agentId),
      guardian: link.message.guardian,
      amendmentDelay: BigInt(link.message.amendmentDelay),
      operatingAgreementHash: link.message.operatingAgreementHash,
      deadline: BigInt(link.message.deadline),
    },
  });
  // The served forms, as served.
  // @ts-expect-error the link's pinned field types make each uint256 a bigint; the wire has strings
  await sign(link);
  // @ts-expect-error the statement's declared, wide EIP712Domain types its domain as unknowns
  await sign(statement);
}

test("type-level only: the checks above are run by tsc", () => {
  expect(typeof typeLevel).toBe("function");
});
