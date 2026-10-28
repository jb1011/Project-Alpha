import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ExternalRecordAnswer } from "../../trackRecord/read";
import type { ExternalRecordView } from "../../trackRecord/types";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { AnswerMemo } from "./legalBodies";

/** The window a definitive answer is served from memory: the card refetches on the same beat. */
export const EXTERNAL_RECORD_MEMO_MS = 60_000;
const EXTERNAL_RECORD_MEMO_ENTRIES = 500;

/** What the route needs: the read, already bound to its sources, and the provider's one word. */
export interface ExternalRecordDeps {
  read: (agentId: bigint) => Promise<ExternalRecordAnswer>;
  providerName: string;
}

export type { ExternalRecordView };

/**
 * `GET /entities/:id/external-record` (design 2026-10-23, section 4.2): the agent's record as
 * graded by the configured provider, for the guardian's settings screen.
 *
 * Tenant-scoped, under the `/entities` auth, owner-checked like the treasury route. A source
 * failure is never a 500: the read degrades each half on its own and the route answers 200 with
 * what it could read. The last DEFINITIVE answer per entity is served for 60 s; an answer with
 * any half unavailable is never kept, so a retry reaches the sources again.
 */
export function mountExternalRecordRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: ApiDeps & { externalRecord: ExternalRecordDeps },
) {
  const memo = new AnswerMemo<ExternalRecordView>(
    EXTERNAL_RECORD_MEMO_MS,
    EXTERNAL_RECORD_MEMO_ENTRIES,
    deps.now ?? Date.now,
  );

  app.get("/entities/:id/external-record", async (c) => {
    const id = c.req.param("id");
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    if (!rec.agentId) throw new ApiError("not_ready", 409, "agent identity not minted yet");

    // Tenant data through the interface's proxy: never cached on the way.
    c.header("Cache-Control", "private, no-store");
    const hit = memo.get(id);
    if (hit) return c.json(hit);

    const { view, definitive } = await deps.externalRecord.read(BigInt(rec.agentId));
    if (definitive) memo.set(id, view);
    return c.json(view);
  });
}
