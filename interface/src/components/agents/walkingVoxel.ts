import { Avatar, Style } from "@dicebear/core";
import voxelBot from "@dicebear/styles/voxel-bot.json";

/**
 * Voxel Bot by DiceBear, public domain (CC0).
 * One fixed robot for the sign in floor. Feet and legs are grouped so they
 * can step. The face still blinks. The shell stays light on this dark page.
 */
const VOXEL_BOT = new Style(voxelBot);

/** Shadow, then each foot (3 paths), then each leg (3 paths). DiceBear draws these in that order. */
const BODY_PATHS = 13;

export function walkingVoxelSvg(): string {
  const raw = new Avatar(VOXEL_BOT, {
    seed: "novi",
    size: 128,
    scale: 1,
    eyesVariant: ["happy"],
    mouthVariant: ["smile"],
    backgroundColor: ["090909"],
    bodyColor: ["e9ecef"],
    accentColor: ["7d8fa3"],
    screenColor: ["07070a"],
    glowColor: ["93c5fd"],
    tags: ["animation"],
  }).toString();

  const svg = raw
    .replace(/<rect width="128" height="128" fill="#[0-9a-fA-F]{6}"\/>/, "")
    .replace(/<clipPath id="clip-[^"]+"><rect width="128" height="128"[^/]*\/><\/clipPath>/, "")
    .replace(/ clip-path="url\(#[^"]+\)"/, "")
    .replace('width="128" height="128"', 'width="100%" height="100%"');

  return groupLimbs(svg);
}

function groupLimbs(svg: string): string {
  const defsEnd = svg.indexOf("</defs>");
  const upperAt = svg.indexOf('<g class="vb-upper">');
  if (defsEnd < 0 || upperAt < 0) return svg;

  const start = defsEnd + "</defs>".length;
  const region = svg.slice(start, upperAt);
  const matches = [...region.matchAll(/<path\b[^]*?\/>/g)];
  if (matches.length !== BODY_PATHS || matches[0].index === undefined) return svg;

  const paths = matches.map((match) => match[0]);
  const last = matches[matches.length - 1];
  const regionEnd = (last.index ?? 0) + last[0].length;
  const grouped =
    `<g class="voxel-shadow">${paths[0]}</g>` +
    `<g class="voxel-leg voxel-leg-l">${paths.slice(1, 4).join("")}${paths.slice(7, 10).join("")}</g>` +
    `<g class="voxel-leg voxel-leg-r">${paths.slice(4, 7).join("")}${paths.slice(10, 13).join("")}</g>`;

  const next =
    svg.slice(0, start) +
    region.slice(0, matches[0].index) +
    grouped +
    region.slice(regionEnd) +
    svg.slice(upperAt);

  return wrapGroup(next, '<g class="vb-upper">', "voxel-body");
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
