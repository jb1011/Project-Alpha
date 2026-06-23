import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Anvil integration + live tests run serially to avoid port/nonce contention.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
