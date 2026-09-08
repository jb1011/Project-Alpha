/**
 * Trust on first use, and what happens when the store is not there.
 *
 * The suite runs in the package's `node` environment (vitest.config.ts, deliberately no jsdom), so
 * `localStorage` is stubbed rather than emulated — which is also the honest test of the module's
 * contract: it reads the store through `globalThis` and must survive its absence, because Next
 * type-checks and renders this component's module graph on the server too.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkPin, readPin, writePin } from "@/lib/agentbook/pin";

/** A minimal Storage. Not jsdom: this suite has no DOM, by design. */
function memoryStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => map.delete(k) as unknown as void,
    setItem: (k: string, v: string) => void map.set(k, v),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("checkPin (trust on first use)", () => {
  test("first sight pins; same address later is fine; a different address is flagged", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(checkPin("agent-1", "0xaaa")).toBe("pinned");
    expect(checkPin("agent-1", "0xaaa")).toBe("match");
    expect(checkPin("agent-1", "0xbbb")).toBe("changed");
  });

  test("address case does not make a pin look changed", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(checkPin("agent-1", "0xAAA")).toBe("pinned");
    expect(checkPin("agent-1", "0xaaa")).toBe("match");
  });

  test("pins are per entity", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(checkPin("agent-1", "0xaaa")).toBe("pinned");
    expect(checkPin("agent-2", "0xbbb")).toBe("pinned");
    expect(checkPin("agent-1", "0xaaa")).toBe("match");
  });

  test("storage failures degrade to 'unavailable', never to 'changed'", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    );
    expect(checkPin("agent-1", "0xaaa")).toBe("unavailable");
  });

  test("a write-only failure (private mode quota) is 'unavailable', not a false 'pinned'", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        setItem: () => {
          throw new Error("quota");
        },
      }),
    );
    expect(checkPin("agent-1", "0xaaa")).toBe("unavailable");
  });

  test("no store at all (server render, or a browser with site data off) is 'unavailable'", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(checkPin("agent-1", "0xaaa")).toBe("unavailable");
  });
});

describe("readPin / writePin", () => {
  test("write then read round-trips, lowercased", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(writePin("agent-1", "0xAbC")).toBe(true);
    expect(readPin("agent-1")).toBe("0xabc");
  });

  test("an unpinned entity reads null, and a dead store reads null rather than throwing", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readPin("agent-9")).toBeNull();
    vi.stubGlobal("localStorage", undefined);
    expect(readPin("agent-9")).toBeNull();
    expect(writePin("agent-9", "0xaaa")).toBe(false);
  });
});
