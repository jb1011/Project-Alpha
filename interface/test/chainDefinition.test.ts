/**
 * The Arc chain definition's native currency.
 *
 * On Arc, USDC is the gas token, and its native unit has 18 decimals on chain (the ERC-20 USDC
 * contract has 6; the native balance does not). wagmi hands this object to a wallet's
 * `wallet_addEthereumChain` when the wallet does not know the chain yet, and every native amount
 * the interface formats goes through the same `decimals`. A 6 here makes a wallet add the chain
 * with the wrong unit, and turns one cent of gas into ten billion.
 */
import { formatUnits } from "viem";
import { expect, test } from "vitest";
import { arcTestnet } from "@/lib/chain";

test("the native currency is USDC with 18 decimals", () => {
  expect(arcTestnet.nativeCurrency).toEqual({ name: "USDC", symbol: "USDC", decimals: 18 });
});

test("one cent of native gas, in wei, reads as 0.01", () => {
  // 10^16 wei. Under a 6-decimal definition the same amount read as "10000000000".
  expect(formatUnits(BigInt("10000000000000000"), arcTestnet.nativeCurrency.decimals)).toBe(
    "0.01",
  );
});
