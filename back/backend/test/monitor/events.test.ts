import { keccak256, toHex } from "viem";
import { describe, expect, test } from "vitest";
import { CONTROLLER_GRANTED_SELECTORS } from "../../src/adapters/arc/bootVerify";
import {
  AGENT_WALLET_KEY,
  AGENT_WALLET_KEY_TOPIC,
  DEFAULT_ADMIN_ROLE,
  TOPIC,
  WILDCARD_ROLE,
  standingRoles,
} from "../../src/monitor/events";

/**
 * Topic pins.
 *
 * Every rule in this monitor is a topic match, so a wrong signature does not fail loudly — it
 * produces a rule that never fires, which is indistinguishable from "nothing happened". These are
 * the topic0 values OBSERVED ON ARC TESTNET on 2026-08-18 (explorer logs for controller
 * 0x9526E228…Fb5c, factory 0x83D529E8…CA77, beacon 0x432ed081…2CfD and the ERC-8004 registry
 * 0x8004A818…BD9e). If one of these ever fails, the ABI moved and the corresponding rule is blind.
 */
const LIVE = {
  roleGranted: "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d",
  roleRevoked: "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b",
  ownershipTransferStarted: "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700",
  ownershipTransferred: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  upgraded: "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
  metadataSet: "0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b",
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
} as const;

describe("topic pins against live Arc-testnet logs", () => {
  for (const [name, expected] of Object.entries(LIVE))
    test(`${name}`, () => {
      expect(TOPIC[name as keyof typeof TOPIC]).toBe(expected);
    });

  test("the wallet-bind key hash matches the live indexed topic", () => {
    // The live registry has NO AgentWalletSet event: binds arrive as
    // MetadataSet(agentId, "agentWallet", …) with this keccak in topic[2].
    expect(AGENT_WALLET_KEY_TOPIC).toBe(
      "0x2ac6109326e720d1435c0db66f7e35eda7839f52b6f1f5520a60788e132b4e39",
    );
    expect(AGENT_WALLET_KEY_TOPIC).toBe(keccak256(toHex(AGENT_WALLET_KEY)));
  });

  test("every watched topic is distinct (a collision would silently merge two rules)", () => {
    const values = Object.values(TOPIC);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("role constants", () => {
  test("DEFAULT_ADMIN_ROLE is bytes32(0)", () => {
    expect(DEFAULT_ADMIN_ROLE).toBe(`0x${"00".repeat(32)}`);
  });

  test("WILDCARD_ROLE is bytes32(uint256(1)) — RIGHT-aligned, outside the selector namespace", () => {
    expect(WILDCARD_ROLE).toBe(`0x${"00".repeat(31)}01`);
  });

  test("the standing set is exactly the seven selectors bootVerify checks on-chain", () => {
    const roles = standingRoles();
    expect(roles.size).toBe(7);
    expect(roles.size).toBe(CONTROLLER_GRANTED_SELECTORS.length);
    // Selector roles are LEFT-aligned, so they can never collide with the two specials above.
    for (const r of roles) {
      expect(r).not.toBe(DEFAULT_ADMIN_ROLE);
      expect(r).not.toBe(WILDCARD_ROLE);
      expect(r.endsWith("0".repeat(56))).toBe(true);
    }
  });
});
