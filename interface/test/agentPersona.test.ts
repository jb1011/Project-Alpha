import { expect, test } from "vitest";
import type { EntityStatus } from "@/lib/api/types";
import { agentMood, agentMoodLabel } from "@/components/agents/persona";
import { agentPortrait } from "@/components/agents/portrait";

const SETTING: EntityStatus[] = ["pending", "provisioned", "translating", "created"];

test("a finished agent is ready, a failed one needs a look, the rest are still setting up", () => {
  expect(agentMood("bound")).toBe("ready");
  expect(agentMood("funded")).toBe("ready");
  expect(agentMood("failed")).toBe("attention");
  for (const status of SETTING) expect(agentMood(status)).toBe("setting");
});

test("the words stay plain", () => {
  expect(agentMoodLabel("ready")).toBe("Ready");
  expect(agentMoodLabel("setting")).toBe("Setting up");
  expect(agentMoodLabel("attention")).toBe("Needs attention");
});

test("the same agent keeps the same face, and a failed one does not smile", () => {
  const ready = agentPortrait("entity-harbor", "ready");
  expect(agentPortrait("entity-harbor", "ready")).toBe(ready);
  expect(agentPortrait("entity-keel", "ready")).not.toBe(ready);
  expect(agentPortrait("entity-harbor", "attention")).not.toBe(ready);
});
