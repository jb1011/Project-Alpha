/**
 * The treasury's policy id, computed here and in the backend from the same tuple (design
 * 2026-10-23, section 4.5): the settings screen confirms a scheduled change by the id the backend
 * recorded, so the two must agree. Both packages pin the same vector, computed with `cast`.
 */
import { expect, test } from "vitest";
import { computePolicyId } from "../src/lib/treasury/policyId";

test("matches the vector computed with cast (and the backend's own test)", () => {
  // cast keccak $(cast abi-encode "f(uint256,uint256,bool,address)" 10000000 86400 false \
  //   0x000000000000000000000000000000000000000A), computed 2026-10-28.
  expect(
    computePolicyId({
      newCap: BigInt(10_000_000),
      newPeriod: BigInt(86_400),
      allowlistOn: false,
      newPayout: "0x000000000000000000000000000000000000000A",
    }),
  ).toBe("0x1b2e1ee9216d079fc407ca8232969574549bd0743987ac008f4fc182670c2e62");
});
