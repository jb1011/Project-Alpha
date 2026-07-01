import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface ChallengeStore {
  issue(tenantId: string, now: number, ttlMs: number): string;
  consume(tenantId: string, challenge: string, now: number): boolean;
}

/** Single-use, TTL-bounded, tenant-scoped WebAuthn registration challenges. */
export class SqliteChallengeStore implements ChallengeStore {
  constructor(private readonly db: Database.Database) {}

  issue(tenantId: string, now: number, ttlMs: number): string {
    const challenge = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO webauthn_challenges (challenge, owner_tenant, issued_at, expires_at) VALUES (?,?,?,?)",
      )
      .run(challenge, tenantId, now, now + ttlMs);
    return challenge;
  }

  /** True iff the challenge existed for this tenant and was unexpired; deletes it if tenant matches. */
  consume(tenantId: string, challenge: string, now: number): boolean {
    const row = this.db
      .prepare("SELECT owner_tenant, expires_at FROM webauthn_challenges WHERE challenge = ?")
      .get(challenge) as { owner_tenant: string; expires_at: number } | undefined;
    if (row && row.owner_tenant === tenantId) {
      this.db.prepare("DELETE FROM webauthn_challenges WHERE challenge = ?").run(challenge);
      return row.expires_at > now;
    }
    return false;
  }
}
