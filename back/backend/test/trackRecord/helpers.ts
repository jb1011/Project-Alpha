import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex, decodeFunctionResult } from "viem";
import {
  type ReadAllFeedbackResult,
  reputationReadAbi,
} from "../../src/trackRecord/reputationRead";

/**
 * Real answers captured on 2026-10-28: the registry's `readAllFeedback` for the provider's test
 * agent (one post) and for agent 895447 (two job entries, nothing from the provider), the
 * identity metadata naming the locking wallet, one explorer log, and three record answers.
 */
const FIXTURES = join(__dirname, "fixtures");

export const POSTER = "0xBBf3f7a2ede8e1fc7B380e7C536666043fCDa5e7" as const;
export const TAG1 = "accuracy";
export const TAG2 = "aevum-market-call";
export const REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;
export const LOCKING_WALLET = "0x33F283b1d6e9a12b0F79289C75617E6c0f56Aff8" as const;
export const PROVIDER_HOST = "app.aevumprotocol.io";

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export function fixtureHex(name: string): Hex {
  return fixtureText(name).trim() as Hex;
}

export function feedbackFixture(name: string): ReadAllFeedbackResult {
  return decodeFunctionResult({
    abi: reputationReadAbi,
    functionName: "readAllFeedback",
    data: fixtureHex(name),
  }) as ReadAllFeedbackResult;
}
