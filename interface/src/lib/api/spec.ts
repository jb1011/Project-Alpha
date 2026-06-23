import type { AgentConfig } from "@/components/onboarding/types";
import { MANAGER_ADDRESS } from "./config";
import type { AgentSpec } from "./types";

function toUsdcAmount(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
    useGrouping: false,
  });
}

function toAmendmentDelay(hours: string): string {
  const h = Math.max(1, Number(hours) || 1);
  return `${h}h`;
}

/** Map the wizard form into the backend AgentSpec shape. */
export function configToAgentSpec(
  config: AgentConfig,
  guardianAddress: `0x${string}`,
): AgentSpec {
  const payout =
    config.allowlist.find((e) => e.address.trim().length > 0)?.address.trim() ||
    guardianAddress;

  return {
    name: config.name.trim(),
    jurisdiction: "Wyoming-DAO-LLC",
    roles: {
      manager: MANAGER_ADDRESS,
      guardian: guardianAddress,
    },
    treasury: {
      payoutAddress: payout,
      spendingCapUsdc: toUsdcAmount(config.dailyCap || config.perTxCap),
      spendingPeriod: "24h",
      allowlistEnabled: config.allowlist.length > 0,
    },
    governance: {
      amendmentDelay: toAmendmentDelay(config.timelockHours),
    },
    metadata: {
      description: config.purpose.trim(),
      agentType: "service",
      capabilities: [],
      version: "1",
    },
  };
}

/** Convert a human USDC amount to atomic units (6 decimals). */
export function usdcToAtomic(amount: string | number): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (Number.isNaN(n) || n < 0) throw new Error("invalid USDC amount");
  return BigInt(Math.round(n * 1_000_000)).toString();
}
