import { expect, test } from "vitest";
import { walkingVoxelSvg } from "@/components/agents/walkingVoxel";

test("the walker splits feet and legs out of the voxel bot", () => {
  const svg = walkingVoxelSvg();
  expect(svg).toContain('class="voxel-leg voxel-leg-l"');
  expect(svg).toContain('class="voxel-leg voxel-leg-r"');
  expect(svg).toContain('class="voxel-body"');
  expect(svg).toContain('class="vb-upper"');
  expect(svg).not.toMatch(/<rect width="128" height="128" fill=/);
  expect(svg).not.toContain("clip-path");

  let depth = 0;
  for (const tag of svg.matchAll(/<g\b|<\/g>/g)) {
    depth += tag[0] === "</g>" ? -1 : 1;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
});
