/**
 * The wake-up-only invariant, enforced against the SOURCE (design §5, audit H2).
 *
 * The behavioural proof lives in `formationProcessor.test.ts` — the payload lies and the database
 * believes doola's API instead. This file is the structural half: a grep that fails the build if
 * anyone ever reaches into `eventPayload` from anywhere except the two receiver helpers whose job
 * is to extract the company id.
 *
 * It is worth having both. The behavioural test proves today's code is right; this one makes the
 * rule visible at the moment someone is about to break it, which is the only time it matters.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..", "..", "src");

/**
 * Strip comments before grepping.
 *
 * Prose is allowed — indeed required — to name the rule it is explaining, and a guard that fired
 * on a doc-comment would push authors to explain the invariant LESS. What the guard is about is
 * CODE that reads the field.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

/**
 * The ONLY two functions permitted to read `eventPayload`, both in the receiver: `providerRefOf`
 * pulls the company id out of it, and `parseEnvelope` hands it to that function. Everything
 * downstream receives ids and re-fetches facts.
 */
const PERMITTED_READERS = ["providerRefOf", "parseEnvelope"];

test("nothing outside the receiver's two extractors reads `eventPayload`", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = codeOnly(readFileSync(file, "utf8"));
    if (!text.includes("eventPayload")) continue;
    // The receiver is the one module that may see the field at all.
    if (file.endsWith(join("api", "routes", "doolaWebhook.ts"))) continue;
    offenders.push(file.slice(SRC.length + 1));
  }
  expect(
    offenders,
    "a webhook is a WAKE-UP SIGNAL, never a source of facts (design §5, audit H2): re-fetch the fact from doola's API instead of reading it out of the envelope",
  ).toEqual([]);
});

test("inside the receiver, `eventPayload` is only ever read by the two extractors", () => {
  const file = join(SRC, "api", "routes", "doolaWebhook.ts");
  const raw = readFileSync(file, "utf8");
  // The two permitted extractors, cut out of the file. Whatever mentions of the field remain
  // afterwards are, by definition, reads from somewhere else.
  const extractors = PERMITTED_READERS.map((fn) => {
    const start = raw.indexOf(`export function ${fn}`);
    expect(start, `${fn} has been renamed — this guard would silently pass`).toBeGreaterThan(-1);
    // Up to the next top-level declaration, which is close enough to a function body for a grep.
    const rest = raw.slice(start + 1);
    const end = rest.indexOf("\nexport ");
    return rest.slice(0, end === -1 ? undefined : end);
  });

  let remaining = codeOnly(raw);
  for (const body of extractors) remaining = remaining.replace(codeOnly(body), "");
  const leaks = remaining
    .split("\n")
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => l.includes("eventPayload"));
  expect(
    leaks.map((x) => x.l.trim()),
    "only providerRefOf and parseEnvelope may touch eventPayload",
  ).toEqual([]);
  // Both permitted readers still exist — a rename must not silently empty this guard.
  for (const fn of PERMITTED_READERS) expect(raw).toContain(`export function ${fn}`);
});

test("the wake-up handed to the processor carries ids ONLY — the type says so", () => {
  // Declared by the PROCESSOR since M1: it is the consumer, and `src/workflow` may not import
  // from `src/api`. The receiver re-exports it for its own callers.
  const text = codeOnly(readFileSync(join(SRC, "workflow", "formationProcessor.ts"), "utf8"));
  const iface = text.slice(text.indexOf("export interface DoolaWakeUp"));
  const body = iface.slice(0, iface.indexOf("}"));
  // Three fields, and none of them is a fact about a legal entity.
  expect(body).toContain("eventId");
  expect(body).toContain("eventName");
  expect(body).toContain("providerRef");
  for (const fact of ["ein", "filing", "payload", "date"])
    expect(body.toLowerCase(), fact).not.toContain(fact);
});

test("the processor re-fetches: every fact it writes comes from a DoolaApi call", () => {
  const text = codeOnly(readFileSync(join(SRC, "workflow", "formationProcessor.ts"), "utf8"));
  // The three authoritative reads, and no route from the wire to a write.
  for (const call of [
    "d.doola.getCompany(",
    "d.doola.listDocuments(",
    "d.doola.listRequiredActions(",
  ])
    expect(text).toContain(call);
  expect(text).not.toContain("eventPayload");
  // `wake` is destructured for ids only — never spread into anything persisted.
  expect(text).not.toMatch(/\.\.\.wake\b/);
});
