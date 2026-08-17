import type Database from "better-sqlite3";

/** A stored proof that a unique human verified for `action`. `nullifier` is the only identity
 *  datum World returns — stable per (human, rp, action), unlinkable across apps. */
export interface GuardianVerification {
  nullifier: string;
  action: string;
  tenantId: string;
  issuerSchemaId: number | null;
  credential: string | null;
  environment: string | null;
  verifiedAt: number;
  expiresAtMin: number | null;
}

/** An optional document-backed attestation for a guardian: proof that they cleared a threshold
 *  (currently age) at a point in time. No country — World's attributes are assertions, not
 *  disclosures, so a value can be checked but never learned. */
export interface GuardianAttestation {
  nullifier: string;
  action: string;
  tenantId: string;
  minAge: number;
  credential: string | null;
  issuerSchemaId: number | null;
  verifiedAt: number;
  expiresAtMin: number | null;
}

export interface WorldStore {
  // ── guardian verifications (proof-of-personhood) ──
  /** Insert a verification. Returns false if this nullifier already verified for this action
   *  under a DIFFERENT tenant (the sybil gate); true on insert or same-tenant re-verify. */
  recordVerification(v: GuardianVerification): boolean;
  findByTenant(tenantId: string, action: string): GuardianVerification | undefined;
  findByNullifier(nullifier: string, action: string): GuardianVerification | undefined;
  /** How many entities this human's tenant already owns (for the N-per-human cap). */
  countEntitiesForNullifier(nullifier: string, action: string): number;

  // ── identity attestations (optional step-up) ──
  /** Same one-human-one-tenant rule as verifications: false if bound to a different tenant. */
  recordAttestation(a: GuardianAttestation): boolean;
  findAttestationByTenant(tenantId: string, action: string): GuardianAttestation | undefined;

  // ── guardian waivers (admin-issued escape hatch, see guardian_waivers DDL) ──
  createWaiver(w: { codeHash: string; note: string; createdAt: number; expiresAt?: number }): void;
  /** Atomically redeem an open, unexpired waiver for `tenantId`. Returns its note, or undefined
   *  if the code is unknown, already redeemed, or expired — deliberately indistinguishable. */
  redeemWaiver(codeHash: string, tenantId: string, now: number): { note: string } | undefined;
  /** Delete an UNREDEEMED waiver. False if it never existed, was revoked, or was already used. */
  revokeWaiver(codeHash: string): boolean;
  listWaivers(): {
    codeHash: string;
    note: string;
    createdAt: number;
    expiresAt: number | null;
    redeemedBy: string | null;
    redeemedAt: number | null;
  }[];

  // ── in-flight proof requests ──
  createRequest(r: {
    requestId: string;
    tenantId: string;
    action: string;
    nonce?: string;
    createdAt: number;
    expiresAt: number;
  }): void;
  getRequest(requestId: string):
    | {
        requestId: string;
        tenantId: string;
        action: string;
        nonce: string | null;
        status: string;
        detail: string | null;
        expiresAt: number;
      }
    | undefined;
  updateRequest(requestId: string, status: string, detail?: string): void;

  // ── AgentKit seller-side ──
  /** True iff the nonce was unused (marks it used). Replay guard for agentkit payloads. */
  consumeNonce(nonce: string, now: number): boolean;
  /** Increment usage for (human, resource) if under `limit`; returns the authorization decision. */
  /** Windowed per-human counter. `windowMs` absent -> lifetime (legacy). A window that has
   *  elapsed since the last update resets the count — so a "rate cap" is actually a rate. */
  tryIncrementUsage(
    humanId: string,
    resource: string,
    limit: number,
    now: number,
    windowMs?: number,
  ): { allowed: boolean; used: number; resetAt?: number };
  /** Cached AgentBook lookup, positives only. Thin wrapper over `getCachedLookup`. */
  getCachedHuman(agentAddress: string, now: number, ttlMs: number): string | undefined;
  cacheHuman(agentAddress: string, humanId: string, now: number): void;
  /**
   * Cached AgentBook lookup including DEFINITIVE negatives.
   *
   * `{ humanId: null }` means the contract itself answered "nobody vouches for this address" —
   * NOT that the lookup failed. A failed lookup must never reach this cache: caching an outage as
   * a refusal would lock a legitimately registered agent out for the whole TTL. Negatives carry
   * their own (much shorter) TTL because registration is something an agent actively fixes and
   * should be picked up promptly.
   */
  getCachedLookup(
    agentAddress: string,
    now: number,
    positiveTtlMs: number,
    negativeTtlMs: number,
  ): { humanId: string | null } | undefined;
  cacheLookup(agentAddress: string, humanId: string | null, now: number): void;
}

