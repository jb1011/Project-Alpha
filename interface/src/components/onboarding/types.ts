export type Phase =
  | "welcome"
  | "guardian"
  | "custody"
  | "configure"
  | "agreement"
  | "deploy"
  | "fund"
  | "dashboard";

/** Tier-0 custody choice for the agent's OPERATOR keys (the payment float is platform-managed on
 *  both options — the choice covers the operator layer only). */
export type Custody = "turnkey" | "circle";

export type ConfigMode = "manual" | "mcp";

export type AllowlistEntry = {
  id: string;
  label: string;
  address: string;
};

import type { EntityView, GuardianPasskey } from "@/lib/api/types";

export type AgentConfig = {
  name: string;
  purpose: string;
  configMode: ConfigMode;
  /** Operator-key custody: "circle" = Novi-managed smart account (gasless), "turnkey" =
   *  guardian-passkey-rooted key vault. Platform default is circle since Tier-0 P4. */
  custody: Custody;
  /** Per-transaction spend ceiling, in USDC. Kept as a string for input binding. */
  perTxCap: string;
  /** Rolling 24h spend ceiling, in USDC. */
  dailyCap: string;
  allowlist: AllowlistEntry[];
  /** Hours an above-cap or sensitive action is held before it can execute. */
  timelockHours: string;
  /** Rolling spending period length in hours (maps to treasury spendingPeriod). */
  spendingPeriodHours: string;
};

export type OnboardingSession = {
  entityId: string | null;
  idempotencyKey: string | null;
  entity: EntityView | null;
  guardianPasskey: GuardianPasskey | null;
};

export const emptySession = (): OnboardingSession => ({
  entityId: null,
  idempotencyKey: null,
  entity: null,
  guardianPasskey: null,
});

export const PHASES: { id: Phase; n: string; label: string }[] = [
  { id: "welcome", n: "1", label: "Wallet & passkey" },
  { id: "guardian", n: "2", label: "Accountable human" },
  { id: "custody", n: "3", label: "Key custody" },
  { id: "configure", n: "4", label: "Define agent" },
  { id: "agreement", n: "5", label: "Operating agreement" },
  { id: "deploy", n: "6", label: "Deploy on-chain" },
  { id: "fund", n: "7", label: "Fund treasury" },
  { id: "dashboard", n: "8", label: "Live" },
];

export const emptyConfig = (): AgentConfig => ({
  name: "",
  purpose: "",
  configMode: "manual",
  // Tier-0 P4 (2026-08-07): flipped to `circle` alongside the backend's prod default, since the
  // wizard always SENDS an explicit custody value (a backend-only flip would never reach wizard
  // users). CustodyStep downgrades this to `turnkey` at runtime when GET /config reports the
  // deployment can't serve circle, so credential-less deployments still onboard.
  custody: "circle",
  perTxCap: "",
  dailyCap: "",
  allowlist: [],
  timelockHours: "24",
  spendingPeriodHours: "24",
});

export type FieldErrors = Partial<Record<keyof AgentConfig | "allowlistRow", string>>;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value.trim());
}

export function shortAddress(value: string): string {
  const v = value.trim();
  if (v.length <= 12) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** Live validation shared by the manual form and the MCP review screen. */
export function validateConfig(config: AgentConfig): FieldErrors {
  const errors: FieldErrors = {};

  if (!config.name.trim()) {
    errors.name = "Give your agent a name.";
  } else if (config.name.trim().length > 42) {
    errors.name = "Keep the name under 42 characters.";
  }

  const perTx = Number(config.perTxCap);
  if (config.perTxCap === "" || Number.isNaN(perTx)) {
    errors.perTxCap = "Enter a per-transaction cap.";
  } else if (perTx <= 0) {
    errors.perTxCap = "The cap must be greater than 0.";
  }

  const daily = Number(config.dailyCap);
  if (config.dailyCap === "" || Number.isNaN(daily)) {
    errors.dailyCap = "Enter a daily cap.";
  } else if (daily <= 0) {
    errors.dailyCap = "The cap must be greater than 0.";
  } else if (!Number.isNaN(perTx) && daily < perTx) {
    errors.dailyCap = "Daily cap can't be lower than the per-transaction cap.";
  }

  const timelock = Number(config.timelockHours);
  if (config.timelockHours === "" || Number.isNaN(timelock) || timelock < 1) {
    errors.timelockHours = "Timelock must be at least 1 hour.";
  }

  if (config.allowlist.some((entry) => !isAddress(entry.address))) {
    errors.allowlistRow = "One or more addresses are not valid (expected 0x… 40 hex chars).";
  }

  return errors;
}

export function isConfigValid(config: AgentConfig): boolean {
  return Object.keys(validateConfig(config)).length === 0;
}

export function formatUsdc(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
