import { describe, expect, test } from "vitest";
import type { LegalBodyDeps } from "../../src/payments/legalBody";
import { createLegalBodyResolver } from "../../src/payments/legalBody";
import type { Address, EntityRecord } from "../../src/types";

/**
 * The ONE definition of "a Novi legal body in good standing" (design 2026-09-10 D1/D2/D8).
 *
 * Every test here counts the calls it depends on: a resolver that silently stopped reading the
 * chain, or stopped asking the repository, would still return plausible answers — which is the
 * exact shape of green-but-vacuous the seller-trust tests were fixed for in #63.
 */

const POCKET = "0xeE85Fd00521d1Aa4c510BDdAb78F375830119354"; // EIP-55, as viem derives it
const TREASURY = "0x00000000000000000000000000000000000000Ab" as Address;
const PROXY = "0x00000000000000000000000000000000000000cD" as Address;

const entity = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  idempotencyKey: "key-1",
  name: "TestMB2",
  status: "funded",
  manager: "0x000000000000000000000000000000000000aAaa" as Address,
  guardian: "0x000000000000000000000000000000000000bBbb" as Address,
  operator: null,
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: "843704",
  proxy: PROXY,
  treasury: TREASURY,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  pocketAddress: POCKET,
  ...over,
});

/** Deps stub with counters + the addresses it was asked for, so precedence and normalisation are
 *  assertable rather than inferred from the outcome. */
function deps(over: {
  pocket?: EntityRecord | undefined;
  treasury?: EntityRecord | undefined;
  status?: number;
  paused?: boolean;
  statusThrows?: boolean;
  pausedThrows?: boolean;
}) {
  const asked: { pocket: string[]; treasury: string[] } = { pocket: [], treasury: [] };
  let statusCalls = 0;
  let pausedCalls = 0;
  const d: LegalBodyDeps = {
    findByPocketAddress: (a) => {
      asked.pocket.push(a);
      return over.pocket;
    },
    findByTreasury: (a) => {
      asked.treasury.push(a);
      return over.treasury;
    },
    legalStatus: async () => {
      statusCalls++;
      if (over.statusThrows) throw new Error("Arc RPC down");
      return over.status ?? 0;
    },
    treasuryPaused: async () => {
      pausedCalls++;
      if (over.pausedThrows) throw new Error("Arc RPC down");
      return over.paused ?? false;
    },
  };
  return { deps: d, asked, statusCalls: () => statusCalls, pausedCalls: () => pausedCalls };
}

describe("which entity the address belongs to (D2)", () => {
  test("the payer (pocket) address of a legal body resolves to that body", async () => {
    const s = deps({ pocket: entity() });
    const r = await createLegalBodyResolver(s.deps).resolve(POCKET);
    expect(r.kind).toBe("body");
    if (r.kind !== "body") return;
    expect(r.matchedBy).toBe("pocket");
    expect(r.entity.agentId).toBe("843704");
    expect(s.asked.pocket).toHaveLength(1);
  });

  test("a treasury address resolves too — the buyer dial's key", async () => {
    const s = deps({ treasury: entity() });
    const r = await createLegalBodyResolver(s.deps).resolve(TREASURY);
    expect(r.kind).toBe("body");
    if (r.kind !== "body") return;
    expect(r.matchedBy).toBe("treasury");
    expect(s.asked.treasury).toHaveLength(1);
  });

  test("the pocket wins: a pocket hit never asks the treasury index", async () => {
    const s = deps({ pocket: entity({ name: "by-pocket" }), treasury: entity({ name: "by-tre" }) });
    const r = await createLegalBodyResolver(s.deps).resolve(POCKET);
    expect(r.kind === "body" && r.entity.name).toBe("by-pocket");
    expect(s.asked.treasury).toHaveLength(0);
  });

  test("EIP-55 and lowercase are the same address, and the repository is asked in lowercase", async () => {
    const s = deps({ pocket: entity() });
    const resolver = createLegalBodyResolver(s.deps);
    expect((await resolver.resolve(POCKET)).kind).toBe("body");
    expect((await resolver.resolve(POCKET.toLowerCase())).kind).toBe("body");
    expect(s.asked.pocket).toEqual([POCKET.toLowerCase(), POCKET.toLowerCase()]);
  });

  test("an address nobody owns is 'none', and nothing is read on chain", async () => {
    const s = deps({});
    expect((await createLegalBodyResolver(s.deps).resolve(POCKET)).kind).toBe("none");
    expect(s.statusCalls()).toBe(0);
  });

  test("an entity that is not public on chain is 'none' (no proxy, no treasury, pre-created, failed)", async () => {
    for (const rec of [
      entity({ proxy: null }),
      entity({ treasury: null }),
      entity({ status: "translating" }),
      entity({ status: "failed" }),
    ]) {
      const s = deps({ pocket: rec });
      expect((await createLegalBodyResolver(s.deps).resolve(POCKET)).kind).toBe("none");
      expect(s.statusCalls()).toBe(0); // nothing on chain to ask about
    }
  });
});

describe("standing: exactly the buyer dial's rule (D1)", () => {
  const standingOf = async (over: Parameters<typeof deps>[0]) => {
    const s = deps({ pocket: entity(), ...over });
    const r = await createLegalBodyResolver(s.deps).resolve(POCKET);
    return { standing: r.kind === "body" ? r.standing : null, s };
  };

  test("legalStatus 0 and an unpaused treasury is active — both reads actually happen", async () => {
    const { standing, s } = await standingOf({ status: 0, paused: false });
    expect(standing).toBe("active");
    expect(s.statusCalls()).toBe(1);
    expect(s.pausedCalls()).toBe(1);
  });

  test("a suspended body is inactive", async () => {
    expect((await standingOf({ status: 1 })).standing).toBe("inactive");
  });

  test("a paused treasury is inactive even when the legal status is Active", async () => {
    expect((await standingOf({ status: 0, paused: true })).standing).toBe("inactive");
  });

  test("a failed status read is 'unknown', never a guess", async () => {
    expect((await standingOf({ statusThrows: true })).standing).toBe("unknown");
  });

  test("a failed pause read is 'unknown' too", async () => {
    expect((await standingOf({ pausedThrows: true })).standing).toBe("unknown");
  });
});

describe("no memory anywhere in the resolver (D8)", () => {
  test("a second resolve re-reads the repository and the chain — a suspension bites at once", async () => {
    let status = 0;
    let statusCalls = 0;
    let repoCalls = 0;
    const resolver = createLegalBodyResolver({
      findByPocketAddress: () => {
        repoCalls++;
        return entity();
      },
      findByTreasury: () => undefined,
      legalStatus: async () => {
        statusCalls++;
        return status;
      },
      treasuryPaused: async () => false,
    });
    const first = await resolver.resolve(POCKET);
    expect(first.kind === "body" && first.standing).toBe("active");
    status = 1; // the guardian suspends the body between the two calls
    const second = await resolver.resolve(POCKET);
    expect(second.kind === "body" && second.standing).toBe("inactive");
    expect(repoCalls).toBe(2);
    expect(statusCalls).toBe(2);
  });

  test("an 'unknown' answer is not remembered either", async () => {
    const s = deps({ pocket: entity(), statusThrows: true });
    const resolver = createLegalBodyResolver(s.deps);
    await resolver.resolve(POCKET);
    await resolver.resolve(POCKET);
    expect(s.statusCalls()).toBe(2);
  });
});