/** Sentinel stored in `world_human_cache.human_id` for a DEFINITIVE "not registered" answer.
 *  The column is NOT NULL and the table is a disposable cache, so a sentinel beats a migration.
 *  Not a valid human id (those are 0x-prefixed hex), so it can never collide with a real one. */
const UNREGISTERED = "";

/** The SDK refuses messages older than 5 minutes, so anything past this is unreplayable. */
const NONCE_RETENTION_MS = 15 * 60_000;
/** Amortise the sweep so the hot path is one INSERT, not an INSERT plus a DELETE scan. */
const NONCE_SWEEP_EVERY = 50;

export class SqliteWorldStore implements WorldStore {
  constructor(private readonly db: Database.Database) {}

  recordAttestation(a: GuardianAttestation): boolean {
    const existing = this.db
      .prepare("SELECT * FROM guardian_attestations WHERE nullifier = ? AND action = ?")
      .get(a.nullifier, a.action) as { tenant_id?: string } | undefined;
    if (existing && existing.tenant_id !== a.tenantId) return false; // one human, one tenant
    this.db
      .prepare(
        `INSERT INTO guardian_attestations
           (nullifier, action, tenant_id, min_age, credential, issuer_schema_id, verified_at, expires_at_min)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(nullifier, action) DO UPDATE SET
           min_age=excluded.min_age,
           credential=excluded.credential,
           issuer_schema_id=excluded.issuer_schema_id,
           verified_at=excluded.verified_at,
           expires_at_min=excluded.expires_at_min`,
      )
      .run(
        a.nullifier,
        a.action,
        a.tenantId,
        a.minAge,
        a.credential,
        a.issuerSchemaId,
        a.verifiedAt,
        a.expiresAtMin,
      );
    return true;
  }

