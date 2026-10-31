import { expect, test } from "vitest";
import { peekVoxelSvg } from "@/components/agents/voxelBots";

test("the peeker wraps the head, eyes, and smile", () => {
  const svg = peekVoxelSvg();
  expect(svg).toContain('class="voxel-peek-head"');
  expect(svg).toContain('class="voxel-eyes"');
  expect(svg).toContain('class="voxel-smile"');
  expect(svg).toContain('href="#mouth-smile-');
  expect(svg).not.toMatch(/<rect width="128" height="128" fill=/);

  let depth = 0;
  for (const tag of svg.matchAll(/<g\b|<\/g>/g)) {
    depth += tag[0] === "</g>" ? -1 : 1;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
});
