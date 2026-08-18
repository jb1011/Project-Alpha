import { pad, toFunctionSelector, zeroAddress } from "viem";
import { describe, expect, test } from "vitest";
import {
  agentTreasuryAbi,
  legalManagerFactoryAbi,
  noviControllerAbi,
} from "../../src/abis/generated";
import { CONTROLLER_GRANTED_SELECTORS, selectorRole } from "../../src/adapters/arc/bootVerify";
import { indexEntities } from "../../src/monitor/entityLookup";
import {
  DEFAULT_ADMIN_ROLE,
  WILDCARD_ROLE,
  beaconUpgradedEvent,
  registryMetadataSetEvent,
  registryTransferEvent,
} from "../../src/monitor/events";
import { evaluateLog, roleLabel, ttlEscalations } from "../../src/monitor/rules";
import type { OpenGrant } from "../../src/monitor/store";
import { ADDR, entity, makeLog, ruleContext, ruleDeps } from "./helpers";

const STANDING_ROLE = selectorRole(CONTROLLER_GRANTED_SELECTORS[0]!.selector);
const UNKNOWN_ROLE = pad(toFunctionSelector("function upgradeTo(address)"), {
  dir: "right",
  size: 32,
});

function roleGrantedLog(args: { role: string; account: string; sender?: string }, over = {}) {
  return makeLog({
    abi: noviControllerAbi,
    eventName: "RoleGranted",
    args: { sender: ADDR.admin, ...args },
    address: ADDR.controller,
    ...over,
  });
}

describe("rule 1 — controller RoleGranted", () => {
  test("a standing selector role granted to the executor is WARN and is NOT TTL-tracked", async () => {
    const out = await evaluateLog(
      roleGrantedLog({ role: STANDING_ROLE, account: ADDR.executor }),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0]?.severity).toBe("WARN");
    expect(out.alerts[0]?.rule).toBe("controller_role_granted");
    expect(out.alerts[0]?.detail.roleLabel).toBe(CONTROLLER_GRANTED_SELECTORS[0]?.name);
    // The permanent, boot-verified pairing: paging on it every TTL would train the on-call to
    // ignore this rule.
    expect(out.grants).toHaveLength(0);
  });

  test("a standing selector role granted to a DIFFERENT account is TTL-tracked", async () => {
    const out = await evaluateLog(
      roleGrantedLog({ role: STANDING_ROLE, account: ADDR.attacker }),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.grants).toEqual([
      {
        kind: "open",
        role: STANDING_ROLE.toLowerCase(),
        account: ADDR.attacker.toLowerCase(),
        block: 100n,
        ts: 1_700_000_000_000,
      },
    ]);
  });

  test("WILDCARD is CRITICAL immediately", async () => {
    const out = await evaluateLog(
      roleGrantedLog({ role: WILDCARD_ROLE, account: ADDR.helper }),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.detail.wildcard).toBe(true);
    expect(out.alerts[0]?.detail.roleLabel).toBe("WILDCARD_ROLE");
    expect(out.grants).toHaveLength(1);
  });

  test("a role outside the standing set is CRITICAL immediately", async () => {
    const out = await evaluateLog(
      roleGrantedLog({ role: UNKNOWN_ROLE, account: ADDR.helper }),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.detail.standingExecutorRole).toBe(false);
  });

  test("rule 5 — DEFAULT_ADMIN_ROLE granted raises a second, distinct CRITICAL", async () => {
    const out = await evaluateLog(
      roleGrantedLog({ role: DEFAULT_ADMIN_ROLE, account: ADDR.attacker }),
      ruleContext(),
      ruleDeps(),
    );
    const rules = out.alerts.map((a) => a.rule);
    expect(rules).toContain("controller_role_granted");
    expect(rules).toContain("controller_default_admin_granted");
    expect(out.alerts.every((a) => a.severity === "CRITICAL")).toBe(true);
    // Distinct dedup keys, or the second alert would be swallowed by the first.
    expect(new Set(out.alerts.map((a) => a.dedupKey)).size).toBe(2);
    // The admin role is permanent by design — never a TTL row.
    expect(out.grants).toHaveLength(0);
  });

  test("dedup key is derived from the log, so a re-scan produces the same key", async () => {
    const log = roleGrantedLog({ role: WILDCARD_ROLE, account: ADDR.helper });
    const a = await evaluateLog(log, ruleContext(), ruleDeps({ now: 1 }));
    const b = await evaluateLog(log, ruleContext(), ruleDeps({ now: 999_999 }));
    expect(a.alerts[0]?.dedupKey).toBe(b.alerts[0]?.dedupKey);
  });
});

