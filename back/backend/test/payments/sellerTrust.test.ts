import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import { buildSellerTrust } from "../../src/payments/sellerTrust";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

const SELLER = "0x00000000000000000000000000000000000000AB";
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

describe("buildSellerTrust — the buyer-side AgentBook check", () => {
  test("a human-backed seller is verified, and the answer is served from cache after", async () => {
    const r = reader(async () => HUMAN);
    const trust = buildSellerTrust({ policy: "verified-sellers-only", store, reader: r });
    expect(await trust.verify(SELLER)).toBe("verified");
    expect(await trust.verify(SELLER)).toBe("verified");
    expect(r.calls()).toBe(1); // second answer came from the cache
  });

  test("a definitively unregistered seller is refused, and that answer is cached too", async () => {
    const r = reader(async () => null);
    const trust = buildSellerTrust({ policy: "verified-sellers-only", store, reader: r });
    expect(await trust.verify(SELLER)).toBe("unregistered");
    expect(await trust.verify(SELLER)).toBe("unregistered");
    expect(r.calls()).toBe(1); // the contract answered definitively — don't re-ask
  });

  test("an RPC failure is 'unavailable' and NEVER cached — the next call re-reads", async () => {
    // The dangerous mistake this design prevents: caching an outage as a refusal would blacklist
    // a legitimately registered seller for the whole negative TTL.
    const r = reader(async () => {
      throw new Error("HTTP 429 Too Many Requests");
    });
    const trust = buildSellerTrust({ policy: "verified-sellers-only", store, reader: r });
    expect(await trust.verify(SELLER)).toBe("unavailable");
    expect(await trust.verify(SELLER)).toBe("unavailable");
    expect(r.calls()).toBe(2); // still don't know — asked again rather than caching a guess
  });

  test("recovery: an outage followed by a good read verifies and caches normally", async () => {
    let mode: "down" | "ok" = "down";
    const r = reader(async () => {
      if (mode === "down") throw new Error("world chain down");
      return HUMAN;
    });
    const trust = buildSellerTrust({ policy: "verified-sellers-only", store, reader: r });
    expect(await trust.verify(SELLER)).toBe("unavailable");
    mode = "ok";
    expect(await trust.verify(SELLER)).toBe("verified");
    expect(await trust.verify(SELLER)).toBe("verified");
    expect(r.calls()).toBe(2); // down once, read once, then cached
  });
});