  findAttestationByTenant(tenantId: string, action: string): GuardianAttestation | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM guardian_attestations WHERE tenant_id = ? AND action = ? ORDER BY verified_at DESC LIMIT 1",
      )
      .get(tenantId, action) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      nullifier: r.nullifier as string,
      action: r.action as string,
      tenantId: r.tenant_id as string,
      minAge: r.min_age as number,
      credential: (r.credential as string) ?? null,
      issuerSchemaId: (r.issuer_schema_id as number) ?? null,
      verifiedAt: r.verified_at as number,
      expiresAtMin: (r.expires_at_min as number) ?? null,
    };
  }

  recordVerification(v: GuardianVerification): boolean {
    const existing = this.findByNullifier(v.nullifier, v.action);
    if (existing && existing.tenantId !== v.tenantId) return false; // one human, one tenant
    this.db
      .prepare(
        `INSERT INTO guardian_verifications
           (nullifier, action, tenant_id, issuer_schema_id, credential, environment, verified_at, expires_at_min)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(nullifier, action) DO UPDATE SET
           verified_at=excluded.verified_at,
           credential=excluded.credential,
           environment=excluded.environment,
           expires_at_min=excluded.expires_at_min`,
      )
      .run(
        v.nullifier,
        v.action,
        v.tenantId,
        v.issuerSchemaId,
        v.credential,
        v.environment,
        v.verifiedAt,
        v.expiresAtMin,
      );
    return true;
  }

  private toVerification(r: Record<string, unknown> | undefined): GuardianVerification | undefined {
    if (!r) return undefined;
    return {
      nullifier: r.nullifier as string,
      action: r.action as string,
      tenantId: r.tenant_id as string,
      issuerSchemaId: (r.issuer_schema_id as number | null) ?? null,
      credential: (r.credential as string | null) ?? null,
      environment: (r.environment as string | null) ?? null,
      verifiedAt: r.verified_at as number,
      expiresAtMin: (r.expires_at_min as number | null) ?? null,
    };
  }

  findByTenant(tenantId: string, action: string): GuardianVerification | undefined {
    return this.toVerification(
      this.db
        .prepare(
          "SELECT * FROM guardian_verifications WHERE tenant_id = ? AND action = ? ORDER BY verified_at DESC LIMIT 1",
        )
        .get(tenantId, action) as Record<string, unknown> | undefined,
    );
  }

  findByNullifier(nullifier: string, action: string): GuardianVerification | undefined {
    return this.toVerification(
      this.db
        .prepare("SELECT * FROM guardian_verifications WHERE nullifier = ? AND action = ?")
        .get(nullifier, action) as Record<string, unknown> | undefined,
    );
  }

  countEntitiesForNullifier(nullifier: string, action: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM entities
         WHERE owner_tenant_id IN (
           SELECT tenant_id FROM guardian_verifications WHERE nullifier = ? AND action = ?
         )`,
      )
      .get(nullifier, action) as { n: number };
    return row.n;
  }

  createWaiver(w: { codeHash: string; note: string; createdAt: number; expiresAt?: number }): void {
    this.db
      .prepare(
        "INSERT INTO guardian_waivers (code_hash, note, created_at, expires_at) VALUES (?,?,?,?)",
      )
      .run(w.codeHash, w.note, w.createdAt, w.expiresAt ?? null);
  }

  redeemWaiver(codeHash: string, tenantId: string, now: number): { note: string } | undefined {
    return this.db.transaction(() => {
      // The UPDATE carries every validity condition, so redemption is a single atomic
      // compare-and-set: two concurrent redeemers cannot both see changes === 1.
      const res = this.db
        .prepare(
          `UPDATE guardian_waivers SET redeemed_by = ?, redeemed_at = ?
           WHERE code_hash = ? AND redeemed_by IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(tenantId, now, codeHash, now);
      if (res.changes !== 1) return undefined;
      const row = this.db
        .prepare("SELECT note FROM guardian_waivers WHERE code_hash = ?")
        .get(codeHash) as { note: string };
      return { note: row.note };
    })();
  }

  revokeWaiver(codeHash: string): boolean {
    const res = this.db
      .prepare("DELETE FROM guardian_waivers WHERE code_hash = ? AND redeemed_by IS NULL")
      .run(codeHash);
    return res.changes === 1;
  }

  listWaivers() {
    const rows = this.db
      .prepare("SELECT * FROM guardian_waivers ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      codeHash: r.code_hash as string,
      note: r.note as string,
      createdAt: r.created_at as number,
      expiresAt: (r.expires_at as number | null) ?? null,
      redeemedBy: (r.redeemed_by as string | null) ?? null,
      redeemedAt: (r.redeemed_at as number | null) ?? null,
    }));
  }

  createRequest(r: {
    requestId: string;
    tenantId: string;
    action: string;
    nonce?: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO world_requests (request_id, tenant_id, action, nonce, status, created_at, expires_at)
         VALUES (?,?,?,?, 'pending', ?, ?)`,
      )
      .run(r.requestId, r.tenantId, r.action, r.nonce ?? null, r.createdAt, r.expiresAt);
  }

  getRequest(requestId: string) {
    const r = this.db.prepare("SELECT * FROM world_requests WHERE request_id = ?").get(requestId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      requestId: r.request_id as string,
      tenantId: r.tenant_id as string,
      action: r.action as string,
      nonce: (r.nonce as string | null) ?? null,
      status: r.status as string,
      detail: (r.detail as string | null) ?? null,
      expiresAt: r.expires_at as number,
    };
  }

  updateRequest(requestId: string, status: string, detail?: string): void {
    this.db
      .prepare("UPDATE world_requests SET status = ?, detail = ? WHERE request_id = ?")
      .run(status, detail ?? null, requestId);
  }

  consumeNonce(nonce: string, now: number): boolean {
    try {
      this.db
        .prepare("INSERT INTO world_nonces (nonce, used_at, created_at) VALUES (?,?,?)")
        .run(nonce, now, now);
      this.sweepNonces(now);
      return true;
    } catch {
      return false; // PK conflict => already used
    }
  }

  /**
   * Drop nonces older than the replay window. Without this the table grows forever: rows are
   * written by an unauthenticated route BEFORE signature verification, so a scripted caller can
   * add them at will (~96 bytes each) until the disk fills.
   *
   * Safe because the AgentKit SDK rejects messages older than 5 minutes on freshness alone, so a
   * nonce past NONCE_RETENTION_MS can no longer be replayed even if forgotten. Amortised: this
   * runs on roughly 1 in SWEEP_EVERY inserts, so the hot path stays a single INSERT.
   */
  private sweepCounter = 0;
  private sweepNonces(now: number): void {
    if (++this.sweepCounter % NONCE_SWEEP_EVERY !== 0) return;
    this.db.prepare("DELETE FROM world_nonces WHERE created_at < ?").run(now - NONCE_RETENTION_MS);
  }

  tryIncrementUsage(
    humanId: string,
    resource: string,
    limit: number,
    now: number,
    windowMs?: number,
  ): { allowed: boolean; used: number; resetAt?: number } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT used, updated_at FROM world_usage WHERE human_id = ? AND resource = ?")
        .get(humanId, resource) as { used: number; updated_at: number } | undefined;
      // An elapsed window resets the count. Reset can only ever grant MORE than the old
      // lifetime behavior, never less, so existing callers are safe.
      const expired = row != null && windowMs != null && now - row.updated_at > windowMs;
      const used = expired ? 0 : (row?.used ?? 0);
      const resetAt = row && windowMs != null && !expired ? row.updated_at + windowMs : undefined;
      if (used >= limit) return { allowed: false, used, resetAt };
      this.db
        .prepare(
          `INSERT INTO world_usage (human_id, resource, used, updated_at) VALUES (?,?,1,?)
           ON CONFLICT(human_id, resource) DO UPDATE SET used = ?, updated_at = excluded.updated_at`,
        )
        .run(humanId, resource, now, used + 1);
      return { allowed: true, used: used + 1, resetAt };
    })();
  }

  getCachedHuman(agentAddress: string, now: number, ttlMs: number): string | undefined {
    const hit = this.getCachedLookup(agentAddress, now, ttlMs, 0);
    return hit?.humanId ?? undefined;
  }

  cacheHuman(agentAddress: string, humanId: string, now: number): void {
    this.cacheLookup(agentAddress, humanId, now);
  }

  getCachedLookup(
    agentAddress: string,
    now: number,
    positiveTtlMs: number,
    negativeTtlMs: number,
  ): { humanId: string | null } | undefined {
    const r = this.db
      .prepare("SELECT human_id, cached_at FROM world_human_cache WHERE agent_address = ?")
      .get(agentAddress.toLowerCase()) as { human_id: string; cached_at: number } | undefined;
    if (!r) return undefined;
    const negative = r.human_id === UNREGISTERED;
    const ttl = negative ? negativeTtlMs : positiveTtlMs;
    if (now - r.cached_at > ttl) return undefined;
    return { humanId: negative ? null : r.human_id };
  }

  cacheLookup(agentAddress: string, humanId: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO world_human_cache (agent_address, human_id, cached_at) VALUES (?,?,?)
         ON CONFLICT(agent_address) DO UPDATE SET human_id=excluded.human_id, cached_at=excluded.cached_at`,
      )
      .run(agentAddress.toLowerCase(), humanId ?? UNREGISTERED, now);
  }
}
