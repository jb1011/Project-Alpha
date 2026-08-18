import {
  type Abi,
  type Address,
  type Hex,
  decodeEventLog,
  getAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { agentTreasuryAbi, legalManagerFactoryAbi, noviControllerAbi } from "../abis/generated";
import { CONTROLLER_GRANTED_SELECTORS, selectorRole } from "../adapters/arc/bootVerify";
import type { Alert, Severity } from "./alerts";
import type { EntityIndex, MonitoredEntity } from "./entityLookup";
import {
  AGENT_WALLET_KEY,
  DEFAULT_ADMIN_ROLE,
  TOPIC,
  WILDCARD_ROLE,
  beaconUpgradedEvent,
  registryMetadataSetEvent,
  registryTransferEvent,
} from "./events";
import type { RawLog } from "./rpc";
import { logKey } from "./scan";
import type { OpenGrant } from "./store";

/**
 * The rule set from docs/design/2026-08-13-novi-controller-design.md §8.
 *
 * Design premise, stated once because every severity below follows from it: the controller's 24h
 * admin delay and the treasury's policy timelock are REACTION WINDOWS, not automatic defenses.
 * `grantRole` is instant; a breached backend can schedule a policy and then spend to it. Nothing
 * here prevents an attack — it exists so a human is looking during the window in which a human can
 * still act. That is why so many rules are CRITICAL and why INFO rows are written at all (they are
 * the trail you read afterwards to answer "was this us?").
 */

export interface RuleContext {
  controller: Address;
  registry: Address;
  /** lowercased */
  factories: ReadonlySet<string>;
  /** lowercased */
  beacons: ReadonlySet<string>;
  /** The platform signing key's ADDRESS. Needed to tell the permanent standing grant apart from a
   *  ceremony grant; the monitor never holds the key itself (see main.ts). */
  executor: Address;
  /** lowercased role ids of the seven standing executor selectors. */
  standingRoles: ReadonlySet<string>;
  entities: EntityIndex;
}

export interface RuleDeps {
  now(): number;
  /** Current on-chain `payoutAddress` of a treasury; undefined when the read failed. */
  currentPayout(treasury: Address): Promise<Address | undefined>;
}

/** A grant to start tracking for TTL, or one to close. */
export type GrantOp =
  | { kind: "open"; role: string; account: string; block: bigint; ts: number }
  | { kind: "close"; role: string; account: string };

export interface RuleOutcome {
  alerts: Alert[];
  grants: GrantOp[];
}

const EMPTY: RuleOutcome = { alerts: [], grants: [] };

/** JSON.stringify throws on BigInt, and every alert detail is persisted as JSON. */
function s(v: bigint | number | string): string {
  return v.toString();
}

/** uint48/uint256 chain seconds -> ISO, so an operator reads a deadline instead of an epoch. */
function isoFromSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** "AgentTreasury.schedulePolicyUpdate" for a standing selector role; a label for the specials. */
export function roleLabel(role: Hex): string {
  const lower = role.toLowerCase();
  if (lower === DEFAULT_ADMIN_ROLE) return "DEFAULT_ADMIN_ROLE";
  if (lower === WILDCARD_ROLE) return "WILDCARD_ROLE";
  const known = CONTROLLER_GRANTED_SELECTORS.find(
    (g) => selectorRole(g.selector).toLowerCase() === lower,
  );
  return known ? known.name : "UNKNOWN_SELECTOR_ROLE";
}

/** One entity's stable public handle for an alert subject. */
function entitySubject(e: MonitoredEntity): string {
  return e.publicId ?? e.idempotencyKey;
}

function alert(
  severity: Severity,
  rule: string,
  subject: string,
  detail: Record<string, unknown>,
  ts: number,
  dedupKey: string,
): Alert {
  return { severity, rule, subject, detail, ts, dedupKey };
}

/**
 * Route one log to its rule. Unknown addresses and unknown topics are silently ignored: we read
 * every log our own contracts emit (cheap, and it means a new event never needs a filter change),
 * so most of what arrives here legitimately has no rule.
 */
export async function evaluateLog(
  log: RawLog,
  ctx: RuleContext,
  deps: RuleDeps,
): Promise<RuleOutcome> {
  const address = log.address.toLowerCase();
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return EMPTY;

  if (address === ctx.controller.toLowerCase()) return controllerRule(log, topic0, ctx, deps);
  if (ctx.beacons.has(address)) return beaconRule(log, topic0, deps);
  if (ctx.factories.has(address)) return factoryRule(log, topic0, deps);
  if (address === ctx.registry.toLowerCase()) return registryRule(log, topic0, ctx, deps);
  const treasuryOwner = ctx.entities.byTreasury.get(address);
  if (treasuryOwner) return treasuryRule(log, topic0, treasuryOwner, deps);
  return EMPTY;
}

// --- Rules 1, 3, 4, 5, 11: the controller itself -----------------------------------------------

function controllerRule(
  log: RawLog,
  topic0: string,
  ctx: RuleContext,
  deps: RuleDeps,
): RuleOutcome {
  const ts = deps.now();
  const base = { tx: log.transactionHash, block: s(log.blockNumber) };

  if (topic0 === TOPIC.roleGranted.toLowerCase()) {
    const { role, account, sender } = decode(log, noviControllerAbi) as {
      role: Hex;
      account: Address;
      sender: Address;
    };
    const roleHex = role.toLowerCase();
    const isWildcard = roleHex === WILDCARD_ROLE;
    const isAdmin = roleHex === DEFAULT_ADMIN_ROLE;
    const isStanding = ctx.standingRoles.has(roleHex);
    // Rule 1. WARN is the floor — even a legitimate break-glass grant is worth seeing. CRITICAL the
    // moment the grant is WILDCARD (relay anything at anything) or a role outside the seven the
    // deploy pinned, because those two shapes have no routine cause.
    const severity: Severity = isWildcard || !isStanding ? "CRITICAL" : "WARN";
    const alerts: Alert[] = [
      alert(
        severity,
        "controller_role_granted",
        ctx.controller,
        {
          ...base,
          role,
          roleLabel: roleLabel(role),
          account,
          grantedBy: sender,
          wildcard: isWildcard,
          standingExecutorRole: isStanding,
        },
        ts,
        logKey("controller_role_granted", log),
      ),
    ];

    // Rule 5. A DEFAULT_ADMIN_ROLE grant is the COMPLETION of an admin handover — the 24h window
    // that started at DefaultAdminTransferScheduled has expired and someone accepted. Alerted
    // separately from rule 1 because the operator response is different (verify who holds the
    // controller now), and because the two must not share a dedup key.
    if (isAdmin)
      alerts.push(
        alert(
          "CRITICAL",
          "controller_default_admin_granted",
          ctx.controller,
          {
            ...base,
            newAdmin: account,
            grantedBy: sender,
            meaning: "admin transfer COMPLETED — the controller has a new DEFAULT_ADMIN",
          },
          ts,
          logKey("controller_default_admin_granted", log),
        ),
      );

    // Rule 2 bookkeeping. Two classes are deliberately NOT tracked for TTL:
    //  - DEFAULT_ADMIN_ROLE: permanent by design (never renounce — design §8).
    //  - a standing selector role held by the EXECUTOR: the exact pairing bootVerify asserts
    //    on-chain at every API boot.
    // Everything else is a ceremony grant that is supposed to be revoked in the same transaction.
    const permanent = isAdmin || (isStanding && isAddressEqual(account, ctx.executor));
    const grants: GrantOp[] = permanent
      ? []
      : [
          {
            kind: "open",
            role: roleHex,
            account: account.toLowerCase(),
            block: log.blockNumber,
            ts,
          },
        ];
    return { alerts, grants };
  }

  if (topic0 === TOPIC.roleRevoked.toLowerCase()) {
    const { role, account, sender } = decode(log, noviControllerAbi) as {
      role: Hex;
      account: Address;
      sender: Address;
    };
    // Rule 3. INFO: a revoke is the ceremony ending correctly. It closes the TTL row, which is the
    // part that actually matters.
    return {
      alerts: [
        alert(
          "INFO",
          "controller_role_revoked",
          ctx.controller,
          { ...base, role, roleLabel: roleLabel(role), account, revokedBy: sender },
          ts,
          logKey("controller_role_revoked", log),
        ),
      ],
      grants: [{ kind: "close", role: role.toLowerCase(), account: account.toLowerCase() }],
    };
  }

  // Rule 4. The admin lifecycle. Every one of these is CRITICAL because the 24h delay IS the
  // defense: it only helps if somebody notices inside it.
  if (topic0 === TOPIC.defaultAdminTransferScheduled.toLowerCase()) {
    const { newAdmin, acceptSchedule } = decode(log, noviControllerAbi) as {
      newAdmin: Address;
      acceptSchedule: bigint;
    };
    return single(
      alert(
        "CRITICAL",
        "controller_admin_transfer_scheduled",
        ctx.controller,
        {
          ...base,
          newAdmin,
          acceptableAt: isoFromSeconds(acceptSchedule),
          renounce: isAddressEqual(newAdmin, zeroAddress),
        },
        ts,
        logKey("controller_admin_transfer_scheduled", log),
      ),
    );
  }
  if (topic0 === TOPIC.defaultAdminTransferCanceled.toLowerCase())
    return single(
      alert(
        "CRITICAL",
        "controller_admin_transfer_canceled",
        ctx.controller,
        base,
        ts,
        logKey("controller_admin_transfer_canceled", log),
      ),
    );
  if (topic0 === TOPIC.defaultAdminDelayChangeScheduled.toLowerCase()) {
    const { newDelay, effectSchedule } = decode(log, noviControllerAbi) as {
      newDelay: bigint;
      effectSchedule: bigint;
    };
    return single(
      alert(
        "CRITICAL",
        "controller_admin_delay_change_scheduled",
        ctx.controller,
        { ...base, newDelaySeconds: s(newDelay), effectiveAt: isoFromSeconds(effectSchedule) },
        ts,
        logKey("controller_admin_delay_change_scheduled", log),
      ),
    );
  }
  if (topic0 === TOPIC.defaultAdminDelayChangeCanceled.toLowerCase())
    return single(
      alert(
        "CRITICAL",
        "controller_admin_delay_change_canceled",
        ctx.controller,
        base,
        ts,
        logKey("controller_admin_delay_change_canceled", log),
      ),
    );

  // Not in the §8 list, added here: an M5 pin is what stops a registry selector being relayed at an
  // arbitrary contract. bootVerify proves the pins at BOOT; without this rule a runtime unpin would
  // go unseen until the next restart.
  if (topic0 === TOPIC.boundTargetSet.toLowerCase()) {
    const { selector, target } = decode(log, noviControllerAbi) as {
      selector: Hex;
      target: Address;
    };
    return single(
      alert(
        "CRITICAL",
        "controller_bound_target_set",
        ctx.controller,
        { ...base, selector, target, unpinned: isAddressEqual(target, zeroAddress) },
        ts,
        logKey("controller_bound_target_set", log),
      ),
    );
  }

  // Rule 11. Recorded, never paged. Monitoring keys off TARGET events by design (§8) — a relay is
  // only evidence that the executor did something, and decoy relays at harmless targets are cheap.
  if (topic0 === TOPIC.relayed.toLowerCase()) {
    const { caller, target, selector } = decode(log, noviControllerAbi) as {
      caller: Address;
      target: Address;
      selector: Hex;
    };
    return single(
      alert(
        "INFO",
        "controller_relayed",
        ctx.controller,
        { ...base, caller, target, selector },
        ts,
        logKey("controller_relayed", log),
      ),
    );
  }

  return EMPTY;
}

// --- Rule 6: beacons ---------------------------------------------------------------------------

function beaconRule(log: RawLog, topic0: string, deps: RuleDeps): RuleOutcome {
  if (topic0 !== TOPIC.upgraded.toLowerCase()) return EMPTY;
  const { implementation } = decode(log, [beaconUpgradedEvent]) as { implementation: Address };
  // A beacon upgrade replaces the LOGIC OF EVERY AGENT behind it in one transaction. There is no
  // per-agent consent and no timelock; this is the single highest-blast-radius event on the chain
  // for this platform.
  return single({
    severity: "CRITICAL",
    rule: "beacon_upgraded",
    subject: log.address,
    detail: {
      tx: log.transactionHash,
      block: s(log.blockNumber),
      implementation,
      impact: "fleet-wide logic replacement for every agent behind this beacon",
    },
    ts: deps.now(),
    dedupKey: logKey("beacon_upgraded", log),
  });
}

// --- Rule 7: factories -------------------------------------------------------------------------

function factoryRule(log: RawLog, topic0: string, deps: RuleDeps): RuleOutcome {
  const ts = deps.now();
  const base = { tx: log.transactionHash, block: s(log.blockNumber) };
  if (topic0 === TOPIC.ownershipTransferStarted.toLowerCase()) {
    const { previousOwner, newOwner } = decode(log, legalManagerFactoryAbi) as {
      previousOwner: Address;
      newOwner: Address;
    };
    // Ownable2Step: this is the OFFER. The window between offer and acceptance is the one moment
    // an unwanted handover can still be cancelled by the current owner.
    return single(
      alert(
        "CRITICAL",
        "factory_ownership_transfer_started",
        log.address,
        { ...base, previousOwner, newOwner },
        ts,
        logKey("factory_ownership_transfer_started", log),
      ),
    );
  }
  if (topic0 === TOPIC.ownershipTransferred.toLowerCase()) {
    const { previousOwner, newOwner } = decode(log, legalManagerFactoryAbi) as {
      previousOwner: Address;
      newOwner: Address;
    };
    return single(
      alert(
        "CRITICAL",
        "factory_ownership_transferred",
        log.address,
        { ...base, previousOwner, newOwner },
        ts,
        logKey("factory_ownership_transferred", log),
      ),
    );
  }
  return EMPTY;
}

// --- Rules 8 + 9: the shared identity registry -------------------------------------------------

function registryRule(log: RawLog, topic0: string, ctx: RuleContext, deps: RuleDeps): RuleOutcome {
  const ts = deps.now();

  if (topic0 === TOPIC.metadataSet.toLowerCase()) {
    const { agentId, metadataKey, metadataValue } = decode(log, [registryMetadataSetEvent]) as {
      agentId: bigint;
      metadataKey: string;
      metadataValue: Hex;
    };
    if (metadataKey !== AGENT_WALLET_KEY) return EMPTY;
    const entity = ctx.entities.byAgentId.get(agentId.toString());
    if (!entity) return EMPTY; // another operator's agent on a registry we share.

    const base = {
      tx: log.transactionHash,
      block: s(log.blockNumber),
      agentId: s(agentId),
      entity: entity.name,
      recordedOperator: entity.operator,
    };

    // `abi.encodePacked(address)` = 20 bytes. Empty = the binding was CLEARED, which the registry
    // does on every transfer and on unsetAgentWallet.
    if (metadataValue === "0x" || metadataValue.length !== 42)
      return single(
        alert(
          "CRITICAL",
          "registry_agent_wallet_set",
          entitySubject(entity),
          {
            ...base,
            outcome: "cleared",
            newWallet: null,
            meaning:
              "the agent's wallet binding was removed — x402/job paths that resolve the agent wallet will fail until it is re-bound",
          },
          ts,
          logKey("registry_agent_wallet_set", log),
        ),
      );

    const newWallet = getAddress(metadataValue);
    const matches = entity.operator ? isAddressEqual(newWallet, entity.operator as Address) : false;
    // The one granted operation with NO timelock and NO guardian veto (design §8). If the wallet
    // does not match the operator we provisioned, either the bind is not ours or our own record is
    // stale — both need a human before any payment routes to it.
    return single(
      alert(
        matches ? "INFO" : "CRITICAL",
        "registry_agent_wallet_set",
        entitySubject(entity),
        {
          ...base,
          outcome: matches ? "match" : "unexpected_rebind",
          newWallet,
        },
        ts,
        logKey("registry_agent_wallet_set", log),
      ),
    );
  }

  if (topic0 === TOPIC.transfer.toLowerCase()) {
    const { from, to, tokenId } = decode(log, [registryTransferEvent]) as {
      from: Address;
      to: Address;
      tokenId: bigint;
    };
    const entity = ctx.entities.byAgentId.get(tokenId.toString());
    if (!entity) return EMPTY;
    // The MINT leg of our own onboarding (registry._safeMints to the caller). Not a custody change.
    if (isAddressEqual(from, zeroAddress)) return EMPTY;
    const expected = entity.manager as Address;
    const landedWhereExpected = isAddressEqual(to, expected);
    return single(
      alert(
        landedWhereExpected ? "INFO" : "CRITICAL",
        "registry_identity_transfer",
        entitySubject(entity),
        {
          tx: log.transactionHash,
          block: s(log.blockNumber),
          agentId: s(tokenId),
          entity: entity.name,
          from,
          to,
          recordedManager: expected,
          // Worth repeating in every alert: this is not only a custody change, it also silently
          // breaks the agent's wallet resolution.
          note: "the live registry CLEARS the agentWallet binding on transfer — the agent cannot be resolved to a wallet until it is re-bound",
        },
        ts,
        logKey("registry_identity_transfer", log),
      ),
    );
  }

  return EMPTY;
}

// --- Rule 10: treasuries -----------------------------------------------------------------------

async function treasuryRule(
  log: RawLog,
  topic0: string,
  entity: MonitoredEntity,
  deps: RuleDeps,
): Promise<RuleOutcome> {
  const ts = deps.now();
  const base = { tx: log.transactionHash, block: s(log.blockNumber), entity: entity.name };

  if (topic0 === TOPIC.policyUpdateScheduled.toLowerCase()) {
    const { policyId, cap, period, allowlistOn, payoutAddress, executableAt } = decode(
      log,
      agentTreasuryAbi,
    ) as {
      policyId: Hex;
      cap: bigint;
      period: bigint;
      allowlistOn: boolean;
      payoutAddress: Address;
      executableAt: bigint;
    };
    const treasury = log.address as Address;
    const current = await deps.currentPayout(treasury);
    // A payout change is the shape a backend breach takes: schedule the money somewhere else, wait
    // out the timelock, drain. Everything else is a cap/period tuning we still want to see.
    const payoutChanged = current !== undefined && !isAddressEqual(current, payoutAddress);
    const severity: Severity = payoutChanged ? "CRITICAL" : "WARN";
    const vetoDeadline = isoFromSeconds(executableAt);
    const shared = {
      ...base,
      treasury,
      policyId,
      cap: s(cap),
      period: s(period),
      allowlistOn,
      scheduledPayoutAddress: payoutAddress,
      currentPayoutAddress: current ?? "unreadable",
      payoutChanged,
      vetoDeadline,
    };

    return {
      alerts: [
        alert(
          severity,
          "treasury_policy_update_scheduled",
          treasury,
          shared,
          ts,
          logKey("treasury_policy_update_scheduled", log),
        ),
        // Design §8: "the guardian veto is the designed line of defense, and it only works if the
        // guardian NOTICES" — so the notification is its own record, subject-keyed on the ENTITY
        // and carrying the guardian address and the deadline they have to act by.
        alert(
          severity,
          "treasury_guardian_notification",
          entitySubject(entity),
          {
            ...shared,
            guardian: entity.guardian,
            action: `guardian may call vetoPolicyUpdate(${policyId}) on ${treasury} before ${vetoDeadline}`,
          },
          ts,
          logKey("treasury_guardian_notification", log),
        ),
      ],
      grants: [],
    };
  }

  if (topic0 === TOPIC.policyUpdateVetoed.toLowerCase()) {
    const { policyId } = decode(log, agentTreasuryAbi) as { policyId: Hex };
    return single(
      alert(
        "INFO",
        "treasury_policy_update_vetoed",
        log.address,
        { ...base, policyId },
        ts,
        logKey("treasury_policy_update_vetoed", log),
      ),
    );
  }

  if (topic0 === TOPIC.policyUpdated.toLowerCase()) {
    const { cap, period, allowlistOn, payoutAddress } = decode(log, agentTreasuryAbi) as {
      cap: bigint;
      period: bigint;
      allowlistOn: boolean;
      payoutAddress: Address;
    };
    return single(
      alert(
        "INFO",
        "treasury_policy_updated",
        log.address,
        { ...base, cap: s(cap), period: s(period), allowlistOn, payoutAddress },
        ts,
        logKey("treasury_policy_updated", log),
      ),
    );
  }

  return EMPTY;
}

// --- Rule 2: the open-grant TTL sweep ----------------------------------------------------------

export interface TtlEscalation {
  alert: Alert;
  /** New alertedCount to persist, so the next interval fires exactly once more. */
  alertedCount: number;
  role: string;
  account: string;
}

/**
 * Rule 2. A break-glass grant is meant to live for one transaction — `BreakGlassOneShot.execute`
 * grants, acts and renounces atomically. A grant still standing after the TTL means either the
 * ceremony went wrong or nobody granted it on purpose, and both are pages.
 *
 * Re-alerts once per elapsed TTL interval (not once per tick): `alertedCount` is the number of
 * intervals already paged, so the dedup key advances only when a new interval is crossed.
 */
export function ttlEscalations(
  open: readonly OpenGrant[],
  now: number,
  ttlMs: number,
  controller: Address,
): TtlEscalation[] {
  const out: TtlEscalation[] = [];
  for (const g of open) {
    const elapsedIntervals = Math.floor((now - g.grantedAtTs) / ttlMs);
    if (elapsedIntervals <= g.alertedCount) continue;
    const ageMin = Math.round((now - g.grantedAtTs) / 60_000);
    out.push({
      role: g.role,
      account: g.account,
      alertedCount: elapsedIntervals,
      alert: {
        severity: "CRITICAL",
        rule: "controller_grant_ttl_exceeded",
        subject: controller,
        detail: {
          role: g.role,
          roleLabel: roleLabel(g.role as Hex),
          account: g.account,
          grantedAtBlock: s(g.grantedAtBlock),
          grantedAt: new Date(g.grantedAtTs).toISOString(),
          ageMinutes: ageMin,
          escalation: elapsedIntervals,
          meaning:
            "break-glass grant outlived its ceremony — it should have been revoked in the same transaction",
        },
        ts: now,
        // Interval-scoped: the same standing grant pages once per TTL, not once per poll.
        dedupKey: `controller_grant_ttl_exceeded:${g.role}:${g.account}:${elapsedIntervals}`,
      },
    });
  }
  return out;
}

// --- helpers -----------------------------------------------------------------------------------

function single(a: Alert): RuleOutcome {
  return { alerts: [a], grants: [] };
}

/**
 * Decode a log against whichever ABI its address belongs to. Widened to `Abi` on purpose: the
 * generated ABIs are `as const` tuples of different shapes, and each caller has already dispatched
 * on topic0 and therefore knows exactly which named args it is reading back.
 */
function decode(log: RawLog, abi: readonly unknown[]): Record<string, unknown> {
  const decoded = decodeEventLog({
    abi: abi as Abi,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  }) as { args?: Record<string, unknown> };
  return decoded.args ?? {};
}
