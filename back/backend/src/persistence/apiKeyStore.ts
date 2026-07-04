import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ApiKeyView {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
  entityId: string | null;
  capability: Capability;
}

export type Capability = "read" | "earn" | "spend";
export interface MintOpts {
  label?: string;
  entityId?: string;
  capability?: Capability;
  ttlMs?: number;
}
export interface VerifiedKey {
  tenantId: string;
  id: string;
  entityId: string | null;
  capability: Capability;
}

export interface ApiKeyStore {
  mint(tenantId: string, opts?: MintOpts): { id: string; key: string };
  verify(key: string): VerifiedKey | null;
  list(tenantId: string): ApiKeyView[];
  revoke(tenantId: string, id: string): boolean;
}

const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Per-tenant API keys for the MCP server. Only the sha-256 hash is stored; the plaintext
 *  (`mcp_<base64url(32 bytes)>`) is returned exactly once from `mint`. */
export class SqliteApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Database.Database) {}

  mint(tenantId: string, opts: MintOpts = {}): { id: string; key: string } {
    const id = randomUUID();
    const key = `mcp_${randomBytes(32).toString("base64url")}`;
    const expiresAt = opts.ttlMs !== undefined ? Date.now() + opts.ttlMs : null;
    this.db
      .prepare(
        "INSERT INTO api_keys (id, owner_tenant, hash, label, created_at, entity_id, capability, expires_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        tenantId,
        hashKey(key),
        opts.label ?? null,
        Date.now(),
        opts.entityId ?? null,
        opts.capability ?? "spend",
        expiresAt,
      );
    return { id, key };
  }

  verify(key: string): VerifiedKey | null {
    const row = this.db
      .prepare(
        "SELECT id, owner_tenant, entity_id, capability, expires_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL",
      )
      .get(hashKey(key)) as
      | {
          id: string;
          owner_tenant: string;
          entity_id: string | null;
          capability: string | null;
          expires_at: number | null;
        }
      | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
    return {
      tenantId: row.owner_tenant,
      id: row.id,
      entityId: row.entity_id,
      capability: (row.capability as Capability) ?? "spend",
    };
  }

  list(tenantId: string): ApiKeyView[] {
    return this.db
      .prepare(
        "SELECT id, label, entity_id AS entityId, capability, created_at AS createdAt, revoked_at AS revokedAt FROM api_keys WHERE owner_tenant = ? ORDER BY created_at",
      )
      .all(tenantId) as ApiKeyView[];
  }

  revoke(tenantId: string, id: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_tenant = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), id, tenantId);
    return res.changes > 0;
  }
}
