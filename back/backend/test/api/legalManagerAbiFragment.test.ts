/**
 * Drift guard over the interface's hand-written LegalManager ABI fragment (design §8, audit H4).
 *
 * The guardian veto card decodes `AmendmentScheduled` logs and calls `cancelOperatingAgreementUpdate`
 * with a fragment written by hand in `interface/src/lib/legalManagerAbi.ts` — because it must read
 * the chain itself rather than trust a hash this backend handed it. A hand-written fragment is a
 * COPY, and a copy of an ABI is a copy that can go stale: change an argument type in the contract
 * and the card keeps compiling, keeps rendering, and quietly encodes calldata the contract will
 * reject — or, worse, decodes a log field into the wrong variable and shows the guardian a hash
 * that is not the one being scheduled.
 *
 * The interface package has no test runner, so the guard lives here, in the suite that runs in CI,
 * reading the fragment as TEXT — exactly the idiom `proxyHeaders.test.ts` established.
 *
 * What it compares: every entry in the fragment against the SAME entry in the generated ABI, on
 * name, kind, argument types, output types, indexed-ness and state mutability. Cosmetic
 * differences the fragment is allowed to have (no `internalType`, no `anonymous`) are normalized
 * away rather than asserted on.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { legalManagerAbi } from "../../src/abis/generated";

const FRAGMENT = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "interface",
  "src",
  "lib",
  "legalManagerAbi.ts",
);

/** The five reads/writes and four events the veto card cannot work without. */
const REQUIRED = [
  "scheduledAt",
  "vetoed",
  "cancelOperatingAgreementUpdate",
  "liftVeto",
  "meta",
  "AmendmentScheduled",
  "AmendmentVetoed",
  "VetoLifted",
  "OperatingAgreementUpdated",
] as const;

type AbiParam = { name?: string; type: string; indexed?: boolean };
type AbiEntry = {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
};

/**
 * Parse the fragment out of the TypeScript source.
 *
 * Importing it is not possible from here (the interface package has its own tsconfig and module
 * resolution — the same reason the proxy-header guard parses rather than imports). The literal is
 * plain JSON once `as const` and the comments are stripped, and a parse failure is itself a
 * finding: a fragment this guard cannot read is a fragment nobody is checking.
 */
function parseFragment(): AbiEntry[] {
  const source = readFileSync(FRAGMENT, "utf8");
  const start = source.indexOf("export const legalManagerAbi = [");
  expect(start, "export const legalManagerAbi = [ … ] as const;").toBeGreaterThan(-1);
  const arrayStart = source.indexOf("[", start);
  const end = source.indexOf("] as const;", arrayStart);
  expect(end, "the fragment must end with `] as const;`").toBeGreaterThan(arrayStart);
  const body = source
    .slice(arrayStart, end + 1)
    // Line comments inside the literal (there are none today, but a future editor may add one).
    .replace(/^\s*\/\/.*$/gm, "")
    // Quote the object keys and drop trailing commas, so the TS literal becomes JSON.
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(body) as AbiEntry[];
}

/** Everything that changes CALLDATA or DECODING, and nothing that doesn't. */
function signatureOf(entry: AbiEntry): string {
  const params = (ps: AbiParam[] | undefined) =>
    (ps ?? []).map((p) => `${p.type}${p.indexed ? " indexed" : ""}`).join(",");
  return [
    entry.type,
    entry.name ?? "",
    `(${params(entry.inputs)})`,
    `->(${params(entry.outputs)})`,
    // Events have none; functions must agree, or a `view` the card calls as a write (or the
    // reverse) fails at runtime only.
    entry.stateMutability ?? "",
  ].join(" ");
}

test("the interface's LegalManager fragment is where this guard expects it", () => {
  // If this fails the module was moved or renamed, and everything below would silently pass.
  expect(existsSync(FRAGMENT), FRAGMENT).toBe(true);
});

test("every entry in the hand-written fragment matches the generated ABI exactly", () => {
  const fragment = parseFragment();
  expect(fragment.length).toBeGreaterThan(0);

  const generated = new Map(
    (legalManagerAbi as readonly AbiEntry[])
      .filter((e) => e.name)
      .map((e) => [`${e.type}:${e.name}`, e]),
  );

  for (const entry of fragment) {
    const key = `${entry.type}:${entry.name}`;
    const twin = generated.get(key);
    expect(twin, `${key} is not in the generated LegalManager ABI at all`).toBeDefined();
    expect(signatureOf(entry), key).toBe(signatureOf(twin as AbiEntry));
  }
});

test("the fragment still carries every entry the guardian veto card needs", () => {
  // The other direction: a fragment can go stale by LOSING an entry as easily as by changing one,
  // and a card that cannot read `scheduledAt` cannot tell a live amendment from an executed one.
  const names = new Set(parseFragment().map((e) => e.name));
  for (const required of REQUIRED) expect(names, required).toContain(required);
});

test("the fragment stays a FRAGMENT — it is not the whole contract pasted in", () => {
  // Not style policing: the point of a hand-written fragment is that a human read every line of
  // it. A 50-entry paste is a paste, and nobody re-reads one.
  const fragment = parseFragment();
  expect(fragment.length).toBeLessThan(legalManagerAbi.length / 2);
});

test("the veto path is a GUARDIAN write, and the state reads are views", () => {
  // Encodes the contract's actual shape, so a fragment that quietly turned `scheduledAt` into a
  // non-view (or the veto into a view) is caught here rather than in a wallet.
  const byName = new Map(parseFragment().map((e) => [e.name, e]));
  expect(byName.get("scheduledAt")?.stateMutability).toBe("view");
  expect(byName.get("vetoed")?.stateMutability).toBe("view");
  expect(byName.get("meta")?.stateMutability).toBe("view");
  expect(byName.get("cancelOperatingAgreementUpdate")?.stateMutability).toBe("nonpayable");
  expect(byName.get("liftVeto")?.stateMutability).toBe("nonpayable");
});
