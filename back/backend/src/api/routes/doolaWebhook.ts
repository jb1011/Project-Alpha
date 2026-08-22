import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { opsLog } from "../../observability/opsLog";
import { readCappedText } from "../../util/readStreamCapped";
import type { DoolaWakeUp } from "../../workflow/formationProcessor";
import type { ApiDeps } from "../app";

/**
 * `POST /webhooks/doola/{sandbox|production}` — the first INBOUND webhook in the codebase
 * (design 2026-08-19 §6, threat model §10).
 *
 * Two structural decisions carry most of the security here, and both are worth stating before the
 * code:
 *
 *  1. **A webhook is a WAKE-UP SIGNAL, never a source of facts** (audit H2). This module reads
 *     exactly four things out of a verified envelope — `eventId`, `eventName`, `timestamp`, and
 *     the company id used to find the entity — and nothing else. Every fact the processor writes
 *     is re-fetched from doola's API over TLS with our own API key. A leaked webhook secret
 *     therefore buys an attacker a redundant poll, not a fact write.
 *  2. **The endpoint must be hard to disable.** doola auto-disables an endpoint after five
 *     consecutive failures, and a disabled endpoint has to be re-enabled by hand in their portal.
 *     So the failure modes are chosen to avoid 4xx wherever a 4xx would be self-harm: a stale
 *     timestamp (a clock-skewed box, or a backlog delivered after a re-enable) answers **200**,
 *     and a `timingSafeEqual` length mismatch — which THROWS — is checked for explicitly rather
 *     than allowed to become a 500 (audit M2/M3).
 *
 * Per-ENVIRONMENT paths (audit M4) so a rotation, or the mainnet flip, can never mix signature
 * domains: a request whose path environment is not this deployment's is a 404, full stop.
 *
 * The route is mounted on the PUBLIC side and takes the backend origin DIRECTLY
 * (`https://api.novicorpus.com/webhooks/doola/<env>`): the Vercel proxy does not forward the
 * signature header, so a portal pointed at the proxy would fail every delivery.
 */

/**
 * The signature header and its encoding, as ONE exported constant each.
 *
 * doola issues the secret by email and documents the digest as a hex-encoded HMAC-SHA256 of the
 * raw request body. Header lookup is case-insensitive (Hono normalizes, and HTTP/2 lower-cases
 * anyway), and the value is lower-cased before it is compared to our own hex.
 *
 * ⚠ DEPLOY-TIME CHECKLIST ITEM: this PR cannot receive a real webhook before it ships, so the
 * exact live format is pinned against the FIRST real sandbox event after deploy — see
 * `docs/runbooks/doola-webhooks.md`. If doola's live header turns out to carry a `sha256=`
 * prefix or base64, this constant and `decodeSignature` are the two places that change.
 */
/** What the receiver hands the processor — defined by the PROCESSOR (it is the consumer,
 *  and `src/workflow` may not import from `src/api`) and re-exported here for the receiver's own
 *  callers. Note what is NOT in it: the payload. */
export type { DoolaWakeUp };

export const DOOLA_SIGNATURE_HEADER = "x-doola-signature";
export const DOOLA_SIGNATURE_ENCODING = "hex" as const;

/** The first body-size control in this API — nothing else provides one (audit M1). doola's
 *  largest legitimate envelope is a few kilobytes. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * How old an envelope may be. doola's retry ladder spans ~37.3h cumulative
 * (1m/15m/1h/12h/24h, per-previous-attempt), so 48h clears it with ~10.7h of slack.
 * `timestamp` is Unix epoch **MILLISECONDS** (fact-checked; a seconds assumption rejects
 * everything doola sends).
 */
export const WEBHOOK_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** ONE body for every rejection, so no failure path is distinguishable from another. */
const UNAUTHORIZED_BODY = { error: { code: "unauthorized", message: "invalid signature" } };
const NOT_FOUND_BODY = { error: { code: "not_found", message: "not found" } };
const TOO_LARGE_BODY = { error: { code: "payload_too_large", message: "payload too large" } };
const OK_BODY = { ok: true };

export interface DoolaWebhookDeps {
  environment: "sandbox" | "production";
  webhookSecret: string;
  /** Set during a rotation window; both are verified so rotation is zero-downtime. */
  webhookSecretPrevious?: string;
  events: import("../../persistence/doolaEventRepository").DoolaEventRepository;
  /** Where the acked-then-deferred work is remembered (SIGTERM drain + test join point). */
  tasks: import("../../util/taskTracker").TaskTracker;
  /** The wake-up handler. Given ids only — never the payload (audit H2). Its result is the
   *  processor's, and the receiver ignores it: the ack has already gone out. */
  process: (wake: DoolaWakeUp) => Promise<unknown>;
}

