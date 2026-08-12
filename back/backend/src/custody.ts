/** Tier-0 custody availability — the one place the "not available on this deployment" wording
 *  lives, so the REST /onboard gate and the MCP onboard_agent gate can never drift apart
 *  (both surfaces must stay behaviorally identical; tests regex-match these messages). */
export type WalletProvider = "turnkey" | "circle";

export function custodyUnavailableMessage(provider: WalletProvider): string {
  return provider === "circle"
    ? "circle custody is not available on this deployment (Circle credentials/wallet set not configured)"
    : "turnkey custody is not available on this deployment (Turnkey credentials not configured)";
}
