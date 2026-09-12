import type Database from "better-sqlite3";

/**
 * doola formation sub-saga persistence (design 2026-08-19 §3/§7, re-keyed to COMPANIES by
 * 2026-08-26 §2/§3), modeled on `bridgeLegRepository`: one row per (companyId, step), an
 * `attempt` counter feeding the provider's idempotency key, and no new `EntityStatus` —
 * formation state layers BESIDE the status machine.
 *
 * The key moved from the entity to the company because the sub-saga runs ONCE PER COMPANY: ten
 * agents may attach to one filing, and a company can be filed (and have its documents fetched)
 * before any agent attaches at all.
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
 * fresh one (`company:<companyId>:<step>:<attempt>`), or a reuse-with-different-body comes back
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
  companyId: string;
  step: FormationStep;
  state: FormationState;
  attempt: number;
  /** doola's id for the thing this step created (customer id, company id…). */
  providerRef: string | null;
  /** JSON blob: filingNumber, ein, document ids. NEVER PII (that lives in formation_parties). */
  detail: string | null;
  error: string | null;
  /** SQLite TEXT "YYYY-MM-DD HH:MM:SS", UTC. The sweeper's backoff clock reads these, so they
   *  are part of the record rather than a second query: "how long has this row been failed?" and
   *  "how long has this entity been in flight?" are the two questions every tick asks. */
  createdAt: string;
  updatedAt: string;
  /**
   * When this row's FACTS last moved — a state change, a new provider ref, or new fact detail.
   *
   * Separate from `updated_at` because `persistPollBackoff` bumps that one on EVERY poll, and the
   * anchor gate reads it: an `await_ein` row waiting four to six weeks for the IRS was making its
   * entity re-read and re-hash its manifest on every single tick of those six weeks (2026-08-26
   * §3). A poll is not a fact.
   */
  factsUpdatedAt: string;
  /** Epoch ms the sweeper may next poll this step, or null when it has never been polled. A
   *  MIRROR of `detail.nextPollAt` — the column exists so the due-set is a query rather than a
   *  full scan of every open company's detail blob (M5). */
  nextPollAt: number | null;
}

interface Row {
  company_id: string;
  step: FormationStep;
  state: FormationState;
  attempt: number;
  provider_ref: string | null;
  detail: string | null;
  error: string | null;
  next_poll_at: number | null;
  created_at: string;
  updated_at: string;
  facts_updated_at: string;
}

function toRecord(r: Row): FormationRequestRecord {
  return {
    companyId: r.company_id,
    step: r.step,
    state: r.state,
    attempt: r.attempt,
    providerRef: r.provider_ref,
    detail: r.detail,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    factsUpdatedAt: r.facts_updated_at,
    nextPollAt: r.next_poll_at ?? null,
  };
}

/**
 * The narrow surface the saga, the doors and (in part B) the sweeper use. Injectable for the
 * same reason `DoolaApi` is: a step that files a real company must be testable against a repo
 * that can be poisoned at any transition.
 */
