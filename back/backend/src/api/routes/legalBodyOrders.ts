import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Hex } from "viem";
import { ZodError } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { readVerifiedAgreement } from "../../legalBody/agreement";
import { type BindingView, checkBinding, readBinding } from "../../legalBody/binding";
import { type GasSeedDeps, requestGasSeed } from "../../legalBody/gasSeed";
import { linkMessage, submitLinkAndCreate } from "../../legalBody/linkDoor";
import {
  type LegalBodyOrderDeps,
  abandonOrder,
  assertThisDeployment,
  createOrder,
  orderLockKey,
  requireOwnedOrder,
  takeDoorTokens,
  toOrderView,
} from "../../legalBody/orders";
import { resolveOrder } from "../../legalBody/resolver";
import { refusal, refusedLinkSentence } from "../../legalBody/sentences";
import { opsLog } from "../../observability/opsLog";
import { withKeyedLock } from "../../payments/keyedMutex";
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
 *  - `POST /legal-body-orders/:id/abandon` closes a draft;
 *  - `POST /legal-body-orders/:id/link-message` with `{ agentId, ttlSeconds? }` serves the EIP-712
 *    message the identity's owner signs, and writes nothing;
 *  - `POST /legal-body-orders/:id/link` with `{ message, signature }` accepts the signed link and
 *    has the body created: 200 with the order once it is `deployed` or `linked`, 202 while it is
 *    `reserved` (the create is on its way, or waits for the resolver after a fault or a cap, and
 *    is settled from the chain), 422 with `{ code, message, detail, order }` for a refusal of the
 *    link (before the reserve the draft is kept; after it the order is `lapsed`, and the message
 *    says so). A 429 or a 503 comes only before the reserve, and means that nothing changed;
 *  - `GET /legal-body-orders/:id/binding` reads the order's binding as stored (no chain read): its
 *    state, its identity and body, and the pointer the identity's owner should write, as an intent
 *    that names the action, the identity, the body and the chain. Never calldata: the caller
 *    encodes the metadata write itself, from a pinned ABI;
 *  - `POST /legal-body-orders/:id/binding/refresh` reads it again from the chain, under the
 *    order's lock: one resolver pass for a `reserved` order, one binding check for any other, and
 *    the same view as the read. A chain that could not answer is a 503 `chain_unavailable`, and
 *    no state moved;
 *  - `POST /legal-body-orders/:id/gas-seed` sends the identity's owner of a `deployed` order a
 *    small native amount to pay for its pointer transaction with, once per tenant, ever: 200 with
 *    `{ status: "sent", txHash }`. Mounted where the deployment wires it; while its amount is 0 it
 *    answers 409 `gas_seed_disabled`.
 *
 * Every rule lives in the domain (`legalBody/orders.ts`, `legalBody/linkDoor.ts`,
 * `legalBody/resolver.ts`, `legalBody/binding.ts`, `legalBody/gasSeed.ts`); these handlers decide
 * only what is a well-formed request, and the refresh which of the domain's two passes to run.
 * Every door starts with the real-human check (a verified credential, never a waiver), the reads
 * included; the domain functions of the order door, the two link doors and the binding door
 * (`readBinding`, which the `get_binding` tool calls too) make that check first themselves. The
 * one exception is the gas seed: while it is off, it answers before that check, reading nothing
 * and spending no token; on, `requestGasSeed` makes the check first.
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
  gasSeed?: GasSeedDeps,
): void {
  // On every POST door, the abandon and refresh doors included: they read no body, and still
  // bound what a caller may send them. A declared length over the limit is refused before a byte
  // is read.
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

  // Both link doors check the real human first themselves, and read anything but the fields they
  // define as missing: each field is then refused by its own rule.
  app.post("/legal-body-orders/:id/link-message", limit, (c) =>
    door("link_message", async () => {
      const body = (await readJson(c)) as { agentId?: unknown; ttlSeconds?: unknown } | null;
      return c.json(
        await linkMessage(deps, c.get("tenantId"), c.req.param("id"), {
          agentId: body?.agentId as string,
          ttlSeconds: body?.ttlSeconds as number | undefined,
        }),
      );
    }),
  );

  app.post("/legal-body-orders/:id/link", limit, (c) =>
    door("link", async () => {
      const body = (await readJson(c)) as { message?: unknown; signature?: unknown } | null;
      const result = await submitLinkAndCreate(deps, c.get("tenantId"), c.req.param("id"), {
        message: body?.message,
        signature: body?.signature as Hex,
      });
      if (result.status === "refused")
        return c.json(
          {
            code: result.code,
            message: refusedLinkSentence(result.code, result.order),
            detail: result.detail,
            order: result.order,
          },
          422,
        );
      return c.json(result.order, result.status === "reserved" ? 202 : 200);
    }),
  );

  // `readBinding` makes the real-human check first itself.
  app.get("/legal-body-orders/:id/binding", (c) =>
    door("binding", () => c.json(readBinding(deps, c.get("tenantId"), c.req.param("id")))),
  );

  app.post("/legal-body-orders/:id/binding/refresh", limit, (c) =>
    door("binding_refresh", async () => {
      const tenantId = realHuman(c.get("tenantId"));
      takeDoorTokens(deps, tenantId);
      return c.json(await refreshBinding(deps, tenantId, c.req.param("id")));
    }),
  );

  // `requestGasSeed` makes every check itself, the off check first. It reads no body.
  if (gasSeed)
    app.post("/legal-body-orders/:id/gas-seed", limit, (c) =>
      door("gas_seed", async () =>
        c.json(await requestGasSeed(gasSeed, c.get("tenantId"), c.req.param("id"))),
      ),
    );
}

/**
 * One refresh of the tenant's order, under the order's lock, the one the sweeper takes: one
 * resolver pass for a `reserved` order, one binding check for any other (a row with no body is
 * answered without a chain call), then the view of the row as that pass left it. Both passes
 * answer `unknown` when the chain could not answer, having moved nothing but the row's schedule:
 * that is the 503 `chain_unavailable`. A row of another factory or chain is read-only here: 409
 * `other_deployment`, with no chain call.
 */
async function refreshBinding(
  deps: LegalBodyOrderDeps,
  tenantId: AuthVars["tenantId"],
  id: string,
): Promise<BindingView> {
  // Read once before the lock: an id that is not the tenant's order never gets a lock of its own.
  const owned = requireOwnedOrder(deps, tenantId, id);
  const orderId = owned.legalBodyId;
  return withKeyedLock(orderLockKey(orderId), async () => {
    const row = requireOwnedOrder(deps, tenantId, orderId);
    assertThisDeployment(deps, row);
    const outcome =
      row.bindingState === "reserved"
        ? await resolveOrder(deps, orderId)
        : await checkBinding(deps, orderId);
    if (outcome === "unknown") throw refusal("chain_unavailable", 503);
    return readBinding(deps, tenantId, orderId);
  });
}
