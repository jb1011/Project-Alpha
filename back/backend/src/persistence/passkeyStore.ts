import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";

export interface PasskeyView {
  id: string;
  name: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface PasskeyStore {
  store(tenantId: string, pk: GuardianPasskey): string;
  get(tenantId: string, id: string): GuardianPasskey | null;
  list(tenantId: string): PasskeyView[];
  /** Soft-revoke. Returns true if a live passkey was revoked. Off-chain only:
   *  prevents FUTURE onboard/bootstrap use of this passkeyId; never affects an
   *  already-provisioned entity (its Turnkey/on-chain guardian exist independently). */
  revoke(tenantId: string, id: string): boolean;
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
        "SELECT name, challenge, attestation FROM passkeys WHERE id = ? AND owner_tenant = ? AND revoked_at IS NULL",
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
        "SELECT id, name, created_at AS createdAt, revoked_at AS revokedAt FROM passkeys WHERE owner_tenant = ? ORDER BY created_at",
      )
      .all(tenantId) as PasskeyView[];
  }

  revoke(tenantId: string, id: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE passkeys SET revoked_at = ? WHERE id = ? AND owner_tenant = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), id, tenantId);
    return res.changes > 0;
  }
}
