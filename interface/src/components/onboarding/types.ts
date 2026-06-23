export type Phase =
  | "welcome"
  | "configure"
  | "agreement"
  | "deploy"
  | "fund"
  | "dashboard";

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
  /** Per-transaction spend ceiling, in USDC. Kept as a string for input binding. */
  perTxCap: string;
  /** Rolling 24h spend ceiling, in USDC. */
  dailyCap: string;
  allowlist: AllowlistEntry[];
  /** Hours an above-cap or sensitive action is held before it can execute. */
  timelockHours: string;
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
  { id: "welcome", n: "00", label: "Wallet & passkey" },
  { id: "configure", n: "01", label: "Define agent" },
  { id: "agreement", n: "02", label: "Operating agreement" },
  { id: "deploy", n: "03", label: "Deploy on-chain" },
  { id: "fund", n: "04", label: "Fund treasury" },
  { id: "dashboard", n: "05", label: "Live" },
];

export const emptyConfig = (): AgentConfig => ({
  name: "",
  purpose: "",
  configMode: "manual",
  perTxCap: "",
  dailyCap: "",
  allowlist: [],
  timelockHours: "24",
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
