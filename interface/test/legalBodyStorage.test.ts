/**
 * The legal-body flow's local memory, asserted BY VALUE.
 *
 * The flow handles a company name, a filing number, a declarant's name and title, a signed
 * statement, the typed data behind it and a signature. None of that belongs in a browser store:
 * what survives a reload is five opaque values, and the memory is an ALLOWLIST so a field nobody
 * thought about is not persisted. The cases below call the functions and inspect the bytes they
 * produce, because a list of names can only say what the source looks like.
 *
 * The suite runs in node with no DOM, so `localStorage` exists only where a test installs a stub,
 * and every stub is removed after its test.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildLegalBodyMemory,
  clearLegalBodyMemory,
  LEGAL_BODY_STORAGE_KEY,
  parseLegalBodyMemory,
  PERSISTED_LEGAL_BODY_KEYS,
  readLegalBodyMemory,
  writeLegalBodyMemory,
  type LegalBodyMemory,
} from "@/lib/legalBody/storage";

/** Two of anvil's published test accounts, as served (checksummed). */
const TENANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_TENANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

/** The wizard's own key: this module never reads or writes it. */
const ONBOARDING_KEY = "pa-onboarding-v3";

/** A memory with every field set to a value of the right shape. */
function fullMemory(over: Partial<LegalBodyMemory> = {}): LegalBodyMemory {
  return {
    tenant: TENANT,
    companyId: "cmp_opaque_handle",
    orderId: "ord_opaque_handle",
    ownerChoice: "this-wallet",
    agentId: "42",
    ...over,
  };
}

/** What a person types or signs in the flow, each value distinctive enough to grep a blob for. */
const TYPED_FIELDS = {
  companyName: "Example Test Holdings LLC",
  filingNumber: "TEST-0001",
  declarantName: "Avery Placeholder-Declarant",
  declarantTitle: "Managing Member Of Record",
  signature: `0x${"ab".repeat(65)}`,
  typedData: {
    primaryType: "StatementOfAuthority",
    message: { declarantName: "Typed Data Inner Name", companyName: "Typed Data Inner Company" },
  },
  statement: "I state that the signer may act for this company",
  uri: "https://example.test/agent-card-must-never-persist.json",
  message: "a message that must never reach a browser store",
};

const TYPED_KEYS = Object.keys(TYPED_FIELDS);
/** Every string a typed field carries, the nested ones of the typed data included. */
const TYPED_VALUES = [
  "Example Test Holdings LLC",
  "TEST-0001",
  "Avery Placeholder-Declarant",
  "Managing Member Of Record",
  `0x${"ab".repeat(65)}`,
  "StatementOfAuthority",
  "Typed Data Inner Name",
  "Typed Data Inner Company",
  "I state that the signer may act for this company",
  "https://example.test/agent-card-must-never-persist.json",
  "a message that must never reach a browser store",
];

/** A minimal Storage that records every key it is asked about. Not jsdom: this suite has no DOM. */
function memoryStorage(overrides: Partial<Storage> = {}) {
  const map = new Map<string, string>();
  const touched: string[] = [];
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => {
      touched.push(k);
      return map.get(k) ?? null;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      touched.push(k);
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      touched.push(k);
      map.set(k, v);
    },
    ...overrides,
  };
  return { storage, map, touched };
}

afterEach(() => vi.unstubAllGlobals());

