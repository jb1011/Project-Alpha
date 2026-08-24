/**
 * A POINTER. The wizard's PII allowlist guard lives in the interface package now.
 *
 * It used to live here and read `interface/src/lib/onboarding/storage.ts` as TEXT, because that
 * package had no test runner — the same workaround `proxyHeaders.test.ts` uses. A text guard can
 * assert that source LOOKS a certain way; it cannot call `buildPersistedOnboarding` and check that
 * a home address does not come out the other end, which is the only question worth asking. The
 * interface package has a runner now (`interface/vitest.config.ts`), so the real guard is
 * `interface/test/onboardingStorage.test.ts` and asserts by VALUE.
 *
 * What survives here is one line: that the real guard still exists. Two suites, one of which can
 * be deleted without the other noticing, is how a rule quietly stops being enforced.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const GUARD = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "interface",
  "test",
  "onboardingStorage.test.ts",
);

test("the wizard's PII persistence guard still exists, in the interface suite", () => {
  expect(existsSync(GUARD), `${GUARD} — run \`npm test\` in interface/ to execute it`).toBe(true);
});