/**
 * Decode a signature header into raw digest bytes, or undefined when it is not a hex digest.
 *
 * `Buffer.from(s, "hex")` silently truncates at the first invalid pair — "zz" decodes to an empty
 * buffer rather than failing — so the shape is validated BEFORE decoding. An odd-length string
 * and a non-hex character are both simply "not a signature".
 */
export function decodeSignature(header: string): Buffer | undefined {
  const v = header.trim().toLowerCase();
  // Tolerated because it is the single most common variation across webhook providers, and the
  // live format is not pinned until the first real event after deploy. Documented in the runbook.
  const hex = v.startsWith("sha256=") ? v.slice("sha256=".length) : v;
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  return Buffer.from(hex, DOOLA_SIGNATURE_ENCODING);
}

/**
 * Constant-time verification against the current secret and, during a rotation, the previous one.
 *
 * The explicit length check is not decoration: `timingSafeEqual` THROWS on a length mismatch, and
 * an uncaught throw here would be a 500 — which doola counts toward the five-strike auto-disable
 * exactly like a 401, except it also looks like our bug in every dashboard (audit M2).
 */
export function verifyDoolaSignature(
  rawBody: string,
  header: string | undefined,
  secrets: (string | undefined)[],
): boolean {
  if (!header) return false;
  const provided = decodeSignature(header);
  if (!provided) return false;
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    if (provided.length !== expected.length) continue;
    // No early return: both secrets are always evaluated during a rotation window so the time
    // taken does not reveal WHICH secret matched.
    if (timingSafeEqual(provided, expected)) ok = true;
  }
  return ok;
}

/** The envelope, reduced to the four fields §5 permits a wake-up to carry. */
export interface DoolaEnvelope {
  eventId: string;
  eventName: string;
  /** Unix epoch MILLISECONDS. */
  timestamp: number | null;
  providerRef: string | null;
}

/**
 * The company-id keys we will look for, in preference order.
 *
 * `doolaCompanyId` is doola's documented spelling and the one every response type uses. The rest
 * are fallbacks for a payload shape we have not seen yet — a wake-up we cannot map is not lost
 * (it waits in `doola_webhook_events`), but it costs a sweeper cycle, so the fallbacks are cheap
 * insurance. This is the ONLY value read out of `eventPayload`, anywhere.
 */
const COMPANY_ID_KEYS = ["doolaCompanyId", "companyId", "doola_company_id", "company_id"] as const;

