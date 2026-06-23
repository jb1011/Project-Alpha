import type Database from "better-sqlite3";
import { generateSiweNonce } from "viem/siwe";

export interface NonceStore {
  issue(now: number, ttlMs: number): string;
  consume(nonce: string, now: number): boolean;
}

/** Single-use, TTL-bounded SIWE nonces backed by the auth_nonces table. */
export class SqliteNonceStore implements NonceStore {
  constructor(private readonly db: Database.Database) {}

  issue(now: number, ttlMs: number): string {
    const nonce = generateSiweNonce();
    this.db
      .prepare("INSERT INTO auth_nonces (nonce, issued_at, expires_at) VALUES (?,?,?)")
      .run(nonce, now, now + ttlMs);
    return nonce;
  }

  /** Returns true iff the nonce existed and was unexpired; deletes it either way (burn-on-consume). */
  consume(nonce: string, now: number): boolean {
    const row = this.db.prepare("SELECT expires_at FROM auth_nonces WHERE nonce = ?").get(nonce) as
      | { expires_at: number }
      | undefined;
    this.db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").run(nonce);
    return !!row && row.expires_at > now;
  }
}