describe("the allowlist", () => {
  test("the memory has its own key, and the allowlist is exactly the five opaque names", () => {
    expect(LEGAL_BODY_STORAGE_KEY).toBe("pa-legal-body-v1");
    expect(LEGAL_BODY_STORAGE_KEY).not.toBe(ONBOARDING_KEY);
    expect([...PERSISTED_LEGAL_BODY_KEYS]).toEqual([
      "tenant",
      "companyId",
      "orderId",
      "ownerChoice",
      "agentId",
    ]);
    // The built memory carries exactly those names: none missing, none added.
    expect(Object.keys(buildLegalBodyMemory({ tenant: TENANT })).sort()).toEqual(
      [...PERSISTED_LEGAL_BODY_KEYS].sort(),
    );
  });

  test("a state carrying what a person typed loses every field, by key and by value", () => {
    // The shape this exists to catch: somebody spreads the whole flow state into the memory
    // "just until the page reloads". The flow keeps working, and a declarant's name sits in a
    // browser store.
    const state = { ...fullMemory(), ...TYPED_FIELDS };

    const bytes = JSON.stringify(buildLegalBodyMemory(state));

    for (const key of TYPED_KEYS) expect(bytes, key).not.toContain(key);
    for (const value of TYPED_VALUES) expect(bytes, value).not.toContain(value);
    // ...and the opaque handles do survive, or this test would pass against a function that
    // remembered nothing at all.
    expect(bytes).toContain("cmp_opaque_handle");
    expect(bytes).toContain("ord_opaque_handle");
    expect(bytes).toContain("this-wallet");
  });

  test("a typed value put under an allowed name fails its shape and is not kept", () => {
    const memory = buildLegalBodyMemory({
      tenant: TENANT,
      companyId: TYPED_FIELDS.companyName,
      orderId: TYPED_FIELDS.signature,
      ownerChoice: TYPED_FIELDS.declarantName,
      agentId: TYPED_FIELDS.filingNumber,
    });

    expect(memory).toEqual({
      tenant: TENANT,
      companyId: null,
      orderId: null,
      ownerChoice: null,
      agentId: null,
    });
    const bytes = JSON.stringify(memory);
    for (const value of TYPED_VALUES) expect(bytes, value).not.toContain(value);
  });

  test("writing a state that carries typed fields stores exactly the built memory", () => {
    const { storage, map, touched } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const state = { ...fullMemory(), ...TYPED_FIELDS };

    writeLegalBodyMemory(state as unknown as LegalBodyMemory);

    const stored = map.get(LEGAL_BODY_STORAGE_KEY);
    expect(stored).toBe(JSON.stringify(buildLegalBodyMemory(state)));
    for (const key of TYPED_KEYS) expect(stored, key).not.toContain(key);
    for (const value of TYPED_VALUES) expect(stored, value).not.toContain(value);
    expect([...map.keys()]).toEqual([LEGAL_BODY_STORAGE_KEY]);
    expect(touched).not.toContain(ONBOARDING_KEY);
  });

  test("a tenant that is not an address is refused, never remembered", () => {
    expect(() => buildLegalBodyMemory({ tenant: "0x1234" })).toThrow();
    expect(() => buildLegalBodyMemory({ tenant: TYPED_FIELDS.declarantName })).toThrow();

    // The write path stores nothing for it, and does not throw into the flow either.
    const { storage, map } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(() =>
      writeLegalBodyMemory(fullMemory({ tenant: TYPED_FIELDS.declarantName as `0x${string}` })),
    ).not.toThrow();
    expect(map.size).toBe(0);
  });
});

