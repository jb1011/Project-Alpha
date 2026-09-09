import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * A minimal test runner for this package — `src/lib` and pure component logic, nothing else.
 *
 * The interface package had no runner at all, and the consequence was not "less coverage": it was
 * that guards over interface code got written in the BACKEND suite, reading interface modules as
 * TEXT (an ABI drift guard, a PII allowlist guard, and the proxy's route predicates). A text
 * guard can only assert that source looks a certain way. It cannot call
 * `buildPersistedOnboarding` and check that a home address does not come out the other end, and it
 * goes stale the moment somebody reformats the file it greps.
 *
 * `proxyHeaders.test.ts` now lives HERE and IMPORTS the predicates rather than scraping them.
 * The backend's copy used to extract each regex literal with a regex of its own, whose failure
 * mode is that the extractor stops matching and the guard passes vacuously; what remains over
 * there is the cross-package claim only that side can make — that the module and the route file
 * are still where the backend expects them, and that the allowlists still name, and still do not
 * name, specific headers.
 *
 * Deliberately NOT a component runner: no jsdom, no testing-library, no render tree. Everything
 * worth asserting here is a pure function that a component calls — which is itself the constraint
 * that keeps the logic testable, and the constraint that turned three inline UI decisions
 * (`legalBodyBranch`, `resumePhase`, `companyPill`) into functions with tests.
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