export interface FormationRepository {
  claimStep(companyId: string, step: FormationStep): boolean;
  claimAllSteps(companyId: string): boolean;
  find(companyId: string, step: FormationStep): FormationRequestRecord | undefined;
  stepsOf(companyId: string): FormationRequestRecord[];
  /**
   * The same rows for MANY companies, in ONE statement (M5).
   *
   * The list routes render every entity a tenant owns, and each one asked for its own steps: N+1
   * queries per page view, on the two hottest read paths in the API and on the unauthenticated
   * `/transparency`. Returns a map so the caller can build a per-key lookup without re-grouping.
   */
  stepsOfMany(companyIds: string[]): Map<string, FormationRequestRecord[]>;
  listByState(state: FormationState): FormationRequestRecord[];
  /** The COMPANY a doola company id belongs to (`idx_formation_provider`). This is the ONLY
   *  mapping from a webhook's `doolaCompanyId` to anything of ours — and until it exists, an
   *  arriving event is unmappable and waits in `doola_webhook_events` for a tick that can place
   *  it (design §5/§6). One advance per company now replaces N per entity. */
  findByProviderRef(providerRef: string): FormationRequestRecord | undefined;
  /** Companies with at least one step not yet in a terminal state — the sweeper's poll candidate
   *  set, narrowed further by the derived formation status at the call site. */
  listOpenCompanyIds(): string[];
  /**
   * The poll-due candidate set, filtered and ordered IN SQL (M5).
   *
   * A superset by construction, and deliberately so: it asks "does this company have any
   * non-terminal polled step that is due?", while the caller decides which step it is actually
   * waiting on. The superset is cheap (an index scan on `next_poll_at`) and the exact answer
   * needs the step ordering, which the caller already has in memory.
   *
   * A row that has never been polled has a NULL `next_poll_at`; its clock is its own
   * `updated_at`, which is why the caller passes the age cutoff as well as the instant. Ordered
   * oldest-due first so a `limit` throttles a backlog instead of starving the tail of it.
   */
  listPollDueCompanyIds(nowMs: number, neverPolledCutoffUtc: string, limit: number): string[];
  /**
   * Companies that are READY to file, have a party bound, and have no formation row at all (C2).
   *
   * Two things live in this one query since the re-key. The original is the crash window between
   * the claim (which writes the pin and binds the party, in one transaction) and `claimAllSteps`
   * at the top of the create step: with no rows the entity matched no other query and would sit,
   * pinned and unfiled, forever. The second is new and deliberate: a company created through
   * `POST /companies` with no agent attached yet is fileable on its own, and this is what opens
   * it — which is why the predicate is about the COMPANY and not about any entity.
   *
   * THE PIN IS PART OF THE PREDICATE, not a check the caller makes afterwards. Opening a company
   * MINTS a `create_provider` row, and that row is what the platform daily ceiling
   * (`createRequestsSince`) counts, and the tenant quota
   * (`companies.countChargeableByTenant`) already counted the company row itself. A company
   * pinned to the other environment is refused by the create step — but only AFTER the row
   * exists, so every tick of a mixed-pin deployment used to burn a ceiling slot on a company it
   * was never going to file, and could exhaust the day's ceiling against filings that can
   * actually happen. Asked here, nothing is minted at all.
   */
  listUnopenedFormations(environment: string, limit: number): string[];
  transition(
    companyId: string,
    step: FormationStep,
    from: FormationState,
    to: FormationState,
    fields?: {
      providerRef?: string;
      detail?: string;
      error?: string | null;
      /** Mirror of `detail.nextPollAt`. Written together with the detail it mirrors, never
       *  alone — the column is an INDEX over the blob, not a second source of truth. */
      nextPollAt?: number;
      /**
       * Whether this write moved the row's FACTS (2026-08-26 §3).
       *
       * Defaults to true for a real state change, a new provider ref or new detail — which is
       * what "facts moved" means — and the two schedulers that write detail on every poll pass
       * `false` explicitly. Getting this wrong in the permissive direction costs one extra
       * manifest re-derivation; getting it wrong the other way stalls an amendment, so the
       * default leans permissive and only the known poll paths opt out.
       */
      touchFacts?: boolean;
    },
  ): boolean;
  bumpAttempt(companyId: string, step: FormationStep, from: FormationState): number | undefined;
  createRequestsSince(sinceUtc: string): number;
}

/**
 * The ONE reader for a `formation_requests.detail` blob (M4).
 *
 * It belongs to the repository because `detail` is the repository's column, and because there
 * were three parsers of it — the create step's private copy, the processor's exported one, and
 * the view's ad-hoc `JSON.parse` — which is three chances to disagree about what an unreadable
 * blob means.
 *
 * A corrupt blob yields an EMPTY object rather than throwing. Every fact `detail` can hold is
 * either re-fetchable from doola or duplicated in a column (`provider_ref` above all), so an
 * unreadable blob must never be the reason an entity is stranded.
 */
