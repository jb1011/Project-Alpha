"use client";

import { walkingVoxelSvg } from "@/components/agents/walkingVoxel";

const svg = walkingVoxelSvg();

/** Decorative walker on the sign in floor. It does not take clicks. */
export function WalkingVoxel() {
  return (
    <div className="voxel-track" aria-hidden>
      <div className="voxel-ground" />
      <div className="voxel-pace">
        <div className="voxel-face">
          <span className="voxel-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
    </div>
  );
}
