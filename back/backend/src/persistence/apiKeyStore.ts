import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ApiKeyView {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface ApiKeyStore {
  mint(tenantId: string, label?: string): { id: string; key: string };
  verify(key: string): { tenantId: string; id: string } | null;
  list(tenantId: string): ApiKeyView[];
  revoke(tenantId: string, id: string): boolean;
}

const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Per-tenant API keys for the MCP server. Only the sha-256 hash is stored; the plaintext
 *  (`mcp_<base64url(32 bytes)>`) is returned exactly once from `mint`. */
export class SqliteApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Database.Database) {}

  mint(tenantId: string, label?: string): { id: string; key: string } {
    const id = randomUUID();
    const key = `mcp_${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare(
        "INSERT INTO api_keys (id, owner_tenant, hash, label, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, tenantId, hashKey(key), label ?? null, Date.now());
    return { id, key };
  }

  verify(key: string): { tenantId: string; id: string } | null {
    const row = this.db
      .prepare("SELECT id, owner_tenant FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
      .get(hashKey(key)) as { id: string; owner_tenant: string } | undefined;
    return row ? { tenantId: row.owner_tenant, id: row.id } : null;
  }

  list(tenantId: string): ApiKeyView[] {
    return this.db
      .prepare(
        "SELECT id, label, created_at AS createdAt, revoked_at AS revokedAt FROM api_keys WHERE owner_tenant = ? ORDER BY created_at",
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
