import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface LinkCodeStore {
  issue(tenantId: string, now: number, ttlMs: number): string;
  consume(tenantId: string, code: string, now: number): boolean;
}

/** Single-use, TTL-bounded, tenant-scoped agent-first bootstrap link codes. */
export class SqliteLinkCodeStore implements LinkCodeStore {
  constructor(private readonly db: Database.Database) {}

  issue(tenantId: string, now: number, ttlMs: number): string {
    const code = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO link_codes (code, owner_tenant, issued_at, expires_at) VALUES (?,?,?,?)",
      )
      .run(code, tenantId, now, now + ttlMs);
    return code;
  }

  /** True iff the code existed for this tenant and was unexpired; deletes it if the tenant matches
   *  (single-use, so a wrong-tenant attempt never burns the owner's code). */
  consume(tenantId: string, code: string, now: number): boolean {
    const row = this.db
      .prepare("SELECT owner_tenant, expires_at FROM link_codes WHERE code = ?")
      .get(code) as { owner_tenant: string; expires_at: number } | undefined;
    if (row && row.owner_tenant === tenantId) {
      this.db.prepare("DELETE FROM link_codes WHERE code = ?").run(code);
      return row.expires_at > now;
    }
    return false;
  }
}
