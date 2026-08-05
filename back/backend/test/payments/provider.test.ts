import { describe, expect, test } from "vitest";
import { providerOf, requireCircleWallets } from "../../src/payments/provider";
import type { EntityRecord } from "../../src/types";

const base = { idempotencyKey: "e:1" } as EntityRecord;

describe("providerOf", () => {
  test("defaults to turnkey for legacy rows (null/undefined/turnkey)", () => {
    expect(providerOf({ walletProvider: undefined })).toBe("turnkey");
    expect(providerOf({ walletProvider: null })).toBe("turnkey");
    expect(providerOf({ walletProvider: "turnkey" })).toBe("turnkey");
  });
  test("circle only when explicitly chosen", () => {
    expect(providerOf({ walletProvider: "circle" })).toBe("circle");
  });
});

describe("requireCircleWallets", () => {
  test("returns the three wallet fields when present", () => {
    expect(
      requireCircleWallets({
        ...base,
        circleOperatorWalletId: "op",
        circlePocketWalletId: "pk",
        pocketAddress: "0xabc",
      }),
    ).toEqual({ operatorWalletId: "op", pocketWalletId: "pk", pocketAddress: "0xabc" });
  });
  test("names every missing field in the error", () => {
    expect(() => requireCircleWallets({ ...base, circleOperatorWalletId: "op" })).toThrowError(
      /pocketWalletId=∅.*pocketAddress=∅/s,
    );
    expect(() => requireCircleWallets(base)).toThrowError(/operatorWalletId=∅/);
  });
});
