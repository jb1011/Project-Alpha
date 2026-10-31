import { Avatar, Style } from "@dicebear/core";
import voxelBot from "@dicebear/styles/voxel-bot.json";

/**
 * Voxel Bot by DiceBear, public domain (CC0).
 * The robot peeks over the sign in card. Eyes and mouth are wrapped so it
 * can smile and look around. The shell stays light on this dark page.
 */
const VOXEL_BOT = new Style(voxelBot);

const FRAME = {
  size: 128,
  scale: 1,
  backgroundColor: ["090909"],
  screenColor: ["07070a"],
  tags: ["animation"],
} as const;

export function peekVoxelSvg(): string {
  const svg = stripFrame(
    new Avatar(VOXEL_BOT, {
      ...FRAME,
      seed: "peek",
      eyesVariant: ["happy"],
      mouthVariant: ["smile"],
      bodyColor: ["f4efe6"],
      accentColor: ["8d8378"],
      glowColor: ["ffd43b"],
    }).toString(),
  )
    .replace(
      /<use transform="([^"]+)" href="(#eyes-[^"]+)"\/>/,
      '<g class="voxel-eyes"><use transform="$1" href="$2"/></g>',
    )
    .replace(
      /<use transform="([^"]+)" href="(#mouth-[^"]+)"\/>/,
      '<g class="voxel-smile"><use transform="$1" href="$2"/></g>',
    );

  return wrapGroup(svg, '<g class="vb-head">', "voxel-peek-head");
}

function stripFrame(raw: string): string {
  return raw
    .replace(/<rect width="128" height="128" fill="#[0-9a-fA-F]{6}"\/>/, "")
    .replace(/<clipPath id="clip-[^"]+"><rect width="128" height="128"[^/]*\/><\/clipPath>/, "")
    .replace(/ clip-path="url\(#[^"]+\)"/, "")
    .replace('width="128" height="128"', 'width="100%" height="100%"');
}

function wrapGroup(svg: string, openTag: string, className: string): string {
  const start = svg.indexOf(openTag);
  if (start < 0) return svg;

  let depth = 0;
  let i = start;
  while (i < svg.length) {
    const nextOpen = svg.indexOf("<g", i);
    const nextClose = svg.indexOf("</g>", i);
    if (nextClose < 0) return svg;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 2;
      continue;
    }
    depth -= 1;
    i = nextClose + "</g>".length;
    if (depth === 0) {
      return `${svg.slice(0, start)}<g class="${className}">${svg.slice(start, i)}</g>${svg.slice(i)}`;
    }
  }
  return svg;
}
