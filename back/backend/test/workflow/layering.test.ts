/**
 * M1: the workflow layer must not import from the API layer.
 *
 * The sweeper is a TIMER. It has no request, no response and no caller, and for a while it read
 * its "is this entity still in flight?" verdict out of `api/views.ts` — a projection written for
 * HTTP responses. That inversion had two costs: the import graph
 * (views → processor → receiver → app → views) was one edit away from a genuine cycle, and the
 * domain rule that decides whether a formation is finished lived in the module least likely to be
 * consulted about it.
 *
 * The rule is mechanical, so the guard is too.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const WORKFLOW_DIR = join(import.meta.dirname, "..", "..", "src", "workflow");

function workflowSources(): { name: string; source: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((name) => ({ name, source: readFileSync(join(WORKFLOW_DIR, name), "utf8") }));
}

test("M1: no module in src/workflow imports from src/api", () => {
  const files = workflowSources();
  // If this is ever zero the guard has quietly stopped guarding anything.
  expect(files.length).toBeGreaterThan(0);
  for (const { name, source } of files) {
    expect(source, `${name} imports from ../api`).not.toMatch(/from\s+"\.\.\/api/);
    expect(source, `${name} re-exports from ../api`).not.toMatch(/export\s+.*\s+from\s+"\.\.\/api/);
  }
});

test("M1: the formation status projection is the domain module's, and everyone reads that one", () => {
  const root = join(import.meta.dirname, "..", "..", "src");
  const status = readFileSync(join(root, "formation", "status.ts"), "utf8");
  expect(status).toContain("export function deriveFormationStatus");
  expect(status).toContain("export function formationSummary");

  // Every surface that renders formation, plus the sweeper, reads the ONE derivation.
  for (const rel of [
    ["api", "views.ts"],
    ["api", "routes", "metadata.ts"],
    ["api", "routes", "transparency.ts"],
    ["workflow", "formationSweeper.ts"],
  ]) {
    const source = readFileSync(join(root, ...rel), "utf8");
    expect(source, rel.join("/")).toMatch(/from\s+"\.{1,2}(\/\.\.)*\/formation\/status"/);
  }

  // …and nobody keeps a second copy of it.
  for (const rel of [
    ["api", "views.ts"],
    ["api", "routes", "metadata.ts"],
    ["api", "routes", "transparency.ts"],
    ["workflow", "formationSweeper.ts"],
  ]) {
    const source = readFileSync(join(root, ...rel), "utf8");
    expect(source, rel.join("/")).not.toContain("export function deriveFormationStatus");
  }
});
