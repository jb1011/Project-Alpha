/**
 * HCS-14 UAID derivation (design D10), pinned to a golden vector generated with
 * `@hashgraphonline/standards-sdk@0.1.186` (task 9 brief, 2026-09-10): canonicalization must match
 * that SDK's `canonical.ts` byte for byte, and `deriveUaid` must reproduce its `createUaid` output.
 */
import { expect, test } from "vitest";
import {
  type CanonicalAgentData,
  canonicalizeAgentData,
  deriveUaid,
  parseUaidNativeId,
  uaidInputsFor,
} from "../../src/hedera/uaid";
import { entity } from "../helpers/hederaApp";

const CHAIN_ID = 5042002;

// The golden vector, verbatim from the task 9 brief.
const GOLDEN_INPUT: CanonicalAgentData = {
  registry: "novicorpus",
  name: "FormationE2E_1",
  version: "1",
  protocol: "mcp",
  nativeId: "eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf",
  skills: [],
};
const GOLDEN_CANONICAL_JSON =
  '{"skills":[],"name":"FormationE2E_1","nativeId":"eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf","protocol":"mcp","registry":"novicorpus","version":"1"}';
const GOLDEN_UAID =
  "uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk;uid=886257;registry=novicorpus;proto=mcp;nativeId=eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf";

test("canonicalizeAgentData matches the golden canonical JSON, key order and all", () => {
  const { canonicalJson, normalized } = canonicalizeAgentData(GOLDEN_INPUT);
  expect(canonicalJson).toBe(GOLDEN_CANONICAL_JSON);
  expect(normalized).toEqual(GOLDEN_INPUT);
});

test("canonicalizeAgentData lowercases registry and protocol but not name, version, or nativeId", () => {
  const { normalized } = canonicalizeAgentData({
    registry: "  NoviCorpus  ",
    name: "  Keep Case  ",
    version: " 1 ",
    protocol: "  MCP  ",
    nativeId: "  eip155:5042002:0xABC  ",
    skills: [3, 1, 2],
  });
  expect(normalized).toEqual({
    registry: "novicorpus",
    name: "Keep Case",
    version: "1",
    protocol: "mcp",
    nativeId: "eip155:5042002:0xABC",
    skills: [1, 2, 3],
  });
});

test("deriveUaid reproduces the pinned golden UAID exactly", () => {
  expect(deriveUaid(GOLDEN_INPUT, { uid: "886257" })).toBe(GOLDEN_UAID);
});

test("a renamed entity yields a different UAID", () => {
  const renamed: CanonicalAgentData = { ...GOLDEN_INPUT, name: "SomethingElse" };
  expect(deriveUaid(renamed, { uid: "886257" })).not.toBe(GOLDEN_UAID);
});

test("parseUaidNativeId extracts the CAIP-10 nativeId from a derived UAID", () => {
  expect(parseUaidNativeId(GOLDEN_UAID)).toBe(
    "eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf",
  );
});

test("parseUaidNativeId returns null for a UAID with no nativeId param", () => {
  expect(parseUaidNativeId("uaid:aid:abc;uid=1;registry=novicorpus")).toBeNull();
});

test("parseUaidNativeId returns null for a string that is not a uaid:aid: UAID", () => {
  expect(parseUaidNativeId("did:hedera:testnet:0.0.1234")).toBeNull();
});

test("uaidInputsFor builds D10's fixed shape from the scaffold entity, lowercasing the treasury", () => {
  const rec = entity();
  const input = uaidInputsFor(rec, CHAIN_ID);
  expect(input).toEqual(GOLDEN_INPUT);
  // End to end: the scaffold's demo entity reproduces the golden vector exactly (by design, per
  // test/helpers/hederaApp.ts's comment on TREASURY).
  expect(deriveUaid(input, { uid: rec.agentId as string })).toBe(GOLDEN_UAID);
});

test("uaidInputsFor throws when the entity has no treasury yet", () => {
  const rec = entity({ treasury: null });
  expect(() => uaidInputsFor(rec, CHAIN_ID)).toThrow();
});
