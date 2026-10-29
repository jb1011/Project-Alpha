import { Avatar, Style } from "@dicebear/core";
import voxelBot from "@dicebear/styles/voxel-bot.json";
import type { AgentMood } from "@/components/agents/persona";

/**
 * Voxel Bot by DiceBear, public domain (CC0).
 * The robot comes from the agent id, so a rename does not change who they are.
 * The eyes and mouth follow the status. The face blinks and lifts.
 * It stays still when reduced motion is requested.
 * Night Shift keeps the shell light on this dark page.
 */
const VOXEL_BOT = new Style(voxelBot);

const EYES = {
  ready: ["happy"],
  setting: ["round", "square", "visor"],
  attention: ["sleepy", "plus"],
} as const satisfies Record<AgentMood, readonly string[]>;

const MOUTH = {
  ready: ["smile"],
  setting: ["grill", "speaker", "line"],
  attention: ["zigzag", "line"],
} as const satisfies Record<AgentMood, readonly string[]>;

export function agentPortrait(seed: string, mood: AgentMood): string {
  return new Avatar(VOXEL_BOT, {
    seed,
    size: 128,
    scale: 1.2,
    borderRadius: 50,
    eyesVariant: EYES[mood],
    mouthVariant: MOUTH[mood],
    backgroundColor: ["141418"],
    bodyColor: ["e9ecef", "aeb8c2", "b6a6f5", "74c0fc"],
    screenColor: ["07070a"],
    glowColor: ["3bc9db", "69db7c", "ffd43b", "e599f7"],
    tags: ["animation"],
  }).toString();
}
