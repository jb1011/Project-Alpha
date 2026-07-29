import type { Capability } from "@/lib/api/types";

export type CapabilityOption = { value: Capability; label: string; description: string };

// Entity-scoped (web-first): bounded by ONE body's on-chain caps → spend default is safe.
export const ENTITY_CAPABILITIES: CapabilityOption[] = [
  { value: "read", label: "Read", description: "See balances, jobs, and status. Cannot move money or take jobs." },
  { value: "earn", label: "Earn", description: "Read + run jobs to earn (ERC-8183)." },
  { value: "spend", label: "Spend", description: "Earn + pay via x402, within this treasury's caps/allowlist." },
];

// Tenant-wide (bootstrap): acts across your whole tenant → default to read, opt-up explicitly.
export const TENANT_CAPABILITIES: CapabilityOption[] = [
  { value: "read", label: "Read", description: "See balances, jobs, and status across your tenant. Cannot move money." },
  { value: "earn", label: "Earn", description: "Read + run jobs to earn (ERC-8183)." },
  { value: "spend", label: "Spend", description: "Earn + pay via x402 across your tenant." },
  {
    value: "provision",
    label: "Provision",
    description: "Spend + fund treasuries from the platform + create new agent legal bodies across your tenant.",
  },
];

export const ENTITY_DEFAULT_CAPABILITY: Capability = "spend";
export const TENANT_DEFAULT_CAPABILITY: Capability = "read";