export function providerRefOf(eventPayload: unknown): string | null {
  if (typeof eventPayload !== "object" || eventPayload === null) return null;
  const p = eventPayload as Record<string, unknown>;
  for (const k of COMPANY_ID_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Parse a VERIFIED body. Returns null when it is not an envelope we can key on. */
export function parseEnvelope(rawBody: string): DoolaEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  const eventId = typeof e.eventId === "string" ? e.eventId.trim() : "";
  const eventName = typeof e.eventName === "string" ? e.eventName.trim() : "";
  // Without an id there is no dedupe key, and dedupe is the only thing standing between doola's
  // retry ladder and five copies of the same work.
  if (!eventId || !eventName) return null;
  const ts = typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? e.timestamp : null;
  return { eventId, eventName, timestamp: ts, providerRef: providerRefOf(e.eventPayload) };
}

/** The receiver's own overflow signal. Never leaves this module: the route turns it into a 413. */
class WebhookTooLargeError extends Error {}

/**
 * Read the body under a running byte cap, on the shared capped reader (M4).
 *
 * Read as TEXT, before any JSON parse: the signature covers the RAW bytes, so re-serializing a
 * parsed object would verify a different string than the one doola signed. Returns `undefined`
 * when the cap is exceeded — a size refusal is a 413 here, not a signature verdict.
 */
async function readCappedBody(c: Context, max: number): Promise<string | undefined> {
  try {
    return await readCappedText(
      {
        body: c.req.raw.body as ReadableStream<Uint8Array> | null | undefined,
        contentLength: c.req.header("content-length"),
        // No stream (an empty body, or a hand-rolled Request in a test): there is nothing to
        // meter, so read it and let the shared reader check the result.
        readAll: async () => Buffer.from(await c.req.text(), "utf8"),
      },
      max,
      { declared: () => new WebhookTooLargeError(), streamed: () => new WebhookTooLargeError() },
    );
  } catch (e) {
    if (e instanceof WebhookTooLargeError) return undefined;
    throw e;
  }
}

/**
 * Mount the receiver. Called from the PUBLIC block of `buildApiApp`, behind `if (deps.doola)` —
 * a deployment with no doola credentials has no such route at all, and answers 404.
 */
export function mountDoolaWebhookRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: ApiDeps & { doola: DoolaWebhookDeps },
) {
  const d = deps.doola;
  const now = () => (deps.now ?? Date.now)();

  app.post("/webhooks/doola/:environment", async (c) => {
    // ── 0. Environment path (audit M4). Checked first because it is the cheapest refusal and
    //       because a portal pointed at the wrong environment must look like a wrong URL, not
    //       like a signature problem an operator will spend an afternoon on.
    const pathEnv = c.req.param("environment");
    if (pathEnv !== d.environment) return c.json(NOT_FOUND_BODY, 404);

    // ── 1. Size. 413 rather than the constant 401, deliberately: a size refusal is not a
    //       signature verdict, and conflating them would hide a misconfigured sender behind
    //       "your secret is wrong". doola's own envelopes are kilobytes, so this can only fire
    //       for something that is not doola. Documented in the runbook.
    const raw = await readCappedBody(c, WEBHOOK_MAX_BODY_BYTES);
    if (raw === undefined) {
      opsLog("doola_webhook_oversize", { level: "warn", environment: d.environment });
      return c.json(TOO_LARGE_BODY, 413);
    }

    // ── 2. Signature over the RAW body. Every failure — missing header, bad hex, wrong length,
    //       wrong MAC — is the same constant 401, so the endpoint is not an oracle for any of
    //       them, and none of them can become a 500.
    const header = c.req.header(DOOLA_SIGNATURE_HEADER);
    if (!verifyDoolaSignature(raw, header, [d.webhookSecret, d.webhookSecretPrevious])) {
      // No detail: "which" failure is exactly what an attacker probing the endpoint wants, and
      // an operator gets the answer from the runbook's rotation checklist instead.
      opsLog("doola_webhook_unauthorized", { level: "warn", environment: d.environment });
      return c.json(UNAUTHORIZED_BODY, 401);
    }

    // ── 3. Envelope. From here on the request is PROVEN to be doola's, so every remaining exit
    //       is a 200: a 4xx would spend one of five strikes on something we already trust.
    const env = parseEnvelope(raw);
    if (!env) {
      opsLog("doola_webhook_unparsable", { level: "warn", environment: d.environment });
      return c.json(OK_BODY, 200);
    }

    // Stale → 200 + WARN, NEVER 4xx (audit M3): a clock-skewed box or a backlog delivered after
    // a manual re-enable must not re-disable the endpoint it just came back from.
    const age = env.timestamp === null ? null : now() - env.timestamp;
    if (age !== null && age > WEBHOOK_MAX_AGE_MS) {
      opsLog("doola_webhook_stale", {
        level: "warn",
        environment: d.environment,
        eventId: env.eventId,
        eventName: env.eventName,
        ageMs: age,
      });
      return c.json(OK_BODY, 200);
    }

    // ── 4. Dedupe. The whole envelope is persisted for forensics; nothing downstream reads it.
    const fresh = d.events.record({
      eventId: env.eventId,
      eventName: env.eventName,
      providerRef: env.providerRef,
      payload: raw,
    });
    if (!fresh) {
      opsLog("doola_webhook_duplicate", {
        environment: d.environment,
        eventId: env.eventId,
        eventName: env.eventName,
      });
      return c.json(OK_BODY, 200);
    }

    opsLog("doola_webhook_received", {
      environment: d.environment,
      eventId: env.eventId,
      eventName: env.eventName,
      providerRef: env.providerRef,
    });

    // ── 5. Ack now, work after. The task is TRACKED so SIGTERM can drain it and tests can join
    //       on it; a failure leaves `processed_at` NULL and the sweeper re-drives it.
    d.tasks.track(() =>
      d.process({
        eventId: env.eventId,
        eventName: env.eventName,
        providerRef: env.providerRef,
      }),
    );
    return c.json(OK_BODY, 200);
  });
}