export function parseDetail<T>(raw: string | null): T {
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

export class SqliteFormationRepository implements FormationRepository {
  /**
   * Statements are prepared ONCE, in the constructor.
   *
   * The sweeper runs these on a timer, for every in-flight entity, forever — re-preparing on
   * every call means re-parsing and re-planning the same six statements on every tick, for the
   * whole life of the process. better-sqlite3 caches nothing on our behalf; this is the
   * caching. (It also means the table must exist when the repo is constructed, which is already
   * true everywhere: `migrate(db)` runs first at every composition root.)
   */
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      claimStep: db.prepare(
        `INSERT INTO formation_requests (company_id, step, state)
         VALUES (?, ?, 'pending')
         ON CONFLICT(company_id, step) DO NOTHING`,
      ),
      find: db.prepare("SELECT * FROM formation_requests WHERE company_id = ? AND step = ?"),
      stepsOf: db.prepare("SELECT * FROM formation_requests WHERE company_id = ?"),
      listByState: db.prepare(
        "SELECT * FROM formation_requests WHERE state = ? ORDER BY company_id, step",
      ),
      // Scoped to `create_provider`, which is the ONLY step that owns a company id. Without the
      // step filter a later step that mirrored the ref would make this ambiguous.
      findByProviderRef: db.prepare(
        "SELECT * FROM formation_requests WHERE provider_ref = ? AND step = 'create_provider'",
      ),
      listOpenCompanyIds: db.prepare(
        `SELECT DISTINCT company_id AS k FROM formation_requests
          WHERE state NOT IN ('confirmed','abandoned') ORDER BY company_id`,
      ),
      // `facts_updated_at` moves only when the caller says the facts moved. A CASE rather than a
      // second statement so the two timestamps are always written by the same UPDATE and can
      // never disagree about which write they describe.
      transition: db.prepare(
        `UPDATE formation_requests
            SET state = @to,
                provider_ref = COALESCE(@providerRef, provider_ref),
                detail       = COALESCE(@detail, detail),
                error        = @error,
                next_poll_at = COALESCE(@nextPollAt, next_poll_at),
                updated_at   = CURRENT_TIMESTAMP,
                facts_updated_at = CASE WHEN @touchFacts = 1
                                        THEN CURRENT_TIMESTAMP ELSE facts_updated_at END
          WHERE company_id = @companyId AND step = @step AND state = @from`,
      ),
      // Superset by design — see `listPollDueEntityKeys`. GROUP BY + MIN so the ordering is by
      // the EARLIEST due step of each entity, which is what makes `limit` a throttle rather than
      // a starvation hazard.
      listPollDue: db.prepare(
        `SELECT company_id AS k, MIN(COALESCE(next_poll_at, 0)) AS due
           FROM formation_requests
          WHERE state NOT IN ('confirmed','abandoned')
            AND step IN ('await_filing','fetch_documents','await_ein')
            AND ((next_poll_at IS NOT NULL AND next_poll_at <= @now)
                 OR (next_poll_at IS NULL AND updated_at <= @cutoff))
          GROUP BY company_id
          ORDER BY due, company_id
          LIMIT @limit`,
      ),
      // Keyed on the COMPANY, not on any entity: a company with no agent attached yet is
      // fileable, and this is the query that opens it.
      listUnopened: db.prepare(
        `SELECT c.company_id AS k
           FROM companies c
           JOIN formation_parties p
             ON p.company_id = c.company_id AND p.deleted_at IS NULL
          WHERE c.status = 'ready'
            AND c.environment = @environment
            -- doola is the only filer that exists. Stated rather than assumed, so a second
            -- provider added later cannot be opened by this deployment's doola client by default.
            AND c.provider = 'doola'
            AND NOT EXISTS (
                  SELECT 1 FROM formation_requests f WHERE f.company_id = c.company_id)
            -- ⚠ AND NOT WHILE THE FORMATION FEE IS UNPAID (2026-08-26 §6.5). The status = ready
            -- clause above already excludes the ordinary unpaid company, which is a draft — this
            -- is the explicit statement of the rule, so a later path that readies a company
            -- without settling its fee cannot silently spend $150 at doola. Scoped to the
            -- FORMATION product: a live maintenance_year quote is a different bill and must not
            -- hold up the filing it renews.
            AND NOT EXISTS (
                  SELECT 1 FROM formation_payments p2
                   WHERE p2.company_id = c.company_id
                     AND p2.product = 'formation'
                     AND p2.status IN ('quoted','settling'))
          ORDER BY c.company_id
          LIMIT @limit`,
      ),
      // One statement, not an UPDATE followed by a SELECT: the read-back could otherwise return
      // a DIFFERENT driver's attempt number (this repo exists because two drivers meet on these
      // rows), and a retry would then derive an idempotency key for an attempt it does not own.
      // ── The platform daily ceiling (design §2, audit H6). It counts `create_provider` rows,
      //    which is one row per company a filing was ever OPENED for — including failed ones,
      //    deliberately: a create that failed after doola committed has already cost a real
      //    company and a real fee, and a ceiling that only counted successes would let a retry
      //    loop spend without bound.
      //
      //    Its per-TENANT twin (`countByTenant`, a join back to `companies`) is GONE as of A3.
      //    The tenant quota is `companies.countChargeableByTenant` — `ready`, or carrying a live
      //    payment — which §6.7 requires because with payment on a company sits in draft for days
      //    before its create fires, and a quota keyed to `create_provider` rows would not see it.
      //    Both readers existed only because A1's onboard shim ran its own quota check before the
      //    company row existed; with the shim gone, `createCompany` is the single quota site and
      //    a second definition of "how many has this tenant had" is a second answer.
      // Lexicographic on the TEXT CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) the schema
      // writes — the caller supplies the cutoff so the window is testable with an injected clock,
      // which `datetime('now','-24 hours')` would not be.
      countSince: db.prepare(
        "SELECT COUNT(*) AS n FROM formation_requests WHERE step = 'create_provider' AND created_at > ?",
      ),
      // `facts_updated_at` is deliberately NOT touched (2026-08-26 §3): an attempt bump is a
      // statement about an idempotency key, not about the world. A step that fails on every pass
      // would otherwise keep its entity permanently inside the anchor due-set, re-deriving and
      // re-hashing a manifest whose facts have not moved at all.
      bumpAttempt: db.prepare(
        `UPDATE formation_requests
            SET attempt = attempt + 1, state = 'pending', updated_at = CURRENT_TIMESTAMP
          WHERE company_id = ? AND step = ? AND state = ?
      RETURNING attempt`,
      ),
    };
  }

  /** Create a step row in `pending` if it does not exist. Returns true when this caller created
   *  it — the claim primitive (INSERT … DO NOTHING, `claimKey`'s shape), so two drivers racing a
   *  fresh entity cannot both believe they own the step. */
  claimStep(companyId: string, step: FormationStep): boolean {
    return this.stmts.claimStep.run(companyId, step).changes === 1;
  }

  find(companyId: string, step: FormationStep): FormationRequestRecord | undefined {
    const r = this.stmts.find.get(companyId, step) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  stepsOfMany(companyIds: string[]): Map<string, FormationRequestRecord[]> {
    const out = new Map<string, FormationRequestRecord[]>();
    if (companyIds.length === 0) return out;
    // `IN (?,?,…)` built per call rather than prepared once: the arity varies, and SQLite has no
    // array binding. Chunked at 400 to stay clear of SQLITE_MAX_VARIABLE_NUMBER (999 by default).
    for (let i = 0; i < companyIds.length; i += 400) {
      const chunk = companyIds.slice(i, i + 400);
      const rows = this.db
        .prepare(
          `SELECT * FROM formation_requests WHERE company_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk) as Row[];
      for (const r of rows) {
        const list = out.get(r.company_id);
        if (list) list.push(toRecord(r));
        else out.set(r.company_id, [toRecord(r)]);
      }
    }
    // Saga order per company, the same order `stepsOf` returns.
    for (const [k, list] of out)
      out.set(
        k,
        FORMATION_STEP_ORDER.map((step) => list.find((r) => r.step === step)).filter(
          (r): r is FormationRequestRecord => r !== undefined,
        ),
      );
    return out;
  }

  /** Every step of one company, in saga order (missing steps are simply absent). */
  stepsOf(companyId: string): FormationRequestRecord[] {
    const rows = this.stmts.stepsOf.all(companyId) as Row[];
    const byStep = new Map(rows.map((r) => [r.step, toRecord(r)]));
    return FORMATION_STEP_ORDER.map((s) => byStep.get(s)).filter(
      (r): r is FormationRequestRecord => r !== undefined,
    );
  }

  /** Rows the sweeper owes work on: everything in `state` for any company. */
  listByState(state: FormationState): FormationRequestRecord[] {
    return (this.stmts.listByState.all(state) as Row[]).map(toRecord);
  }

  findByProviderRef(providerRef: string): FormationRequestRecord | undefined {
    const r = this.stmts.findByProviderRef.get(providerRef) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  listOpenCompanyIds(): string[] {
    return (this.stmts.listOpenCompanyIds.all() as { k: string }[]).map((r) => r.k);
  }

  listPollDueCompanyIds(nowMs: number, neverPolledCutoffUtc: string, limit: number): string[] {
    return (
      this.stmts.listPollDue.all({
        now: nowMs,
        cutoff: neverPolledCutoffUtc,
        limit,
      }) as { k: string }[]
    ).map((r) => r.k);
  }

  listUnopenedFormations(environment: string, limit: number): string[] {
    return (this.stmts.listUnopened.all({ environment, limit }) as { k: string }[]).map((r) => r.k);
  }

  /**
   * COMPARE-AND-SET the state: moves `step` from `from` to `to` and returns whether THIS caller
   * made the move. A second concurrent driver observing the same `from` gets `false` and must not
   * perform the side effect. Optional fields are written only when supplied, so a transition never
   * silently NULLs a provider_ref another step already earned.
   */
  transition(
    companyId: string,
    step: FormationStep,
    from: FormationState,
    to: FormationState,
    fields: {
      providerRef?: string;
      detail?: string;
      error?: string | null;
      nextPollAt?: number;
      touchFacts?: boolean;
    } = {},
  ): boolean {
    const info = this.stmts.transition.run({
      to,
      providerRef: fields.providerRef ?? null,
      detail: fields.detail ?? null,
      // `error` is the one field a transition MUST be able to clear: a row that succeeds after
      // a failure has no error, and leaving a stale one would misreport a healthy step.
      error: fields.error ?? null,
      nextPollAt: fields.nextPollAt ?? null,
      // A state change, a new provider ref or new detail IS a fact moving. The poll schedulers
      // write detail on every pass and say `false`; nothing else has to think about it.
      touchFacts:
        (fields.touchFacts ??
        (to !== from || fields.providerRef !== undefined || fields.detail !== undefined))
          ? 1
          : 0,
      companyId,
      step,
      from,
    });
    return info.changes === 1;
  }

  /**
   * A failed create released its idempotency key — bump the attempt so the retry derives a fresh
   * one and reset the step to `pending`. CAS on the current state for the same reason `transition`
   * is: two sweeper ticks must not double-bump and skip an attempt number. Returns the new attempt
   * number, or undefined when this caller lost the race.
   */
  bumpAttempt(companyId: string, step: FormationStep, from: FormationState): number | undefined {
    // UPDATE … RETURNING: the bump and the read-back are ONE statement, so the number returned
    // is the one THIS update wrote. The previous UPDATE-then-SELECT could read a value another
    // driver had bumped in between and hand back an attempt number this caller does not own —
    // and the attempt number IS the idempotency key doola's create endpoints honor.
    const row = this.stmts.bumpAttempt.get(companyId, step, from) as
      | { attempt: number }
      | undefined;
    return row?.attempt;
  }

  /** Formations opened across the deployment since a UTC "YYYY-MM-DD HH:MM:SS" instant
   *  (FORMATION_DAILY_CEILING, the platform_outflows twin). */
  createRequestsSince(sinceUtc: string): number {
    return (this.stmts.countSince.get(sinceUtc) as { n: number }).n;
  }

  /** Claim all four steps of a new company's formation in ONE transaction (the bridge-legs
   *  pattern): "is a formation in flight for this company?" is then a single query over rows that
   *  provably all exist, instead of a guess about which of them a crash created. Returns whether
   *  this caller opened the saga (i.e. `create_provider` did not already exist). */
  claimAllSteps(companyId: string): boolean {
    return this.db.transaction(() => {
      let opened = false;
      for (const step of FORMATION_STEP_ORDER)
        if (this.claimStep(companyId, step) && step === "create_provider") opened = true;
      return opened;
    })();
  }

  /**
   * The deterministic per-attempt idempotency key doola's two create endpoints honor.
   *
   * `endpoint` is a hardening suffix (C1): the customer create and the company create are two
   * different requests with two different bodies, and giving them one key made "same key,
   * different body" — doola's `E_IDEMPOTENCY_KEY_REUSED` — a shape our own traffic could produce.
   * Omitted, the bare per-attempt key is returned, which is what the pre-suffix rows carry.
   *
   * The prefix moved from `formation:<entityKey>` to `company:<companyId>` with the re-key, and
   * NO legacy branch survives (2026-08-26 §2). A derived key is only ever re-sent while its
   * `create_provider` row is `pending`/`submitted` — exactly the rows the migration REFUSES to
   * move — so no row that survived the migration can re-send an old key.
   */
  static idempotencyKey(
    companyId: string,
    step: FormationStep,
    attempt: number,
    endpoint?: "customer" | "company",
  ): string {
    const base = `company:${companyId}:${step}:${attempt}`;
    return endpoint ? `${base}:${endpoint}` : base;
  }
}
