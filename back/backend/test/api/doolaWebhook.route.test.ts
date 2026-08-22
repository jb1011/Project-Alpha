/**
 * The inbound doola webhook receiver (design §6, threat model §10).
 *
 * The properties under test are the ones that keep the endpoint both trustworthy and ALIVE:
 * every signature failure is the same 401 and never a 500 (a 500 spends one of doola's five
 * strikes AND looks like our bug), a stale envelope is a 200 (a clock-skewed box must not
 * re-disable an endpoint it just came back from), a redelivery is one row and one task, and an
 * event we cannot map is kept rather than dropped.
 */
import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import {
  DOOLA_SIGNATURE_HEADER,
  type DoolaWakeUp,
  WEBHOOK_MAX_BODY_BYTES,
  decodeSignature,
  parseEnvelope,
  providerRefOf,
  verifyDoolaSignature,
} from "../../src/api/routes/doolaWebhook";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { TaskTracker } from "../../src/util/taskTracker";

const SECRET = "whsec_current";
const PREVIOUS = "whsec_previous";
const NOW = Date.parse("2026-08-21T12:00:00Z");

let db: Database.Database;
let events: SqliteDoolaEventRepository;
let tasks: TaskTracker;
let seen: DoolaWakeUp[];
let processFails: boolean;

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    // MILLISECONDS. A seconds assumption rejects everything doola sends.
    timestamp: NOW - 1000,
    eventPayload: { doolaCompanyId: "cmp-1" },
    ...over,
  });
}

function app(over: Record<string, unknown> = {}) {
  return buildApiApp({
    webOrigin: "https://app.example.com",
    repo: new SqliteEntityRepository(db),
    now: () => NOW,
    doola: {
      environment: "sandbox",
      webhookSecret: SECRET,
      webhookSecretPrevious: PREVIOUS,
      events,
      tasks,
      process: async (w: DoolaWakeUp) => {
        seen.push(w);
        if (processFails) throw new Error("doola unreachable");
      },
      ...over,
    },
  } as never);
}

async function post(
  body: string,
  opts: { signature?: string; env?: string; headers?: Record<string, string> } = {},
  appOver: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.signature === undefined ? {} : { [DOOLA_SIGNATURE_HEADER]: opts.signature }),
    ...opts.headers,
  };
  return await app(appOver).request(`/webhooks/doola/${opts.env ?? "sandbox"}`, {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  events = new SqliteDoolaEventRepository(db);
  tasks = new TaskTracker("doola_webhook_task");
  seen = [];
  processFails = false;
});
afterEach(() => db.close());

const rows = () =>
  db.prepare("SELECT * FROM doola_webhook_events").all() as Record<string, unknown>[];

// ── the happy path ─────────────────────────────────────────────────────────────────────────

test("a correctly signed event: 200, one row, one wake-up carrying ids ONLY", async () => {
  const body = envelope();
  const res = await post(body, { signature: sign(body) });
  expect(res.status).toBe(200);
  await tasks.settled();

  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({
    event_id: "evt-1",
    event_name: "company_formation_completed",
    provider_ref: "cmp-1",
    // The envelope is kept verbatim for forensics — and read by nothing.
    payload: body,
  });
  // H2: the handler is given ids, never the payload. There is no path from the wire to a fact.
  expect(seen).toEqual([
    { eventId: "evt-1", eventName: "company_formation_completed", providerRef: "cmp-1" },
  ]);
});

test("the PREVIOUS secret also verifies — that is what makes rotation zero-downtime", async () => {
  const body = envelope();
  expect((await post(body, { signature: sign(body, PREVIOUS) })).status).toBe(200);
  await tasks.settled();
  expect(seen).toHaveLength(1);
});

test("the signature header is matched case-insensitively and tolerates upper-case hex", async () => {
  const body = envelope();
  const res = await post(body, {
    headers: { "X-DOOLA-SIGNATURE": sign(body).toUpperCase() },
  });
  expect(res.status).toBe(200);
});

// ── every rejection is the SAME 401, and never a 500 ───────────────────────────────────────

