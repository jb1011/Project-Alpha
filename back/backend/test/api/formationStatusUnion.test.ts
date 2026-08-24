/**
 * Drift guard: the interface's `FormationStatus` against this backend's (design §5/§8).
 *
 * `deriveFormationStatus` in `src/formation/status.ts` is the only thing that decides what a
 * formation's status IS, and the value travels over the wire into a switch in the interface's
 * formation card — the card that tells an owner whether their company legally exists. The two
 * declarations are in separate packages, deployed separately, and nothing in either compiler ties
 * them together: add a sixth state here and the interface still builds, still renders, and simply
 * has no branch for it.
 *
 * The card carries a `default` branch for the deploy window ("Unknown state — contact the
 * operator", in the unconfirmed colour), and this test is what closes the window: adding a state
 * here fails CI until the interface's list names it too.
 *
 * Text-parsed rather than imported, like `proxyHeaders.test.ts`: the interface package has its own
 * tsconfig and module resolution. The interface side is a runtime `as const` array precisely so
 * this guard has something unambiguous to read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type FormationStatus, deriveFormationStatus } from "../../src/formation/status";

const INTERFACE_TYPES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "interface",
  "src",
  "lib",
  "api",
  "types.ts",
);

/**
 * This backend's union, written out ONCE as an exhaustive record.
 *
 * A `Record<FormationStatus, true>` cannot be short a key: removing or renaming a member of
 * `FormationStatus` fails to compile here, and adding one does too. That is the half of the guard
 * TypeScript can enforce; the other half is the interface's list, below.
 */
const BACKEND_STATUSES: Record<FormationStatus, true> = {
  none: true,
  in_progress: true,
  filed: true,
  complete: true,
  failed: true,
};

function interfaceStatuses(): string[] {
  const source = readFileSync(INTERFACE_TYPES, "utf8");
  const start = source.indexOf("export const FORMATION_STATUSES = [");
  expect(start, `FORMATION_STATUSES must exist in ${INTERFACE_TYPES}`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("] as const", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "");
}

test("the interface's formation types module is where this guard expects it", () => {
  // If this fails the module moved, and the assertions below would silently pass.
  expect(existsSync(INTERFACE_TYPES), INTERFACE_TYPES).toBe(true);
});

test("G5: the interface's FormationStatus union matches this backend's, exactly", () => {
  expect([...interfaceStatuses()].sort()).toEqual(Object.keys(BACKEND_STATUSES).sort());
});

test("G5: every status this backend can DERIVE is one the interface knows", () => {
  // The union is a declaration; this is the behaviour. `deriveFormationStatus` over the empty
  // sub-saga is the one case reachable without fixtures, and it must still land inside the list —
  // a status the interface has never heard of renders as "Unknown state" on a legal surface.
  const known = new Set(interfaceStatuses());
  expect(known.has(deriveFormationStatus([]))).toBe(true);
});
