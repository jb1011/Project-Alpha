import { type Hex, decodeAbiParameters, stringToHex } from "viem";
import { describe, expect, test } from "vitest";
import { parseLockingWallet } from "../../src/trackRecord/caip10";
import { LOCKING_WALLET, fixtureHex } from "./helpers";

/** `getMetadata` returns ABI-encoded `bytes`; the adapter hands the inner bytes on. */
function innerBytes(encoded: Hex): Hex {
  return decodeAbiParameters([{ type: "bytes" }], encoded)[0];
}

describe("parseLockingWallet", () => {
  test("reads the real metadata of agent 895447 as the checksummed locking wallet", () => {
    const bytes = innerBytes(fixtureHex("getMetadata-895447-lockingWallet.hex"));
    expect(parseLockingWallet(bytes)).toBe(LOCKING_WALLET);
  });

  test("accepts a lowercase address and checksums it", () => {
    expect(parseLockingWallet(stringToHex(`eip155:1:${LOCKING_WALLET.toLowerCase()}`))).toBe(
      LOCKING_WALLET,
    );
  });

  test.each([
    ["another chain", `eip155:5042002:${LOCKING_WALLET}`],
    ["no chain", LOCKING_WALLET],
    ["a trailing space", `eip155:1:${LOCKING_WALLET} `],
    ["a short address", "eip155:1:0x33F283b1d6e9a12b0F79289C75617E6c0f56Aff"],
    ["garbage", "not a wallet"],
  ])("refuses %s", (_label, text) => {
    expect(parseLockingWallet(stringToHex(text))).toBeNull();
  });

  test("refuses empty bytes", () => {
    expect(parseLockingWallet("0x")).toBeNull();
  });

  test("refuses bytes that are not UTF-8 text", () => {
    expect(parseLockingWallet("0xfffefd")).toBeNull();
  });
});
