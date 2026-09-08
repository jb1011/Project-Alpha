import { decodeAbiParameters } from "viem";

/**
 * World's bridge returns the Groth16 proof either as a JSON array of 8 strings or as an
 * ABI-encoded `uint256[8]` blob; World's own CLI handles both (`cli/src/index.ts` at 434407c).
 *
 * `null` means "not a proof we recognise" — the caller must then send nothing. Never throws, and
 * never appears in a log or on screen: the proof is the guardian's, not ours.
 */
export function normalizeProof(raw: string): string[] | null {
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length === 8 ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  try {
    const [decoded] = decodeAbiParameters([{ type: "uint256[8]" }], raw as `0x${string}`);
    return decoded.map((v) => `0x${v.toString(16).padStart(64, "0")}`);
  } catch {
    return null;
  }
}
