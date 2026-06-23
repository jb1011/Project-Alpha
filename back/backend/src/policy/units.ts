import { formatUnits, parseUnits } from "viem";

const USDC_DECIMALS = 6;
const UNIT_SECONDS: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3_600n,
  d: 86_400n,
};

/** Parse "30d" | "24h" | "90m" | "3600s" | "3600" | number into bigint SECONDS. */
export function parseDuration(input: string | number): bigint {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0) throw new Error(`Invalid duration: ${input}`);
    return BigInt(input);
  }
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  const m = /^(\d+)(s|m|h|d)$/.exec(trimmed);
  if (!m) throw new Error(`Invalid duration: "${input}" (use e.g. 30d, 24h, 90m, 3600s)`);
  return BigInt(m[1]!) * UNIT_SECONDS[m[2]!]!;
}

/** Parse a plain USD amount string ("1000.00") into 6-decimal USDC base units. */
export function usdToUnits(usd: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(usd.trim())) {
    throw new Error(`Invalid USD amount: "${usd}" (use e.g. 1000.00, max 6 decimals)`);
  }
  return parseUnits(usd.trim(), USDC_DECIMALS);
}

/** Inverse of usdToUnits for display. */
export function formatUnitsUsd(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS);
}