test("bad / missing / short / wrong-length / wrong-secret signatures ALL give one constant 401", async () => {
  const body = envelope();
  const good = sign(body);
  const cases: Record<string, string | undefined> = {
    missing: undefined,
    empty: "",
    "non-hex": "zz".repeat(32),
    // Decodes fine but is the wrong LENGTH — the case that makes timingSafeEqual THROW, and
    // would therefore be a 500 without the explicit length check (audit M2).
    short: good.slice(0, 32),
    long: `${good}00`,
    "odd-length": good.slice(0, 63),
    "wrong-mac": sign(body, "whsec_attacker"),
    "right-mac-wrong-body": sign(`${body} `),
  };

  const bodies = new Set<string>();
  for (const [name, signature] of Object.entries(cases)) {
    const res = await post(body, { signature });
    expect(res.status, name).toBe(401);
    bodies.add(await res.text());
  }
  // ONE body across every failure mode: the endpoint is not an oracle for which check failed.
  expect(bodies.size).toBe(1);
  expect([...bodies][0]).toContain("invalid signature");
  // Nothing was persisted and nothing was scheduled.
  expect(rows()).toHaveLength(0);
  expect(seen).toHaveLength(0);
});

test("a body that is not JSON but IS correctly signed never reaches JSON.parse as a 500", async () => {
  // The signature covers the RAW bytes, so the body is read as text and verified before any
  // parse. A verified-but-unparsable body is doola's, so it gets a 200 (spending a strike on
  // something we have already authenticated would be self-harm), and persists nothing.
  const body = "<html>gateway error</html>";
  const res = await post(body, { signature: sign(body) });
  expect(res.status).toBe(200);
  expect(rows()).toHaveLength(0);
  // An envelope missing the dedupe key is the same story.
  const noId = JSON.stringify({ eventName: "company_formation_completed" });
  expect((await post(noId, { signature: sign(noId) })).status).toBe(200);
  expect(rows()).toHaveLength(0);
});

// ── the environment path (audit M4) ────────────────────────────────────────────────────────

test("a request on the WRONG environment path is a 404, before any signature work", async () => {
  const body = envelope();
  // Correctly signed, but this deployment is sandbox: a portal pointed at the wrong environment
  // must look like a wrong URL, not like a secret problem.
  expect((await post(body, { signature: sign(body), env: "production" })).status).toBe(404);
  expect((await post(body, { signature: sign(body), env: "staging" })).status).toBe(404);
  expect(rows()).toHaveLength(0);
});

test("a deployment with no doola block does not mount the route at all", async () => {
  const bare = buildApiApp({
    webOrigin: "https://app.example.com",
    repo: new SqliteEntityRepository(db),
  } as never);
  const body = envelope();
  const res = await bare.request("/webhooks/doola/sandbox", {
    method: "POST",
    headers: { [DOOLA_SIGNATURE_HEADER]: sign(body) },
    body,
  });
  expect(res.status).toBe(404);
});

// ── size, staleness, dedupe ────────────────────────────────────────────────────────────────

test("an oversized body is refused with 413 (a size refusal is not a signature verdict)", async () => {
  const big = JSON.stringify({ eventId: "evt-1", pad: "x".repeat(WEBHOOK_MAX_BODY_BYTES) });
  // Correctly signed, so the refusal is provably about SIZE and not about the MAC.
  const res = await post(big, { signature: sign(big) });
  expect(res.status).toBe(413);
  expect(rows()).toHaveLength(0);
});

test("a declared Content-Length over the cap is refused before a byte is buffered", async () => {
  const body = envelope();
  const res = await post(body, {
    signature: sign(body),
    headers: { "content-length": String(WEBHOOK_MAX_BODY_BYTES + 1) },
  });
  expect(res.status).toBe(413);
});

test("a stale envelope answers 200 — a 4xx would help doola auto-disable us", async () => {
  // 49h old: past the 48h bound that clears doola's ~37.3h retry ladder.
  const body = envelope({ timestamp: NOW - 49 * 60 * 60 * 1000 });
  const res = await post(body, { signature: sign(body) });
  expect(res.status).toBe(200);
  // Persisted nothing: a stale event is noted and dropped, not queued for the sweeper.
  expect(rows()).toHaveLength(0);
  expect(seen).toHaveLength(0);
});

test("a timestamp in SECONDS is treated as ancient — proving the unit is milliseconds", async () => {
  const body = envelope({ timestamp: Math.floor(NOW / 1000) });
  expect((await post(body, { signature: sign(body) })).status).toBe(200);
  expect(rows()).toHaveLength(0);
});

test("an envelope with NO timestamp is accepted (the bound cannot judge what is not there)", async () => {
  const body = envelope({ timestamp: undefined });
  expect((await post(body, { signature: sign(body) })).status).toBe(200);
  expect(rows()).toHaveLength(1);
});

