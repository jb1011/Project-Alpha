/**
 * The case row's mode and the config's mode are declared twice (src/pilot/types.ts imports nothing,
 * by design). This file makes `npm run typecheck` fail if the two drift in either direction.
 */
import { expect, test } from "vitest";
import type { PilotKlerosMode } from "../../src/config/env";
import type { PilotMode } from "../../src/pilot/types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

// A compile-time check: assigning true fails typecheck unless the two unions are identical.
const sameModes: Equal<PilotMode, PilotKlerosMode> = true;

test("PilotMode and PilotKlerosMode are the same union (checked by typecheck)", () => {
  expect(sameModes).toBe(true);
});
