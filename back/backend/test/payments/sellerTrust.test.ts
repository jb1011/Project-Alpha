import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import type { LegalBodyLookup } from "../../src/payments/sellerTrust";
import { buildSellerTrust } from "../../src/payments/sellerTrust";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address } from "../../src/types";

const SELLER = "0x00000000000000000000000000000000000000AB";
const PROXY = "0x00000000000000000000000000000000000000CD" as Address;
const HUMAN = "0x51db";

let store: SqliteWorldStore;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});

/** Reader stub with a call counter — every test asserts the counter, so none of these can decay
 *  into the vacuous shape PR #63 fixed (green while never reaching the lookup). */
function reader(script: () => Promise<string | null>) {
  let calls = 0;
  return {
    calls: () => calls,
    lookupHuman: async (_a: string) => {
      calls++;
      return script();
    },
  };
}

function trustWith(over: {
  reader?: ReturnType<typeof reader>;
  legalBodies?: LegalBodyLookup;
}) {
  return buildSellerTrust({
    globalPolicy: "open", // irrelevant to verify(); resolution happens in entityPayment
    store,
    reader: over.reader ?? reader(async () => HUMAN),
    legalBodies: over.legalBodies,
  });
}

describe("verified-sellers-only — the AgentBook root", () => {
  test("a human-backed seller is verified, and the answer is served from cache after", async () => {
    const r = reader(async () => HUMAN);
    const trust = trustWith({ reader: r });
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("verified");
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("verified");
    expect(r.calls()).toBe(1); // second answer came from the cache
  });

  test("a definitively unregistered seller is refused, and that answer is cached too", async () => {
    const r = reader(async () => null);
    const trust = trustWith({ reader: r });
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("not-human-backed");
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("not-human-backed");
    expect(r.calls()).toBe(1); // the contract answered definitively — don't re-ask
  });

  test("an RPC failure is 'unavailable' and NEVER cached — the next call re-reads", async () => {
    // Caching an outage as a refusal would blacklist a legitimately registered seller.
    const r = reader(async () => {
      throw new Error("HTTP 429 Too Many Requests");
    });
    const trust = trustWith({ reader: r });
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("unavailable");
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("unavailable");
    expect(r.calls()).toBe(2); // still don't know — asked again rather than caching a guess
  });

  test("recovery: an outage followed by a good read verifies and caches normally", async () => {
    let mode: "down" | "ok" = "down";
    const r = reader(async () => {
      if (mode === "down") throw new Error("world chain down");
      return HUMAN;
    });
    const trust = trustWith({ reader: r });
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("unavailable");
    mode = "ok";
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("verified");
    expect(await trust.verify(SELLER, "verified-sellers-only")).toBe("verified");
    expect(r.calls()).toBe(2); // down once, read once, then cached
  });
});

describe("verified-legal-bodies-only — the Novi registry root", () => {
  /** LegalBodyLookup stub with call counters, same anti-vacuous discipline. */
  function bodies(over: {
    found?: boolean;
    status?: number;
    paused?: boolean;
    statusThrows?: boolean;
  }) {
    let statusCalls = 0;
    const lookup: LegalBodyLookup = {
      findByTreasury: (addr: string) =>
        (over.found ?? true) ? { proxy: PROXY, treasury: addr } : undefined,
      legalStatus: async () => {
        statusCalls++;
        if (over.statusThrows) throw new Error("Arc RPC down");
        return over.status ?? 0;
      },
      treasuryPaused: async () => over.paused ?? false,
    };
    return { lookup, statusCalls: () => statusCalls };
  }

  test("an active legal body's treasury is verified (status actually read)", async () => {
    const b = bodies({ status: 0, paused: false });
    const trust = trustWith({ legalBodies: b.lookup });
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("verified");
    expect(b.statusCalls()).toBe(1);
  });

  test("an unknown treasury is not a legal body", async () => {
    const b = bodies({ found: false });
    const trust = trustWith({ legalBodies: b.lookup });
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("not-legal-body");
    expect(b.statusCalls()).toBe(0); // nothing to read status for
  });

  test("a suspended legal body is refused as inactive", async () => {
    const b = bodies({ status: 1 });
    const trust = trustWith({ legalBodies: b.lookup });
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("legal-body-inactive");
  });

  test("a paused treasury is refused as inactive even when legal status is Active", async () => {
    const b = bodies({ status: 0, paused: true });
    const trust = trustWith({ legalBodies: b.lookup });
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("legal-body-inactive");
  });

  test("a failed on-chain read is 'unavailable' and NEVER cached — next call re-reads", async () => {
    const b = bodies({ statusThrows: true });
    const trust = trustWith({ legalBodies: b.lookup });
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("unavailable");
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("unavailable");
    expect(b.statusCalls()).toBe(2); // fresh read every time — no caching in this tier at all
  });

  test("a VERIFIED answer is not cached either: a suspension bites on the very next payment", async () => {
    let status = 0;
    const lookup: LegalBodyLookup = {
      findByTreasury: (addr) => ({ proxy: PROXY, treasury: addr }),
      legalStatus: async () => status,
      treasuryPaused: async () => false,
    };
    const trust = trustWith({ legalBodies: lookup });
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("verified");
    status = 1; // guardian suspends the body
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("legal-body-inactive");
  });

  test("tier requested but legalBodies not wired -> fails closed as unavailable", async () => {
    const trust = trustWith({});
    expect(await trust.verify(SELLER, "verified-legal-bodies-only")).toBe("unavailable");
  });
});
