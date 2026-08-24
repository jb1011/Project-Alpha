import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * A minimal test runner for this package — `src/lib` and pure component logic, nothing else.
 *
 * The interface package had no runner at all, and the consequence was not "less coverage": it was
 * that guards over interface code got written in the BACKEND suite, reading interface modules as
 * TEXT (`proxyHeaders.test.ts`, and until this commit an ABI drift guard and a PII allowlist
 * guard). A text guard can only assert that source looks a certain way. It cannot call
 * `buildPersistedOnboarding` and check that a home address does not come out the other end, and it
 * goes stale the moment somebody reformats the file it greps.
 *
 * Deliberately NOT a component runner: no jsdom, no testing-library, no render tree. Everything
 * worth asserting here is a pure function that a component calls — which is itself the constraint
 * that keeps the logic testable. `proxyHeaders.test.ts` stays in the backend suite, where the
 * thing it guards (a route that talks to the backend) actually lives.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // Mirrors the `@/*` path mapping in tsconfig.json — vitest does not read it.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
