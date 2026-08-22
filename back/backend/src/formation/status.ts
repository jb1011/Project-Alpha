import type { DoolaEnvironment } from "../adapters/doola/types";
import { type FormationRequestRecord, parseDetail } from "../persistence/formationRepository";
import type { EntityRecord } from "../types";

/**
 * The formation DOMAIN projection (design §5/§8) — what an entity's sub-saga rows mean.
 *
 * It lives here rather than in `api/views.ts` because four surfaces need it and one of them is
 * not a surface at all: the sweeper reads the derived status to decide whether an entity is still
 * in flight. With the function living under `api/`, `src/workflow` imported from `src/api` — a
 * timer depending on a view layer, which is backwards and which made the import graph
 * (views → processor → receiver → app → views) one edit away from a cycle. A layering test asserts
 * that `src/workflow` never imports from `src/api` again.
 *
 * Nothing here reads PII, and nothing here reads the EIN: `formationSummary` is deliberately the
 * shape that is safe on the UNAUTHENTICATED surfaces too, and the authenticated view adds the two
 * owner-only fields on top of it.
 */

/**
 * What a caller is told about an entity's formation — DERIVED from the sub-saga rows, never
 * stored, so it cannot drift from the rows the sweeper actually drives.
 *
 *   none         nothing has been opened (a legacy/stub entity, or a filing not yet started)
 *   in_progress  opened, nothing legally true yet — doola has the request
 *   filed        the STATE has filed it: the company legally exists
 *   complete     the EIN has been issued: the entity is fully formed
 *   failed       nothing was filed and the step that would have filed it is in error
 */
export type FormationStatus = "none" | "in_progress" | "filed" | "complete" | "failed";

/**
 * The projection, in the ONE order that keeps it honest.
 *
 * `filed` and `complete` are checked BEFORE `failed`, deliberately: an entity whose company was
 * filed but whose document fetch failed IS a filed company, and reporting it as "failed" would
 * deny a legal fact that already exists in Wyoming's records. Conversely an entity whose
 * `create_provider` failed has nothing confirmed at all, so it falls through to `failed` —
 * which is the honest answer, and the one the ops trail agrees with.
 */
export function deriveFormationStatus(steps: FormationRequestRecord[]): FormationStatus {
  if (steps.length === 0) return "none";
  const state = (step: FormationRequestRecord["step"]) => steps.find((s) => s.step === step)?.state;
  if (state("await_ein") === "confirmed") return "complete";
  if (state("await_filing") === "confirmed" || state("fetch_documents") === "confirmed")
    return "filed";
  if (steps.some((s) => s.state === "failed" || s.state === "abandoned")) return "failed";
  return "in_progress";
}

/**
 * Open required-action codes out of `await_filing.detail`.
 *
 * Parsed structurally rather than against the processor's `AwaitFilingDetail`: this module is a
 * pure projection and must not depend on the driver. A malformed or absent blob yields no
 * actions, which is the honest answer — a UI that cannot read the detail must not claim there is
 * nothing to do OR invent something to do.
 */
export function requiredActionCodesOf(steps: FormationRequestRecord[]): string[] {
  const detail = parseDetail<{ requiredActions?: { code?: unknown }[] }>(
    steps.find((s) => s.step === "await_filing")?.detail ?? null,
  );
  return (detail.requiredActions ?? [])
    .map((a) => a?.code)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

/**
 * Everything about one entity's formation that is safe on ANY surface.
 *
 * No EIN (a tax identifier — authenticated views only), no filing party, nothing at all out of
 * `formation_parties`. `/metadata` and `/transparency` pick two fields out of this; the
 * authenticated `EntityView` spreads it and adds the two owner-only ones. One derivation, so a
 * public surface and a private one can never disagree about what an entity's formation IS.
 *
 * Null when the record is not pinned to a provider — the shape every legacy row keeps forever.
 */
export interface FormationSummary {
  provider: string;
  /** REQUIRED whenever the block exists (the honesty invariant, §2): a sandbox filing can never
   *  render as a real one by omission. */
  environment: DoolaEnvironment;
  status: FormationStatus;
  /** doola's company id. An opaque provider reference — not PII. */
  providerRef: string | null;
  /** Unix seconds the STATE filed the company. Null until it has. */
  filedAt: number | null;
  filingNumber: string | null;
  /** Open required-action CODES only, e.g. `FORMATION_NAME_OPTIONS_EXHAUSTED`. Never the id and
   *  never doola's `reason` prose, which is free text their operators write and can name the
   *  responsible party. */
  requiredActions: string[];
}

export function formationSummary(
  rec: Pick<
    EntityRecord,
    "formationProvider" | "formationEnvironment" | "formationFiledAt" | "formationFilingNumber"
  >,
  steps: FormationRequestRecord[],
): FormationSummary | null {
  // Both halves or neither: an entity pinned to a provider is always pinned to an environment too
  // (they are written together at the claim), so a half-populated block would be a bug — and
  // rendering one without the other is exactly the deception §2 forbids.
  if (!rec.formationProvider || !rec.formationEnvironment) return null;
  return {
    provider: rec.formationProvider,
    environment: rec.formationEnvironment,
    status: deriveFormationStatus(steps),
    providerRef: steps.find((s) => s.step === "create_provider")?.providerRef ?? null,
    filedAt: rec.formationFiledAt ?? null,
    filingNumber: rec.formationFilingNumber ?? null,
    requiredActions: requiredActionCodesOf(steps),
  };
}
