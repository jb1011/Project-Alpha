/** Price an answer at a margin over input cost. margin 0.5 = +50%. Integer (atomic USDC), rounded up. */
export function priceAnswer(totalCost: bigint, margin: number): bigint {
  const bps = BigInt(Math.round((1 + margin) * 10_000)); // e.g. 1.5 -> 15000
  return (totalCost * bps + 9_999n) / 10_000n; // ceil division
}