describe("rule 3 — controller RoleRevoked", () => {
  test("INFO, and closes the open grant", async () => {
    const log = makeLog({
      abi: noviControllerAbi,
      eventName: "RoleRevoked",
      args: { role: WILDCARD_ROLE, account: ADDR.helper, sender: ADDR.admin },
      address: ADDR.controller,
    });
    const out = await evaluateLog(log, ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("INFO");
    expect(out.grants).toEqual([
      { kind: "close", role: WILDCARD_ROLE.toLowerCase(), account: ADDR.helper.toLowerCase() },
    ]);
  });
});

describe("rule 2 — open-grant TTL", () => {
  const ttlMs = 15 * 60_000;
  const grant = (over: Partial<OpenGrant> = {}): OpenGrant => ({
    role: WILDCARD_ROLE.toLowerCase(),
    account: ADDR.helper.toLowerCase(),
    grantedAtBlock: 100n,
    grantedAtTs: 0,
    alertedCount: 0,
    ...over,
  });

  test("silent before the TTL elapses", () => {
    expect(ttlEscalations([grant()], ttlMs - 1, ttlMs, ADDR.controller)).toHaveLength(0);
  });

  test("fires CRITICAL once the TTL elapses", () => {
    const out = ttlEscalations([grant()], ttlMs, ttlMs, ADDR.controller);
    expect(out).toHaveLength(1);
    expect(out[0]?.alert.severity).toBe("CRITICAL");
    expect(out[0]?.alert.rule).toBe("controller_grant_ttl_exceeded");
    expect(out[0]?.alertedCount).toBe(1);
  });

  test("does NOT re-fire inside the same interval (injected clock)", () => {
    const alreadyPaged = grant({ alertedCount: 1 });
    expect(ttlEscalations([alreadyPaged], ttlMs + 1, ttlMs, ADDR.controller)).toHaveLength(0);
    expect(ttlEscalations([alreadyPaged], 2 * ttlMs - 1, ttlMs, ADDR.controller)).toHaveLength(0);
  });

  test("re-fires once per further interval, with a fresh dedup key", () => {
    const first = ttlEscalations([grant()], ttlMs, ttlMs, ADDR.controller)[0];
    const second = ttlEscalations(
      [grant({ alertedCount: 1 })],
      2 * ttlMs,
      ttlMs,
      ADDR.controller,
    )[0];
    expect(second?.alertedCount).toBe(2);
    expect(second?.alert.dedupKey).not.toBe(first?.alert.dedupKey);
    expect(second?.alert.detail.escalation).toBe(2);
  });

  test("a long-dead monitor catches up in one step rather than one interval at a time", () => {
    const out = ttlEscalations([grant()], 10 * ttlMs, ttlMs, ADDR.controller);
    expect(out[0]?.alertedCount).toBe(10);
  });
});

describe("rule 4 — admin lifecycle", () => {
  test("DefaultAdminTransferScheduled is CRITICAL and names the acceptance time", async () => {
    const log = makeLog({
      abi: noviControllerAbi,
      eventName: "DefaultAdminTransferScheduled",
      args: { newAdmin: ADDR.attacker, acceptSchedule: 1_700_086_400n },
      address: ADDR.controller,
    });
    const out = await evaluateLog(log, ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.rule).toBe("controller_admin_transfer_scheduled");
    expect(out.alerts[0]?.detail.acceptableAt).toBe("2023-11-15T22:13:20.000Z");
    expect(out.alerts[0]?.detail.renounce).toBe(false);
  });

  test("a transfer to address(0) is flagged as a RENOUNCE", async () => {
    const log = makeLog({
      abi: noviControllerAbi,
      eventName: "DefaultAdminTransferScheduled",
      args: { newAdmin: zeroAddress, acceptSchedule: 1n },
      address: ADDR.controller,
    });
    const out = await evaluateLog(log, ruleContext(), ruleDeps());
    expect(out.alerts[0]?.detail.renounce).toBe(true);
  });

  test("cancel and delay-change events are CRITICAL", async () => {
    for (const eventName of [
      "DefaultAdminTransferCanceled",
      "DefaultAdminDelayChangeCanceled",
    ] as const) {
      const out = await evaluateLog(
        makeLog({ abi: noviControllerAbi, eventName, args: {}, address: ADDR.controller }),
        ruleContext(),
        ruleDeps(),
      );
      expect(out.alerts[0]?.severity).toBe("CRITICAL");
    }
    const delay = await evaluateLog(
      makeLog({
        abi: noviControllerAbi,
        eventName: "DefaultAdminDelayChangeScheduled",
        args: { newDelay: 60n, effectSchedule: 1_700_000_000n },
        address: ADDR.controller,
      }),
      ruleContext(),
      ruleDeps(),
    );
    expect(delay.alerts[0]?.severity).toBe("CRITICAL");
    expect(delay.alerts[0]?.detail.newDelaySeconds).toBe("60");
  });
});

describe("rule 11 — Relayed", () => {
  test("recorded as INFO, never paged", async () => {
    const log = makeLog({
      abi: noviControllerAbi,
      eventName: "Relayed",
      args: {
        caller: ADDR.executor,
        target: ADDR.treasury,
        selector: toFunctionSelector("function spend(address,uint256)"),
      },
      address: ADDR.controller,
    });
    const out = await evaluateLog(log, ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("INFO");
    expect(out.alerts[0]?.rule).toBe("controller_relayed");
  });
});

describe("rule 6 — beacon Upgraded", () => {
  test("CRITICAL on a watched beacon", async () => {
    const log = makeLog({
      abi: [beaconUpgradedEvent],
      eventName: "Upgraded",
      args: { implementation: ADDR.attacker },
      address: ADDR.beacon,
    });
    const out = await evaluateLog(log, ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.rule).toBe("beacon_upgraded");
    expect(out.alerts[0]?.detail.implementation).toBe(ADDR.attacker);
  });

  test("ignored on an address nobody asked us to watch", async () => {
    const log = makeLog({
      abi: [beaconUpgradedEvent],
      eventName: "Upgraded",
      args: { implementation: ADDR.attacker },
      address: "0x9999999999999999999999999999999999999999",
    });
    const out = await evaluateLog(log, ruleContext(), ruleDeps());
    expect(out.alerts).toHaveLength(0);
  });
});

describe("rule 7 — factory ownership", () => {
  test("both the offer and the completion are CRITICAL, on every watched factory", async () => {
    for (const address of [ADDR.factory, ADDR.legacyFactory]) {
      for (const eventName of ["OwnershipTransferStarted", "OwnershipTransferred"] as const) {
        const out = await evaluateLog(
          makeLog({
            abi: legalManagerFactoryAbi,
            eventName,
            args: { previousOwner: ADDR.controller, newOwner: ADDR.attacker },
            address,
          }),
          ruleContext(),
          ruleDeps(),
        );
        expect(out.alerts[0]?.severity).toBe("CRITICAL");
        expect(out.alerts[0]?.subject).toBe(address);
      }
    }
  });
});

describe("rule 8 — registry wallet bind (MetadataSet 'agentWallet')", () => {
  const bind = (agentId: bigint, value: string, address = ADDR.registry) =>
    makeLog({
      abi: [registryMetadataSetEvent],
      eventName: "MetadataSet",
      args: {
        agentId,
        indexedMetadataKey: "agentWallet",
        metadataKey: "agentWallet",
        metadataValue: value,
      },
      address,
    });

  test("a bind matching the recorded operator is INFO", async () => {
    const out = await evaluateLog(bind(881938n, ADDR.operator), ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("INFO");
    expect(out.alerts[0]?.detail.outcome).toBe("match");
    expect(out.alerts[0]?.subject).toBe("pub-1");
  });

  test("a bind to any other wallet is CRITICAL — this op has no timelock and no veto", async () => {
    const out = await evaluateLog(bind(881938n, ADDR.attacker), ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.detail.outcome).toBe("unexpected_rebind");
    expect(out.alerts[0]?.detail.newWallet).toBe(ADDR.attacker);
  });

  test("a CLEARED binding is CRITICAL", async () => {
    const out = await evaluateLog(bind(881938n, "0x"), ruleContext(), ruleDeps());
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.detail.outcome).toBe("cleared");
  });

  test("another operator's agent on the shared registry is ignored", async () => {
    const out = await evaluateLog(bind(4242n, ADDR.attacker), ruleContext(), ruleDeps());
    expect(out.alerts).toHaveLength(0);
  });

  test("a non-wallet metadata key is ignored", async () => {
    const log = makeLog({
      abi: [registryMetadataSetEvent],
      eventName: "MetadataSet",
      args: {
        agentId: 881938n,
        indexedMetadataKey: "ens",
        metadataKey: "ens",
        metadataValue: "0xdeadbeef",
      },
      address: ADDR.registry,
    });
    expect((await evaluateLog(log, ruleContext(), ruleDeps())).alerts).toHaveLength(0);
  });
});

describe("rule 9 — identity NFT transfer", () => {
  const transfer = (from: string, to: string, tokenId: bigint) =>
    makeLog({
      abi: [registryTransferEvent],
      eventName: "Transfer",
      args: { from, to, tokenId },
      address: ADDR.registry,
    });

  test("a move away from the recorded manager is CRITICAL and warns about the cleared binding", async () => {
    const out = await evaluateLog(
      transfer(ADDR.controller, ADDR.attacker, 881938n),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts[0]?.severity).toBe("CRITICAL");
    expect(out.alerts[0]?.rule).toBe("registry_identity_transfer");
    expect(String(out.alerts[0]?.detail.note)).toContain("CLEARS the agentWallet binding");
  });

  test("the MINT leg of our own onboarding is not an alert at all", async () => {
    const out = await evaluateLog(
      transfer(zeroAddress, ADDR.factory, 881938n),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts).toHaveLength(0);
  });

  test("the factory handing the NFT to the recorded manager is INFO, not a page", async () => {
    const out = await evaluateLog(
      transfer(ADDR.factory, ADDR.controller, 881938n),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts[0]?.severity).toBe("INFO");
  });

  test("a token that is not ours is ignored", async () => {
    const out = await evaluateLog(
      transfer(ADDR.controller, ADDR.attacker, 1n),
      ruleContext(),
      ruleDeps(),
    );
    expect(out.alerts).toHaveLength(0);
  });
});

describe("rule 10 — treasury policy updates", () => {
  const scheduled = (payout: string) =>
    makeLog({
      abi: agentTreasuryAbi,
      eventName: "PolicyUpdateScheduled",
      args: {
        policyId: `0x${"11".repeat(32)}`,
        cap: 5_000_000n,
        period: 86_400n,
        allowlistOn: false,
        payoutAddress: payout,
        executableAt: 1_700_003_600n,
      },
      address: ADDR.treasury,
    });

  test("WARN when only cap/period move, plus a guardian-notification row", async () => {
    const out = await evaluateLog(
      scheduled(ADDR.operator),
      ruleContext(),
      ruleDeps({ payout: ADDR.operator }),
    );
    expect(out.alerts).toHaveLength(2);
    const [policy, guardian] = out.alerts;
    expect(policy?.severity).toBe("WARN");
    expect(policy?.subject).toBe(ADDR.treasury);
    expect(guardian?.rule).toBe("treasury_guardian_notification");
    // Subject is the ENTITY: this row is what a guardian-facing surface reads.
    expect(guardian?.subject).toBe("pub-1");
    expect(guardian?.detail.guardian).toBe(ADDR.guardian);
    expect(guardian?.detail.vetoDeadline).toBe("2023-11-14T23:13:20.000Z");
    expect(String(guardian?.detail.action)).toContain("vetoPolicyUpdate");
  });

  test("CRITICAL when the scheduled payout differs from the CURRENT on-chain payout", async () => {
    const out = await evaluateLog(
      scheduled(ADDR.attacker),
      ruleContext(),
      ruleDeps({ payout: ADDR.operator }),
    );
    expect(out.alerts.every((a) => a.severity === "CRITICAL")).toBe(true);
    expect(out.alerts[0]?.detail.payoutChanged).toBe(true);
  });

  test("an unreadable current payout stays WARN and says so — never 'unchanged'", async () => {
    const out = await evaluateLog(
      scheduled(ADDR.attacker),
      ruleContext(),
      ruleDeps({ payout: undefined }),
    );
    expect(out.alerts[0]?.severity).toBe("WARN");
    expect(out.alerts[0]?.detail.currentPayoutAddress).toBe("unreadable");
  });

  test("veto and settle are INFO", async () => {
    const vetoed = await evaluateLog(
      makeLog({
        abi: agentTreasuryAbi,
        eventName: "PolicyUpdateVetoed",
        args: { policyId: `0x${"11".repeat(32)}` },
        address: ADDR.treasury,
      }),
      ruleContext(),
      ruleDeps(),
    );
    expect(vetoed.alerts[0]?.severity).toBe("INFO");

    const updated = await evaluateLog(
      makeLog({
        abi: agentTreasuryAbi,
        eventName: "PolicyUpdated",
        args: {
          cap: 1n,
          period: 2n,
          allowlistOn: true,
          payoutAddress: ADDR.operator,
        },
        address: ADDR.treasury,
      }),
      ruleContext(),
      ruleDeps(),
    );
    expect(updated.alerts[0]?.severity).toBe("INFO");
  });

  test("a treasury that is not in legalbody.db is ignored", async () => {
    const ctx = ruleContext({ entities: indexEntities([entity({ treasury: null })]) });
    expect((await evaluateLog(scheduled(ADDR.attacker), ctx, ruleDeps())).alerts).toHaveLength(0);
  });
});

describe("alert details are JSON-safe", () => {
  test("every bigint is stringified (JSON.stringify throws on BigInt)", async () => {
    const out = await evaluateLog(
      makeLog({
        abi: agentTreasuryAbi,
        eventName: "PolicyUpdateScheduled",
        args: {
          policyId: `0x${"11".repeat(32)}`,
          cap: 5_000_000n,
          period: 86_400n,
          allowlistOn: false,
          payoutAddress: ADDR.operator,
          executableAt: 1_700_003_600n,
        },
        address: ADDR.treasury,
      }),
      ruleContext(),
      ruleDeps({ payout: ADDR.operator }),
    );
    for (const a of out.alerts) expect(() => JSON.stringify(a.detail)).not.toThrow();
  });
});

describe("roleLabel", () => {
  test("names the standing selectors and the two specials", () => {
    expect(roleLabel(DEFAULT_ADMIN_ROLE)).toBe("DEFAULT_ADMIN_ROLE");
    expect(roleLabel(WILDCARD_ROLE)).toBe("WILDCARD_ROLE");
    expect(roleLabel(STANDING_ROLE)).toBe(CONTROLLER_GRANTED_SELECTORS[0]?.name);
    expect(roleLabel(UNKNOWN_ROLE)).toBe("UNKNOWN_SELECTOR_ROLE");
  });
});
