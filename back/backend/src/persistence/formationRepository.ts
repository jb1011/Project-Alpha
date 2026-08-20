import type Database from "better-sqlite3";

/**
 * doola formation sub-saga persistence (design 2026-08-19 §3/§7), modeled on
 * `bridgeLegRepository`: one row per (entityKey, step), an `attempt` counter feeding the
 * provider's idempotency key, and no new `EntityStatus` — formation state layers BESIDE the
 * status machine.
 *
 * The one deliberate departure from the bridge repo: **every state transition is a
 * compare-and-set** (`UPDATE … WHERE state = ?`, acting only when `changes() === 1`) and returns
 * whether it won. Correctness is DB-level, not mutex-level — `withKeyedLock` is single-process by
 * its own doc, and the sweeper is the first unattended periodic driver in the codebase, so two
 * drivers WILL meet on the same row. The CAS is what makes "executes exactly once" true; the lock
 * is only an optimization (audit M13/20).
 *
 * `attempt` matters for the same reason it does on the bridge: doola honors `Idempotency-Key` on
 * the two CREATE endpoints only, and a failed create RELEASES its key — so a retry must derive a
 * fresh one (`formation:<entityKey>:<step>:<attempt>`), or a reuse-with-different-body comes back
 * `409 E_IDEMPOTENCY_KEY_REUSED`.
 */
export type FormationStep = "create_provider" | "await_filing" | "fetch_documents" | "await_ein";
export type FormationState = "pending" | "submitted" | "confirmed" | "failed" | "abandoned";

/** Saga order. `await_ein` legitimately sits for 4–6 weeks (the IRS, not us). */
export const FORMATION_STEP_ORDER: readonly FormationStep[] = [
  "create_provider",
  "await_filing",
  "fetch_documents",
  "await_ein",
] as const;

export interface FormationRequestRecord {
  entityKey: string;
  step: FormationStep;
  state: FormationState;
  attempt: number;
  /** doola's id for the thing this step created (customer id, company id…). */
  providerRef: string | null;
  /** JSON blob: filingNumber, ein, document ids. NEVER PII (that lives in formation_parties). */
  detail: string | null;
  error: string | null;
}

interface Row {
  entity_key: string;
  step: FormationStep;
  state: FormationState;
  attempt: number;
  provider_ref: string | null;
  detail: string | null;
  error: string | null;
}

function toRecord(r: Row): FormationRequestRecord {
  return {
    entityKey: r.entity_key,
    step: r.step,
    state: r.state,
    attempt: r.attempt,
    providerRef: r.provider_ref,
    detail: r.detail,
    error: r.error,
  };
}

export class SqliteFormationRepository {
  constructor(private readonly db: Database.Database) {}

  /** Create a step row in `pending` if it does not exist. Returns true when this caller created
   *  it — the claim primitive (INSERT … DO NOTHING, `claimKey`'s shape), so two drivers racing a
   *  fresh entity cannot both believe they own the step. */
  claimStep(entityKey: string, step: FormationStep): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO formation_requests (entity_key, step, state)
         VALUES (?, ?, 'pending')
         ON CONFLICT(entity_key, step) DO NOTHING`,
      )
      .run(entityKey, step);
    return info.changes === 1;
  }

  find(entityKey: string, step: FormationStep): FormationRequestRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM formation_requests WHERE entity_key = ? AND step = ?")
      .get(entityKey, step) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  /** Every step of one entity, in saga order (missing steps are simply absent). */
  stepsOf(entityKey: string): FormationRequestRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM formation_requests WHERE entity_key = ?")
      .all(entityKey) as Row[];
    const byStep = new Map(rows.map((r) => [r.step, toRecord(r)]));
    return FORMATION_STEP_ORDER.map((s) => byStep.get(s)).filter(
      (r): r is FormationRequestRecord => r !== undefined,
    );
  }

  /** Rows the sweeper owes work on: everything in `state` for any entity. */
  listByState(state: FormationState): FormationRequestRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM formation_requests WHERE state = ? ORDER BY entity_key, step")
        .all(state) as Row[]
    ).map(toRecord);
  }

  /**
   * COMPARE-AND-SET the state: moves `step` from `from` to `to` and returns whether THIS caller
   * made the move. A second concurrent driver observing the same `from` gets `false` and must not
   * perform the side effect. Optional fields are written only when supplied, so a transition never
   * silently NULLs a provider_ref another step already earned.
   */
  transition(
    entityKey: string,
    step: FormationStep,
    from: FormationState,
    to: FormationState,
    fields: { providerRef?: string; detail?: string; error?: string | null } = {},
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE formation_requests
            SET state = ?,
                provider_ref = COALESCE(?, provider_ref),
                detail       = COALESCE(?, detail),
                error        = ?,
                updated_at   = CURRENT_TIMESTAMP
          WHERE entity_key = ? AND step = ? AND state = ?`,
      )
      .run(
        to,
        fields.providerRef ?? null,
        fields.detail ?? null,
        // `error` is the one field a transition MUST be able to clear: a row that succeeds after
        // a failure has no error, and leaving a stale one would misreport a healthy step.
        fields.error ?? null,
        entityKey,
        step,
        from,
      );
    return info.changes === 1;
  }

  /**
   * A failed create released its idempotency key — bump the attempt so the retry derives a fresh
   * one and reset the step to `pending`. CAS on the current state for the same reason `transition`
   * is: two sweeper ticks must not double-bump and skip an attempt number. Returns the new attempt
   * number, or undefined when this caller lost the race.
   */
  bumpAttempt(entityKey: string, step: FormationStep, from: FormationState): number | undefined {
    const info = this.db
      .prepare(
        `UPDATE formation_requests
            SET attempt = attempt + 1, state = 'pending', updated_at = CURRENT_TIMESTAMP
          WHERE entity_key = ? AND step = ? AND state = ?`,
      )
      .run(entityKey, step, from);
    if (info.changes !== 1) return undefined;
    const row = this.db
      .prepare("SELECT attempt FROM formation_requests WHERE entity_key = ? AND step = ?")
      .get(entityKey, step) as { attempt: number };
    return row.attempt;
  }

  /** The deterministic per-attempt idempotency key doola's two create endpoints honor. */
  static idempotencyKey(entityKey: string, step: FormationStep, attempt: number): string {
    return `formation:${entityKey}:${step}:${attempt}`;
  }
}