describe("parseLegalBodyMemory", () => {
  test("a memory of another tenant reads null", () => {
    const raw = JSON.stringify(fullMemory());
    expect(parseLegalBodyMemory(raw, OTHER_TENANT)).toBeNull();
  });

  test("a memory whose tenant differs only in case reads", () => {
    const checksummed = JSON.stringify(fullMemory());
    expect(parseLegalBodyMemory(checksummed, TENANT.toLowerCase() as `0x${string}`)).toEqual(
      fullMemory(),
    );

    const lower = JSON.stringify(fullMemory({ tenant: TENANT.toLowerCase() as `0x${string}` }));
    expect(parseLegalBodyMemory(lower, TENANT)).not.toBeNull();
  });

  test("a missing, malformed or non-object blob reads null", () => {
    for (const raw of [
      null,
      "",
      "{not json",
      "null",
      "42",
      '"a string"',
      "true",
      "[]",
      JSON.stringify([fullMemory()]),
    ]) {
      expect(parseLegalBodyMemory(raw, TENANT), String(raw)).toBeNull();
    }
  });

  test("a blob without an address for a tenant reads null", () => {
    for (const tenant of [undefined, null, 42, "", "0x1234", `${TENANT}00`, TENANT.slice(2)]) {
      const raw = JSON.stringify({ ...fullMemory(), tenant });
      expect(parseLegalBodyMemory(raw, TENANT), String(tenant)).toBeNull();
    }
  });

  test("an agentId with a leading zero reads null, and the rest of the memory survives", () => {
    const raw = JSON.stringify(fullMemory({ agentId: "042" }));
    expect(parseLegalBodyMemory(raw, TENANT)).toEqual(fullMemory({ agentId: null }));
  });

  test("an agentId is a decimal string of at most 78 digits", () => {
    const agentIdOf = (agentId: unknown) =>
      parseLegalBodyMemory(JSON.stringify({ ...fullMemory(), agentId }), TENANT)?.agentId;

    expect(agentIdOf("0")).toBe("0");
    expect(agentIdOf("42")).toBe("42");
    expect(agentIdOf(`1${"0".repeat(77)}`)).toBe(`1${"0".repeat(77)}`);

    for (const bad of [
      "00",
      "-1",
      "1e3",
      " 42",
      "42 ",
      "0x2a",
      "",
      `1${"0".repeat(78)}`,
      42,
      null,
    ]) {
      expect(agentIdOf(bad), String(bad)).toBeNull();
    }
  });

  test("an ownerChoice of another word reads null, and the two words read", () => {
    const choiceOf = (ownerChoice: unknown) =>
      parseLegalBodyMemory(JSON.stringify({ ...fullMemory(), ownerChoice }), TENANT)?.ownerChoice;

    expect(choiceOf("this-wallet")).toBe("this-wallet");
    expect(choiceOf("elsewhere")).toBe("elsewhere");
    for (const bad of ["another-wallet", "This-Wallet", "ELSEWHERE", "", 1, null]) {
      expect(choiceOf(bad), String(bad)).toBeNull();
    }
    // The rest of the memory does not depend on the field that failed.
    const raw = JSON.stringify(fullMemory({ ownerChoice: "another-wallet" as never }));
    expect(parseLegalBodyMemory(raw, TENANT)).toEqual(fullMemory({ ownerChoice: null }));
  });

  test("companyId and orderId outside the opaque handle shape read null", () => {
    const idsOf = (value: unknown) => {
      const memory = parseLegalBodyMemory(
        JSON.stringify({ ...fullMemory(), companyId: value, orderId: value }),
        TENANT,
      );
      return [memory?.companyId, memory?.orderId];
    };

    expect(idsOf("a")).toEqual(["a", "a"]);
    expect(idsOf("A-z_0-9")).toEqual(["A-z_0-9", "A-z_0-9"]);
    expect(idsOf("x".repeat(80))).toEqual(["x".repeat(80), "x".repeat(80)]);
    for (const bad of ["", "x".repeat(81), "a b", "a/b", "a.b", "café", 7, {}, null]) {
      expect(idsOf(bad), String(bad)).toEqual([null, null]);
    }
  });

  test("names off the allowlist in a stored blob are dropped on the way in", () => {
    const raw = JSON.stringify({ ...fullMemory(), ...TYPED_FIELDS });
    expect(parseLegalBodyMemory(raw, TENANT)).toEqual(fullMemory());
  });
});

describe("read, write and clear", () => {
  test("a memory survives a round trip through write and read", () => {
    const { storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const memory = fullMemory({ ownerChoice: "elsewhere" });

    writeLegalBodyMemory(memory);

    expect(readLegalBodyMemory(TENANT)).toEqual(memory);
    expect(readLegalBodyMemory(TENANT.toLowerCase() as `0x${string}`)).toEqual(memory);
    expect(readLegalBodyMemory(OTHER_TENANT)).toBeNull();
  });

  test("clear forgets the memory and leaves the wizard's key alone", () => {
    const { storage, map, touched } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    map.set(ONBOARDING_KEY, '{"phase":"welcome"}');

    writeLegalBodyMemory(fullMemory());
    clearLegalBodyMemory();

    expect(readLegalBodyMemory(TENANT)).toBeNull();
    expect(map.get(ONBOARDING_KEY)).toBe('{"phase":"welcome"}');
    expect(new Set(touched)).toEqual(new Set([LEGAL_BODY_STORAGE_KEY]));
  });

  test("read returns null when localStorage throws", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        getItem: () => {
          throw new Error("blocked");
        },
      }).storage,
    );
    expect(readLegalBodyMemory(TENANT)).toBeNull();
  });

  test("read returns null when reaching localStorage at all throws", () => {
    // A browser with site data blocked throws on the property itself, before any method call.
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    expect(readLegalBodyMemory(TENANT)).toBeNull();
    expect(() => writeLegalBodyMemory(fullMemory())).not.toThrow();
    expect(() => clearLegalBodyMemory()).not.toThrow();
  });

  test("with no store at all (a server render) read is null, and write and clear do nothing", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readLegalBodyMemory(TENANT)).toBeNull();
    expect(() => writeLegalBodyMemory(fullMemory())).not.toThrow();
    expect(() => clearLegalBodyMemory()).not.toThrow();
  });

  test("a store that refuses the write does not throw", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        setItem: () => {
          throw new Error("quota");
        },
      }).storage,
    );
    expect(() => writeLegalBodyMemory(fullMemory())).not.toThrow();
  });
});
