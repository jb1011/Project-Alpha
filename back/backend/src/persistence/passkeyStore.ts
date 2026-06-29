import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";

export interface PasskeyView {
  id: string;
  name: string | null;
  createdAt: number;
}

export interface PasskeyStore {
  store(tenantId: string, pk: GuardianPasskey): string;
  get(tenantId: string, id: string): GuardianPasskey | null;
  list(tenantId: string): PasskeyView[];
}

/** Server-side store of guardian WebAuthn attestations (PUBLIC credentials, not private keys),
 *  referenced by handle so the MCP `onboard_agent` tool can provision a per-agent vault without
 *  the LLM performing a browser ceremony. */
export class SqlitePasskeyStore implements PasskeyStore {
  constructor(private readonly db: Database.Database) {}

  store(tenantId: string, pk: GuardianPasskey): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO passkeys (id, owner_tenant, name, challenge, attestation, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        tenantId,
        pk.authenticatorName ?? null,
        pk.challenge,
        JSON.stringify(pk.attestation),
        Date.now(),
      );
    return id;
  }

  get(tenantId: string, id: string): GuardianPasskey | null {
    const row = this.db
      .prepare(
        "SELECT name, challenge, attestation FROM passkeys WHERE id = ? AND owner_tenant = ?",
      )
      .get(id, tenantId) as
      | { name: string | null; challenge: string; attestation: string }
      | undefined;
    if (!row) return null;
    return {
      ...(row.name ? { authenticatorName: row.name } : {}),
      challenge: row.challenge,
      attestation: JSON.parse(row.attestation),
    };
  }

  list(tenantId: string): PasskeyView[] {
    return this.db
      .prepare(
        "SELECT id, name, created_at AS createdAt FROM passkeys WHERE owner_tenant = ? ORDER BY created_at",
      )
      .all(tenantId) as PasskeyView[];
  }
}
