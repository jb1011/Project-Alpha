/**
 * FRESHNESS guard over the generated LegalManager fragment the guardian veto card reads with
 * (design §8, audit H4).
 *
 * The fragment in `interface/src/lib/legalManagerAbi.ts` is no longer hand-written: it is emitted
 * by `scripts/gen-abis.mts` from the same forge artifacts as `src/abis/generated.ts`. So the
 * question this file asks is no longer "has the copy drifted?" but "was it regenerated?" — which
 * is the whole diff, not a list of properties somebody remembered to compare.
 *
 * What a stale fragment costs: change an argument type in the contract and the card keeps
 * compiling, keeps rendering, and quietly encodes calldata the contract will reject — or, worse,
 * decodes a log field into the wrong variable and shows the guardian a hash that is not the one
 * being scheduled. That is a veto landing on nothing, which is the exact failure the card exists
 * to prevent.
 *
 * Regenerating from `src/abis/generated.ts` rather than from `../out` on purpose: the generated
 * module is committed, so this runs in CI without a forge build, and the two files are then
 * guaranteed to have come from the same artifact.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { legalManagerAbi } from "../../src/abis/generated";
import {
  LEGAL_MANAGER_FRAGMENT_MEMBERS,
  renderLegalManagerFragment,
} from "../../src/abis/interfaceFragment";

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

test("the interface's LegalManager fragment is where the generator writes it", () => {
  // If this fails the module was moved or renamed, and everything below would silently pass.
  expect(existsSync(FRAGMENT), FRAGMENT).toBe(true);
});

test("G7: the generated fragment on disk is up to date with the contract ABI", () => {
  expect(
    readFileSync(FRAGMENT, "utf8"),
    "interface/src/lib/legalManagerAbi.ts is stale — run `npm run gen:abis` in back/backend",
  ).toBe(renderLegalManagerFragment(legalManagerAbi as readonly unknown[]));
});

test("G7: every member the veto card needs is in the allowlist, and in the ABI", () => {
  // The allowlist is the deliberate act; this asserts it still names what the card calls, and that
  // the contract still has all of it. A fragment silently short of `scheduledAt` is a card that
  // cannot tell a live amendment from an executed one.
  for (const required of [
    "scheduledAt",
    "vetoed",
    "cancelOperatingAgreementUpdate",
    "liftVeto",
    "meta",
    "AmendmentScheduled",
  ]) {
    expect(LEGAL_MANAGER_FRAGMENT_MEMBERS as readonly string[], required).toContain(required);
  }
  const names = new Set(
    (legalManagerAbi as readonly { name?: string }[]).map((e) => e.name).filter(Boolean),
  );
  for (const member of LEGAL_MANAGER_FRAGMENT_MEMBERS) expect(names, member).toContain(member);
});

test("G7: it stays a FRAGMENT — not the whole contract pasted in", () => {
  // Not style policing: the point of a small fragment is that a human read every line of it, and
  // nobody re-reads a 50-entry paste. Growing it is a decision, not a default.
  expect(LEGAL_MANAGER_FRAGMENT_MEMBERS.length).toBeLessThan(legalManagerAbi.length / 2);
});

test("G7: the generator refuses to emit a fragment missing a member it promised", () => {
  // Fail loudly at generation rather than emit a short fragment that compiles.
  const withoutScheduledAt = (legalManagerAbi as readonly { name?: string }[]).filter(
    (e) => e.name !== "scheduledAt",
  );
  expect(() => renderLegalManagerFragment(withoutScheduledAt)).toThrow(/scheduledAt/);
});
