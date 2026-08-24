export type Phase =
  | "welcome"
  | "guardian"
  /** The responsible natural person a real filing names (design §3/§8). Present only where the
   *  deployment can actually form entities — see `visiblePhases`. */
  | "legal-identity"
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

import type { EntityView, FormationPartyInput, GuardianPasskey } from "@/lib/api/types";

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
  /** The OPAQUE handle `POST /formation-party` returned — never the identity behind it. This is
   *  the only thing the legal-identity phase leaves in wizard state, and the only formation datum
   *  the persistence allowlist carries. */
  partyId: string | null;
  /** Whether that handle is the labeled sandbox fixture rather than a real person. Kept so the
   *  wizard can keep saying "demo" after a reload instead of quietly promoting it. */
  partySynthetic: boolean;
};

export const emptySession = (): OnboardingSession => ({
  entityId: null,
  idempotencyKey: null,
  entity: null,
  guardianPasskey: null,
  partyId: null,
  partySynthetic: false,
});

export type PhaseMeta = { id: Phase; label: string };

/**
 * Every phase the wizard can show, in order.
 *
 * The step NUMBER is deliberately not stored here: `legal-identity` is present on some
 * deployments and absent on others, so a hardcoded "3" on the custody step would be wrong on
 * exactly half of them. Numbers are derived from the VISIBLE list at render time
 * (`screenLabel`), which is the only list that knows.
 */
export const PHASES: PhaseMeta[] = [
  { id: "welcome", label: "Wallet & passkey" },
  { id: "guardian", label: "Accountable human" },
  { id: "legal-identity", label: "Legal identity" },
  { id: "custody", label: "Key custody" },
  { id: "configure", label: "Define agent" },
  { id: "agreement", label: "Operating agreement" },
  { id: "deploy", label: "Deploy on-chain" },
  { id: "fund", label: "Fund treasury" },
  { id: "dashboard", label: "Live" },
];

/**
 * The phases THIS deployment has.
 *
 * `formationAvailable` comes from `GET /config`, and anything other than an explicit `true`
 * hides the phase — a backend that predates the field forms nothing, which is exactly what
 * absent should mean, and a deployment we cannot ask must not be shown a step whose only
 * endpoint would answer 503.
 */
export function visiblePhases(formationAvailable: boolean): PhaseMeta[] {
  return formationAvailable ? PHASES : PHASES.filter((p) => p.id !== "legal-identity");
}

export function indexIn(phases: PhaseMeta[], phase: Phase): number {
  return phases.findIndex((p) => p.id === phase);
}

/** The "Screen N" eyebrow, counted over the phases this deployment actually shows. */
export function screenLabel(phases: PhaseMeta[], phase: Phase): string {
  const i = indexIn(phases, phase);
  return `Screen ${i < 0 ? 1 : i + 1}`;
}

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

/* ------------------------------------------------------------------ */
/* The PII slice — separate from AgentConfig, and separate on purpose  */
/* ------------------------------------------------------------------ */

/**
 * The responsible natural person's legal identity, as the form holds it (design §3, audit 16/L8).
 *
 * **This is NOT part of `AgentConfig`, and that is the whole point.** `AgentConfig` is persisted
 * to localStorage and translated into the `AgentSpec` the backend stores verbatim; anything that
 * lived on it would follow it into both. This type lives in its own slice, held only in wizard
 * memory, cleared the moment the backend hands back a handle, and named nowhere in the
 * persistence allowlist (`lib/onboarding/storage.ts`).
 *
 * Flat rather than nested because a form binds to flat fields; `toFormationPartyInput` builds the
 * nested wire shape the backend's `.strict()` schema expects.
 */
export type FormationParty = {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  /** REQUIRED. doola refuses a company create whose responsible party has no phone, so a party
   *  without one is an identity that can never be filed — the backend refuses it at intake. */
  phone: string;
  line1: string;
  line2: string;
  city: string;
  /** US: the 2-letter state. Blank for the countries that have no state/province. */
  region: string;
  postalCode: string;
  /** ISO-3166-1 **alpha-3** ("USA", "FRA") — doola's convention, not alpha-2. */
  country: string;
};

export const emptyParty = (): FormationParty => ({
  legalFirstName: "",
  legalLastName: "",
  email: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
});

export type PartyFieldErrors = Partial<Record<keyof FormationParty, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO3_RE = /^[A-Za-z]{3}$/;
const US_STATE_RE = /^[A-Za-z]{2}$/;

/**
 * The PII slice's OWN validator, mirroring the backend's `FormationPartySchema` field for field.
 *
 * Separate from `validateConfig` for the same reason the types are separate: one function
 * validating both would have to be handed both, and the PII would be one refactor away from the
 * object that gets persisted. Client-side validation is a courtesy either way — the backend
 * schema is the authority, and it is `.strict()`.
 */
export function validateParty(party: FormationParty): PartyFieldErrors {
  const errors: PartyFieldErrors = {};

  if (!party.legalFirstName.trim()) errors.legalFirstName = "Enter the legal first name.";
  if (!party.legalLastName.trim()) errors.legalLastName = "Enter the legal last name.";
  if (!EMAIL_RE.test(party.email.trim())) errors.email = "Enter a valid email address.";
  // Not "optional but recommended": a filing without it is refused, so the wizard refuses first.
  if (!party.phone.trim()) errors.phone = "A phone number is required — a filing without one is refused.";
  if (!party.line1.trim()) errors.line1 = "Enter the street address.";
  if (!party.city.trim()) errors.city = "Enter the city.";
  if (!party.postalCode.trim()) errors.postalCode = "Enter the postal code.";

  const country = party.country.trim().toUpperCase();
  if (!ISO3_RE.test(country)) {
    errors.country = "Choose a country (ISO-3166-1 alpha-3, e.g. USA).";
  } else if (country === "USA" && !US_STATE_RE.test(party.region.trim())) {
    // Only the US: most countries have no state/province at all, and demanding one there would
    // invent a field the filing does not have.
    errors.region = "A US filing needs the 2-letter state, e.g. WY.";
  }

  return errors;
}

export function isPartyValid(party: FormationParty): boolean {
  return Object.keys(validateParty(party)).length === 0;
}

/**
 * The wire shape, built once at the edge.
 *
 * Blank optionals are OMITTED rather than sent empty: the backend address schema is `.strict()`
 * with `min(1)` on `line2`/`region`, so an empty string is a 400 while an absent key is correct.
 */
export function toFormationPartyInput(party: FormationParty): FormationPartyInput {
  const line2 = party.line2.trim();
  const region = party.region.trim();
  return {
    legalFirstName: party.legalFirstName.trim(),
    legalLastName: party.legalLastName.trim(),
    email: party.email.trim(),
    phone: party.phone.trim(),
    address: {
      line1: party.line1.trim(),
      ...(line2 ? { line2 } : {}),
      city: party.city.trim(),
      ...(region ? { region } : {}),
      postalCode: party.postalCode.trim(),
      country: party.country.trim().toUpperCase(),
    },
  };
}

export function formatUsdc(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
