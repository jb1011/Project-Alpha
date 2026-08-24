/**
 * Drift guard over the wizard's localStorage ALLOWLIST (design §3, audit 16/L8).
 *
 * The onboarding wizard collects the legal name, email, phone and home address of a real person
 * and writes its state to `localStorage` on every keystroke-driven re-render. Those two facts must
 * never meet. The rule the design sets is structural rather than careful: persistence is an
 * allowlist, so a field nobody thought about is not persisted, instead of a denylist where a field
 * nobody thought about IS.
 *
 * This test is that rule, enforced from the suite that actually runs in CI — the interface package
 * has no test runner, so the guard reads the module as text, the idiom `proxyHeaders.test.ts`
 * established for exactly this situation.
 *
 * What it would catch: someone adding `party` to `PERSISTED_SESSION_KEYS` to "fix" a lost form on
 * reload; someone flattening the PII slice into `AgentConfig`, whose every key IS persisted;
 * someone reverting the allowlist to the old spread-and-null shape. All three are one-line changes
 * that leave the wizard working perfectly and put a person's home address in a browser store.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const interfaceFile = (...parts: string[]) =>
  join(import.meta.dirname, "..", "..", "..", "..", "interface", "src", ...parts);

const STORAGE = interfaceFile("lib", "onboarding", "storage.ts");
const WIZARD_TYPES = interfaceFile("components", "onboarding", "types.ts");
const FLOW = interfaceFile("components", "onboarding", "OnboardingFlow.tsx");

/** Every field of `FormationParty`. None of them may be persisted, now or ever. */
const PII_FIELDS = [
  "legalFirstName",
  "legalLastName",
  "email",
  "phone",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "country",
] as const;

const storage = () => readFileSync(STORAGE, "utf8");

/** Block and line comments out, so a guard about CODE is not a guard about prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function parseAllowlist(name: string): string[] {
  const source = storage();
  const start = source.indexOf(`export const ${name} = [`);
  expect(start, `${name} must exist in ${STORAGE}`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("] as const", start));
  return [...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1] ?? "");
}

test("the wizard's storage and PII modules are where this guard expects them", () => {
  // If these fail the modules moved, and every assertion below would silently pass.
  for (const path of [STORAGE, WIZARD_TYPES, FLOW]) expect(existsSync(path), path).toBe(true);
});

test("persistence is an ALLOWLIST, not a spread with fields nulled on the way out", () => {
  const source = storage();
  expect(source).toContain("PERSISTED_CONFIG_KEYS");
  expect(source).toContain("PERSISTED_SESSION_KEYS");
  // The builder is the one path from wizard state to bytes; without it the allowlists are
  // decoration and some caller is still serializing the whole object.
  expect(source).toContain("export function buildPersistedOnboarding");
  expect(parseAllowlist("PERSISTED_CONFIG_KEYS").length).toBeGreaterThan(0);
  expect(parseAllowlist("PERSISTED_SESSION_KEYS").length).toBeGreaterThan(0);
});

test("NO personal data field appears in either allowlist", () => {
  const persisted = new Set([
    ...parseAllowlist("PERSISTED_CONFIG_KEYS"),
    ...parseAllowlist("PERSISTED_SESSION_KEYS"),
  ]);
  for (const field of PII_FIELDS) expect([...persisted], field).not.toContain(field);
});

test("no personal data field is NAMED in the storage module's CODE", () => {
  // Stronger than the allowlist check and deliberately so: a `party.email` reached from inside
  // `buildPersistedOnboarding` would satisfy the allowlists and still write the address out.
  //
  // Comments are stripped first: the module's own documentation explains WHY a name, email, phone
  // and address must never be written here, and a guard that forbade saying so would make the
  // file's most important paragraph unwriteable.
  const code = stripComments(storage());
  for (const field of PII_FIELDS) expect(code, field).not.toContain(field);
  expect(code, "the PII slice type must not be reachable from here").not.toContain(
    "FormationParty",
  );
});

test("only the OPAQUE formation handle survives a reload", () => {
  const session = parseAllowlist("PERSISTED_SESSION_KEYS");
  // A handle identifies a row, not a person — this is what makes a resumed wizard possible at all
  // without keeping the identity.
  expect(session).toContain("partyId");
  expect(session).toContain("partySynthetic");
  // The passkey precedent, unchanged: a single-use credential is re-obtained, never replayed.
  expect(session).not.toContain("guardianPasskey");
});

test("the PII slice is its own type with its own validator, beside AgentConfig", () => {
  const types = readFileSync(WIZARD_TYPES, "utf8");
  expect(types).toContain("export type FormationParty");
  expect(types).toContain("export function validateParty");
  // The separation that matters: AgentConfig is what gets persisted AND what becomes the
  // AgentSpec, so a PII field declared on it would follow it into both. Its literal must not
  // name any of them.
  const configType = types.slice(
    types.indexOf("export type AgentConfig = {"),
    types.indexOf("export type OnboardingSession"),
  );
  expect(configType.length).toBeGreaterThan(0);
  for (const field of PII_FIELDS) expect(configType, field).not.toContain(field);
});

test("the flow persists through the builder and clears the slice once a handle exists", () => {
  const flow = readFileSync(FLOW, "utf8");
  expect(flow).toContain("buildPersistedOnboarding({ phase, config, done, session })");
  // A raw JSON.stringify of wizard state anywhere in the flow is the shape this guard exists to
  // prevent; the only setItem call must be the builder's output.
  expect(flow).not.toMatch(/JSON\.stringify\(\s*\{\s*phase/);
  // Belt and braces on top of the allowlist: the identity leaves memory as soon as the backend
  // holds it.
  expect(flow).toContain("setParty(emptyParty())");
});
