/**
 * The USDC domain PIN (design 2026-08-26 §6.1).
 *
 * `name` and `version` are two strings on somebody else's predeploy, and they are the difference
 * between a signature that settles and one that reverts. Getting them wrong is invisible until a
 * guardian has signed — our own verification would pass, because it would be checking against the
 * same wrong domain we asked them to sign — so they are READ and then CHECKED against the token's
 * own DOMAIN_SEPARATOR.
 */
import { type Hex as ViemHex, hashDomain } from "viem";
import { expect, test } from "vitest";
import {
  CANCEL_AUTHORIZATION_TYPES,
  FIAT_TOKEN_ABI,
  readAuthorizationState,
  readUsdcDomain,
} from "../../../src/adapters/arc/usdcToken";
import type { Address, Hex } from "../../../src/types";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const CHAIN = 5042002;

const EIP712_DOMAIN_TYPE = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

function separatorFor(name: string, version: string): ViemHex {
  return hashDomain({
    domain: { name, version, chainId: BigInt(CHAIN), verifyingContract: USDC },
    types: EIP712_DOMAIN_TYPE,
  });
}

/** A public client stub that answers exactly the three reads `readUsdcDomain` makes. */
function tokenAt(answers: { name: string; version: string; separator: ViemHex }) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "name") return answers.name;
      if (functionName === "version") return answers.version;
      if (functionName === "DOMAIN_SEPARATOR") return answers.separator;
      throw new Error(`unexpected read: ${functionName}`);
    },
    // biome-ignore lint/suspicious/noExplicitAny: a three-method stub of viem's PublicClient
  } as any;
}

test("reads name/version off the token and returns them as the domain", async () => {
  const domain = await readUsdcDomain(
    tokenAt({ name: "USD Coin", version: "2", separator: separatorFor("USD Coin", "2") }),
    USDC,
    CHAIN,
  );
  expect(domain).toEqual({
    name: "USD Coin",
    version: "2",
    chainId: CHAIN,
    verifyingContract: USDC,
  });
});

test("nothing is hardcoded: a token calling itself something else is honoured, not corrected", async () => {
  // The point of reading rather than assuming. Arc's predeploy is Circle's FiatTokenV2_2, but the
  // strings are that deployment's business, and a guardian signs whatever the token says it is.
  const domain = await readUsdcDomain(
    tokenAt({ name: "Bridged USDC", version: "1", separator: separatorFor("Bridged USDC", "1") }),
    USDC,
    CHAIN,
  );
  expect(domain).toMatchObject({ name: "Bridged USDC", version: "1" });
});

test("REFUSES when the computed separator does not match the token's own", async () => {
  // Every way this can happen is a way a signature would revert on-chain AFTER the guardian
  // approved it: a different EIP-712 layout, a salt, a proxy pointing elsewhere. Refusing to
  // quote is the honest answer.
  await expect(
    readUsdcDomain(
      tokenAt({ name: "USD Coin", version: "2", separator: separatorFor("USD Coin", "1") }),
      USDC,
      CHAIN,
    ),
  ).rejects.toThrow(/USDC domain pin failed/);
});

test("the pin is chain-bound: the right strings on the wrong chain still refuse", async () => {
  await expect(
    readUsdcDomain(
      tokenAt({ name: "USD Coin", version: "2", separator: separatorFor("USD Coin", "2") }),
      USDC,
      // A domain separator commits to the chain id, so a box pointed at a different chain than
      // the token it is reading cannot silently produce signatures for the wrong network.
      1,
    ),
  ).rejects.toThrow(/USDC domain pin failed/);
});

test("authorizationState is read with the authorizer and the nonce, and returns the raw bool", async () => {
  const seen: unknown[] = [];
  const client = {
    readContract: async (args: { functionName: string; args: unknown[] }) => {
      seen.push(args);
      return true;
    },
    // biome-ignore lint/suspicious/noExplicitAny: one-method stub
  } as any;
  const used = await readAuthorizationState(
    client,
    USDC,
    "0x00000000000000000000000000000000000000Ab" as Address,
    `0x${"a1".repeat(32)}` as Hex,
  );
  expect(used).toBe(true);
  expect(seen[0]).toMatchObject({
    functionName: "authorizationState",
    args: ["0x00000000000000000000000000000000000000Ab", `0x${"a1".repeat(32)}`],
  });
});

test("the ABI declares only the `bytes signature` overloads, and both cancel + state", () => {
  // FiatTokenV2_2 overloads transferWithAuthorization and cancelAuthorization on (v,r,s). With
  // both declared, viem needs an explicit overload selection at every call site; the `bytes` form
  // is the one a browser wallet's signature drops straight into.
  const byName = (n: string) => FIAT_TOKEN_ABI.filter((f) => f.name === n);
  expect(byName("transferWithAuthorization")).toHaveLength(1);
  expect(byName("cancelAuthorization")).toHaveLength(1);
  expect(byName("transferWithAuthorization")[0]?.inputs.at(-1)).toMatchObject({ type: "bytes" });
  expect(byName("authorizationState")).toHaveLength(1);
});

test("CancelAuthorization is (authorizer, nonce) — what FiatTokenV2_2 hashes", () => {
  expect(CANCEL_AUTHORIZATION_TYPES.CancelAuthorization).toEqual([
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ]);
});
