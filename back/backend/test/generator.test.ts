import { expect, test } from "vitest";
import { computeOaHash, renderMetadata, renderOperatingAgreement } from "../src/oa/generator";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { translate } from "../src/policy/translator";

const USDC = "0x3600000000000000000000000000000000000000";
const spec = parseAgentSpec({
  name: "Acme",
  roles: {
    manager: "0x0000000000000000000000000000000000000001",
    guardian: "0x0000000000000000000000000000000000000002",
  },
  treasury: {
    payoutAddress: "0x0000000000000000000000000000000000000003",
    spendingCapUsdc: "1000.00",
    spendingPeriod: "30d",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
});
const resolved = translate(spec, { usdc: USDC });

const hashOf = (s: typeof spec, r: ReturnType<typeof translate>) =>
  computeOaHash(renderOperatingAgreement(s, r));

test("oaHash is deterministic for identical inputs", () => {
  const doc1 = renderOperatingAgreement(spec, resolved);
  const doc2 = renderOperatingAgreement(spec, resolved);
  expect(computeOaHash(doc1)).toBe(computeOaHash(doc2));
  expect(computeOaHash(doc1)).toMatch(/^0x[0-9a-f]{64}$/);
});

test("oaHash is a stable golden vector (locks the canonical byte form)", () => {
  // Pins the exact UTF-8/NFC/LF bytes so a cross-machine re-verifier agrees, and so an accidental
  // change to the rendered doc is caught loudly rather than silently re-hashing.
  expect(hashOf(spec, resolved)).toBe(
    "0x8285cd43c5e19c16dc3f344f5167e6d58c3a03bfc2753f0ef575b6e5159d0c42",
  );
});

test("oaHash changes when a material term changes (the cap)", () => {
  const other = translate(
    parseAgentSpec({ ...spec, treasury: { ...spec.treasury, spendingCapUsdc: "2000.00" } }),
    { usdc: USDC },
  );
  expect(hashOf(spec, resolved)).not.toBe(hashOf(spec, other));
});

test("oaHash changes when the governance timelock changes", () => {
  const other = translate(parseAgentSpec({ ...spec, governance: { amendmentDelay: "48h" } }), {
    usdc: USDC,
  });
  expect(hashOf(spec, resolved)).not.toBe(hashOf(spec, other));
});

// Sweep every binding treasury/role term so a regression that silently drops a line from the
// rendered doc (making the OA hash blind to a real change) fails loudly.
test.each([
  ["manager", { roles: { ...spec.roles, manager: "0x00000000000000000000000000000000000000a1" } }],
  [
    "guardian",
    { roles: { ...spec.roles, guardian: "0x00000000000000000000000000000000000000a2" } },
  ],
  [
    "payoutAddress",
    { treasury: { ...spec.treasury, payoutAddress: "0x00000000000000000000000000000000000000a3" } },
  ],
  ["spendingPeriod", { treasury: { ...spec.treasury, spendingPeriod: "60d" } }],
  ["allowlistEnabled", { treasury: { ...spec.treasury, allowlistEnabled: true } }],
])("oaHash changes when %s changes", (_label, patch) => {
  const other = translate(parseAgentSpec({ ...spec, ...patch }), { usdc: USDC });
  expect(hashOf(spec, resolved)).not.toBe(hashOf(spec, other));
});

test("oaHash changes when the USDC token address changes", () => {
  const other = translate(spec, { usdc: "0x00000000000000000000000000000000000000dc" });
  expect(hashOf(spec, resolved)).not.toBe(hashOf(spec, other));
});

// The operator (agent spending key) is rotatable on-chain by the guardian (AgentTreasury.setOperator)
// and is NOT an input to the contract's operatingAgreementHash. The OA hash MUST therefore be blind
// to operator identity, so a routine key rotation never invalidates the agreement.
test("oaHash is independent of the operator (rotatable, out of OA scope)", () => {
  const pinned = parseAgentSpec({
    ...spec,
    roles: { ...spec.roles, operator: "0x0000000000000000000000000000000000000004" },
  });
  const resolvedPinned = translate(pinned, { usdc: USDC });
  expect(resolvedPinned.operator).toBe("0x0000000000000000000000000000000000000004");

  const doc = renderOperatingAgreement(pinned, resolvedPinned);
  expect(doc).not.toContain("0x0000000000000000000000000000000000000004");
  expect(doc).toContain("setOperator"); // doc explicitly states the key is bound/rotated on-chain
  expect(hashOf(pinned, resolvedPinned)).toBe(hashOf(spec, resolved));
});

test("document embeds the material terms (no silent omission)", () => {
  const doc = renderOperatingAgreement(spec, resolved);
  expect(doc).toContain("Acme");
  expect(doc).toContain("Wyoming-DAO-LLC");
  expect(doc).toContain(resolved.manager);
  expect(doc).toContain(resolved.guardian);
  expect(doc).toContain(resolved.treasury.payoutAddress);
  expect(doc).toContain("1000 USDC"); // the rendered USDC cap, exact line fragment
});

test("renderMetadata embeds the ERC-8004 fields + oaHash", () => {
  const doc = renderOperatingAgreement(spec, resolved);
  const meta = renderMetadata(spec, resolved, computeOaHash(doc));
  expect(meta.name).toBe("Acme");
  expect(meta.legalBody.oaHash).toBe(computeOaHash(doc));
  expect(meta.legalBody.jurisdiction).toBe("Wyoming-DAO-LLC");
});
