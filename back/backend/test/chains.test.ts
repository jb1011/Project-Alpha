import { expect, test } from "vitest";
import { anvilChain, arcTestnet } from "../src/chains";

test("arcTestnet has the verified id and USDC-as-native-gas (18 dec native)", () => {
  expect(arcTestnet.id).toBe(5042002);
  expect(arcTestnet.nativeCurrency.symbol).toBe("USDC");
  expect(arcTestnet.nativeCurrency.decimals).toBe(18); // native gas units; ERC-20 USDC is 6
});

test("anvilChain is 31337", () => {
  expect(anvilChain.id).toBe(31337);
});