test("a redelivered event id: 200 every time, ONE row, ONE processing task", async () => {
  const body = envelope();
  for (let i = 0; i < 5; i++) {
    // doola's ladder: 1m / 15m / 1h / 12h / 24h.
    expect((await post(body, { signature: sign(body) })).status).toBe(200);
  }
  await tasks.settled();
  expect(rows()).toHaveLength(1);
  expect(seen).toHaveLength(1);
});

// ── the unmappable event ───────────────────────────────────────────────────────────────────

test("an event whose company id maps to nothing is PERSISTED with processed_at NULL", async () => {
  // The receiver does not know whether a ref maps — the processor does, and it leaves the row
  // unprocessed so the sweeper can re-drive it once `create_provider` lands the ref.
  const body = envelope({ eventPayload: { doolaCompanyId: "cmp-not-yet-known" } });
  expect((await post(body, { signature: sign(body) })).status).toBe(200);
  await tasks.settled();
  expect(rows()[0]).toMatchObject({ provider_ref: "cmp-not-yet-known", processed_at: null });
});

test("an event carrying no company id at all is persisted with a NULL ref", async () => {
  const body = envelope({ eventName: "partner_webhook_disabled", eventPayload: { reason: "x" } });
  expect((await post(body, { signature: sign(body) })).status).toBe(200);
  await tasks.settled();
  expect(rows()[0]).toMatchObject({ provider_ref: null, event_name: "partner_webhook_disabled" });
});

test("a processing failure still leaves the 200 and the row for the sweeper", async () => {
  processFails = true;
  const body = envelope();
  expect((await post(body, { signature: sign(body) })).status).toBe(200);
  // The tracker swallows the rejection: an unhandled one would take the API down on an outage.
  await expect(tasks.settled()).resolves.toBe(true);
  expect(rows()[0]).toMatchObject({ processed_at: null });
});

// ── the pure helpers ───────────────────────────────────────────────────────────────────────

test("decodeSignature accepts hex (and a sha256= prefix), refuses everything else", () => {
  expect(decodeSignature("ab".repeat(32))).toHaveLength(32);
  expect(decodeSignature(`sha256=${"ab".repeat(32)}`)).toHaveLength(32);
  expect(decodeSignature("AB".repeat(32))).toHaveLength(32);
  for (const bad of ["", "a", "zz", "ab cd", "abc", `0x${"ab".repeat(32)}`])
    expect(decodeSignature(bad), bad).toBeUndefined();
  // Surrounding whitespace is tolerated — a header value is not a secret's shape. A hex string
  // of the WRONG DIGEST LENGTH still decodes here and is refused by the explicit length check in
  // `verifyDoolaSignature`, which is where that comparison belongs.
  expect(decodeSignature(" ab ")).toHaveLength(1);
  expect(verifyDoolaSignature("{}", "ab", [SECRET])).toBe(false);
});

test("verifyDoolaSignature never throws, whatever it is handed", () => {
  const body = "{}";
  expect(() => verifyDoolaSignature(body, undefined, [SECRET])).not.toThrow();
  expect(verifyDoolaSignature(body, undefined, [SECRET])).toBe(false);
  expect(verifyDoolaSignature(body, "ab", [SECRET])).toBe(false);
  expect(verifyDoolaSignature(body, sign(body), [undefined, SECRET])).toBe(true);
  expect(verifyDoolaSignature(body, sign(body), [undefined, undefined])).toBe(false);
});

test("providerRefOf reads the documented key first, then the fallbacks, then gives up", () => {
  expect(providerRefOf({ doolaCompanyId: "a", companyId: "b" })).toBe("a");
  expect(providerRefOf({ companyId: "b" })).toBe("b");
  expect(providerRefOf({ company_id: " c " })).toBe("c");
  // Nothing company-id-shaped: no guessing at other fields, ever.
  expect(providerRefOf({ ein: "12-3456789", name: "Acme LLC" })).toBeNull();
  expect(providerRefOf(null)).toBeNull();
  expect(providerRefOf("cmp-1")).toBeNull();
  expect(providerRefOf({ doolaCompanyId: 42 })).toBeNull();
});

test("parseEnvelope keeps the four permitted fields and nothing else", () => {
  const env = parseEnvelope(
    JSON.stringify({
      eventId: "e",
      eventName: "n",
      timestamp: 1,
      eventPayload: { doolaCompanyId: "c", ein: "12-3456789", formationFilingDate: "2026-08-01" },
    }),
  );
  // The EIN and the filing date are RIGHT THERE in the payload and the envelope carries neither.
  expect(env).toEqual({ eventId: "e", eventName: "n", timestamp: 1, providerRef: "c" });
});
