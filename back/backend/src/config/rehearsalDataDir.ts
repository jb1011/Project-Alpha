import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATA_DIR } from "./env";

/** Scratch store the Tier-0 P3 rehearsal writes to, kept apart from the live one. Its own
 *  variable: no service reads REHEARSAL_DATA_DIR, so nothing outside the rehearsal script can be
 *  redirected by setting it, and a template-derived `.env` (which always carries `DATA_DIR`) can
 *  never make the rehearsal throw on every run. */
export const REHEARSAL_DATA_DIR = "./data-p3";

/** Absolute path of back/backend, derived from this module's own location, never from cwd. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Real path of the nearest existing ancestor, with the missing tail re-appended. Both inputs and
 *  outputs are absolute. A plain `realpathSync` fallback to the lexical path for a not-yet-created
 *  directory would let a rehearsal dir that does not exist yet escape the containment check below
 *  whenever the live dir is reached through a symlink (or, on macOS, whenever tmpdir() itself is
 *  one) — the candidate would carry the symlink's lexical prefix while the live root carries its
 *  resolved one, and the two would never share a prefix even though they are the same tree. */
function realish(absolutePath: string): string {
  const missing: string[] = [];
  let head = absolutePath;
  for (;;) {
    try {
      return join(realpathSync(head), ...missing);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolutePath;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

function isContained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve the `DATA_DIR` a rehearsal script may run against: unset (or blank) means the scratch
 * store, an explicit value is honored unless it resolves inside a live data dir, in which case it
 * throws.
 *
 * The refusal is the whole point. A bare `loadConfig()` in scripts/tier0-p3-live.mts is what wrote
 * the orphan agents 875919 and 876740 into the live store. `DATA_DIR` itself is never read to pick
 * the rehearsal directory (a template-derived `.env` always sets `DATA_DIR`, so doing that would
 * make the rehearsal throw, or silently follow, on every normal checkout); it is read only as one
 * of the roots this function refuses to write inside.
 */
export function resolveRehearsalDataDir(
  env: Record<string, string | undefined> = process.env,
  packageRoot: string = PACKAGE_ROOT,
): string {
  const rawCandidate = env.REHEARSAL_DATA_DIR?.trim();
  const candidate = rawCandidate ? rawCandidate : REHEARSAL_DATA_DIR;
  const candidateReal = realish(resolve(packageRoot, candidate));

  const refusedRoots: Array<{ raw: string; real: string }> = [
    { raw: DEFAULT_DATA_DIR, real: realish(resolve(packageRoot, DEFAULT_DATA_DIR)) },
  ];
  const dataDirRaw = env.DATA_DIR?.trim();
  if (dataDirRaw) {
    refusedRoots.push({ raw: dataDirRaw, real: realish(resolve(packageRoot, dataDirRaw)) });
  }

  for (const root of refusedRoots) {
    if (isContained(candidateReal, root.real)) {
      throw new Error(
        `REHEARSAL_DATA_DIR="${candidate}" resolves inside the live data dir (${root.real}); a rehearsal must never write there. Remove REHEARSAL_DATA_DIR to use ${REHEARSAL_DATA_DIR}, or point it at a scratch dir outside that tree.`,
      );
    }
  }

  return resolve(packageRoot, candidate);
}
