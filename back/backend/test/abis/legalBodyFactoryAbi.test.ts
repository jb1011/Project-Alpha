import { type Abi, getAbiItem, toFunctionSelector } from "viem";
import { expect, test } from "vitest";
import { legalBodyFactoryAbi } from "../../src/abis/generated";

test("the generated LegalBodyFactory ABI carries every function the backend will call", () => {
  const sig = (name: string) => {
    // Widened to Abi so the helper accepts any name; a missing function must fail at run time.
    const item = getAbiItem({ abi: legalBodyFactoryAbi as Abi, name });
    if (!item || item.type !== "function") throw new Error(`missing ${name}`);
    return toFunctionSelector(item);
  };
  expect(sig("createLegalBody")).toBe(
    toFunctionSelector("createLegalBody(uint256,address,uint256,bytes32,uint256,bytes)"),
  );
  expect(sig("scheduleOperatingAgreementUpdate")).toBe(
    toFunctionSelector("scheduleOperatingAgreementUpdate(address,bytes32,uint256,bytes)"),
  );
  for (const name of [
    "linkDigest",
    "amendmentDigest",
    "predictLegalBody",
    "identityOwnerAtCreation",
    "isLegalBody",
    "linkedLegalBody",
    "encodePointer",
    "pendingAmendment",
    "executeOperatingAgreementUpdate",
    "owner",
    "pendingOwner",
    "identityRegistry",
    "implementation",
  ])
    expect(() => sig(name)).not.toThrow();
});
