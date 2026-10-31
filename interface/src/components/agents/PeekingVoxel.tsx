"use client";

import { useEffect, useRef, useState, type AnimationEvent } from "react";
import { peekVoxelSvg } from "@/components/agents/voxelBots";

const svg = peekVoxelSvg();

/** Spots along the top of the card. Each visit skips the one just used. */
const SPOTS = [18, 36, 72, 54, 86, 28];

const FIRST_WAIT_MS = 800;
const AWAY_MS = 3400;

/** Face only, over the top edge of the sign in card. It does not take clicks. */
export function PeekingVoxel() {
  const [spot, setSpot] = useState(0);
  const [up, setUp] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setUp(true);
      return;
    }
    timer.current = window.setTimeout(() => setUp(true), FIRST_WAIT_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  function onRiseEnd(event: AnimationEvent<HTMLDivElement>) {
    if (event.animationName !== "voxel-peek-rise") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setUp(false);
    timer.current = window.setTimeout(() => {
      setSpot((current) => {
        const hop = 1 + Math.floor(Math.random() * (SPOTS.length - 1));
        return (current + hop) % SPOTS.length;
      });
      setUp(true);
    }, AWAY_MS);
  }

  if (!up) return null;

  return (
    <div className="voxel-peek" style={{ left: `${SPOTS[spot]}%` }} aria-hidden>
      <div className="voxel-peek-bot" onAnimationEnd={onRiseEnd}>
        <span className="voxel-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  );
}
