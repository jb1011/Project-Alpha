import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";

// vitest runs with cwd = backend/, so Foundry out/ is one level up.
const OUT = resolve(process.cwd(), "..", "out");

export function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(resolve(OUT, `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}
