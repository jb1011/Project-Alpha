import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { readVerifiedAgreement } from "../../legalBody/agreement";
import {
  type LegalBodyOrderDeps,
  abandonOrder,
  createOrder,
  requireOwnedOrder,
  toOrderView,
} from "../../legalBody/orders";
import { refusal } from "../../legalBody/sentences";
import { opsLog } from "../../observability/opsLog";
import { ApiError, readJson } from "../errors";
import { TokenBucket } from "./agentBook";
import { assertRealHuman } from "./worldId";

/**
 * THE LEGAL-BODY ORDER DOORS: a guardian orders a legal body for a company it declared and the
 * operator checked, and follows the order.
 *
 *  - `POST /legal-body-orders` with `{ companyId }` orders one: 201 with the order's view;
 *  - `GET /legal-body-orders` lists the tenant's orders, newest first;
 *  - `GET /legal-body-orders/:id` reads one, as stored (no chain read);
 *  - `GET /legal-body-orders/:id/agreement` serves the agreement the link will anchor, from the
 *    stored bytes, re-verified: the caller can check keccak256 of `manifest` against the hash its
 *    link signs, and the manifest's `terms.hash` against keccak256 of `termsDoc`;
 *  - `POST /legal-body-orders/:id/abandon` closes a draft.
 *
 * Every rule lives in the domain (`legalBody/orders.ts`); these handlers decide only what is a
 * well-formed request. Every door starts with the real-human check (a verified credential, never a
 * waiver), the reads included; the order door's domain function makes that check first itself.
 * Mounted under their own session protection, and only where the deployment wires the feature.
 *
 * An error a door did not choose never reaches the caller as it was thrown: anything but an
 * `ApiError` or a `ZodError` answers 500 `internal_error` with a fixed sentence, after one line
 * that names the door and the error's NAME. The app's own handler would render the message of any
 * error carrying a numeric `status`, and a transport error carries the node's status and its URL.
 */

/** The largest body a JSON door reads, in bytes. An order is a few dozen. */
export const LEGAL_BODY_DOOR_MAX_BODY_BYTES = 8 * 1024;

/** The most keys one of the doors' bucket maps holds before it forgets the least recently used. */
export const DOOR_BUCKET_MAX_KEYS = 10_000;

/**
 * One token bucket per key, made on first use, for the doors' per-tenant and per-identity
 * throttles. At most `maxKeys` buckets are held: the least recently used is forgotten first, and a
 * forgotten key starts again with a full bucket. That costs a caller at most one more burst, and
 * keeps the memory bounded whatever keys callers bring.
 */
export function bucketsByKey(
  capacity: number,
  refillPerSecond: number,
  maxKeys: number = DOOR_BUCKET_MAX_KEYS,
): (key: string) => TokenBucket {
  const buckets = new Map<string, TokenBucket>();
  return (key) => {
    const found = buckets.get(key);
    // Re-inserted on every use, so the map's order is least recently used first.
    if (found) {
      buckets.delete(key);
      buckets.set(key, found);
      return found;
    }
    const fresh = new TokenBucket(capacity, refillPerSecond);
    buckets.set(key, fresh);
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    return fresh;
  };
}

/** The door's answer, or the 500 `internal_error` for anything it did not choose. */
async function door<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError || err instanceof ZodError) throw err;
    opsLog("legal_body_door_failed", {
      level: "error",
      door: name,
      errorName: err instanceof Error ? err.name : "not_an_error",
    });
    throw refusal("internal_error", 500);
  }
}

export function mountLegalBodyOrderRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: LegalBodyOrderDeps,
): void {
  // On both JSON doors, the abandon door included: it reads no body, and still bounds what a
  // caller may send it. A declared length over the limit is refused before a byte is read.
  const limit = bodyLimit({
    maxSize: LEGAL_BODY_DOOR_MAX_BODY_BYTES,
    onError: () => {
      throw refusal("payload_too_large", 413);
    },
  });

  /** The tenant, once it has passed the real-human check. */
  const realHuman = (tenantId: AuthVars["tenantId"]) => {
    assertRealHuman(deps.world, tenantId, deps.environment);
    return tenantId;
  };

  app.post("/legal-body-orders", limit, (c) =>
    door("order", async () => {
      const body = await readJson(c);
      // `createOrder` checks the real human first, and reads anything but a string `companyId`
      // as an id no company holds: the same 404 as an id that is not the tenant's.
      const view = createOrder(deps, c.get("tenantId"), body as { companyId: string });
      return c.json(view, 201);
    }),
  );

  app.get("/legal-body-orders", (c) =>
    door("list", () => {
      const tenantId = realHuman(c.get("tenantId"));
      return c.json({ orders: deps.repo.listByTenant(tenantId).map(toOrderView) });
    }),
  );

  app.get("/legal-body-orders/:id", (c) =>
    door("read", () => {
      const tenantId = realHuman(c.get("tenantId"));
      return c.json(toOrderView(requireOwnedOrder(deps, tenantId, c.req.param("id"))));
    }),
  );

  app.get("/legal-body-orders/:id/agreement", (c) =>
    door("agreement", () => {
      const tenantId = realHuman(c.get("tenantId"));
      const row = requireOwnedOrder(deps, tenantId, c.req.param("id"));
      const hash = row.oaManifestHash;
      if (hash === null) {
        // Every order is born with its agreement frozen, so a row without one was not made here.
        opsLog("legal_body_agreement_unverifiable", {
          level: "error",
          legalBodyId: row.legalBodyId,
          reason: "not_frozen",
        });
        throw refusal("agreement_unreadable", 500);
      }
      // Re-verified on every read: the manifest against the frozen hash, the terms against the
      // manifest. A failure has already written its error line.
      const verified = readVerifiedAgreement(deps.docStore, row.legalBodyId, hash);
      if (verified === undefined) throw refusal("agreement_unreadable", 500);
      return c.json({
        termsDoc: verified.termsDoc,
        manifest: verified.manifest,
        manifestHash: hash,
        textId: verified.terms.textId,
        textVersion: verified.terms.textVersion,
        textStatus: verified.terms.textStatus,
      });
    }),
  );

  app.post("/legal-body-orders/:id/abandon", limit, (c) =>
    door("abandon", async () => {
      const tenantId = realHuman(c.get("tenantId"));
      return c.json(await abandonOrder(deps, tenantId, c.req.param("id")));
    }),
  );
}
