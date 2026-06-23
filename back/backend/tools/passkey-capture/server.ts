import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";

/** A guardian passkey attestation captured from the browser — mirrors GuardianPasskey. */
export interface CapturedPasskey {
  challenge: string;
  attestation: {
    credentialId: string;
    clientDataJson: string;
    attestationObject: string;
    transports: string[];
  };
}

/** Validate the posted body has the exact GuardianPasskey shape. Returns null if valid, else an error message. */
export function validateCapturedPasskey(body: unknown): string | null {
  if (!body || typeof body !== "object") return "body must be an object";
  const b = body as Record<string, unknown>;
  if (typeof b.challenge !== "string" || !b.challenge) return "missing or invalid field: challenge";
  const a = b.attestation as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return "missing or invalid field: attestation";
  for (const f of ["credentialId", "clientDataJson", "attestationObject"] as const) {
    if (typeof a[f] !== "string" || !a[f]) return `missing or invalid field: attestation.${f}`;
  }
  if (!Array.isArray(a.transports) || !a.transports.every((t) => typeof t === "string"))
    return "missing or invalid field: attestation.transports";
  return null;
}

export interface CaptureAppOptions {
  /** directory containing index.html + the built capture.js */
  staticDir: string;
  /** where POST /capture writes the captured passkey */
  fixturePath: string;
}

export function buildCaptureApp(opts: CaptureAppOptions) {
  const app = new Hono();

  app.get("/", (c) => {
    try {
      return c.html(readFileSync(join(opts.staticDir, "index.html"), "utf8"));
    } catch {
      return c.text(`index.html not found in ${opts.staticDir}`, 500);
    }
  });

  app.get("/capture.js", (c) => {
    try {
      return c.body(readFileSync(join(opts.staticDir, "capture.js"), "utf8"), 200, {
        "content-type": "application/javascript; charset=utf-8",
      });
    } catch {
      return c.text(
        `capture.js not found in ${opts.staticDir} — run "npm run passkey:capture" to build it`,
        500,
      );
    }
  });

  app.post("/capture", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const err = validateCapturedPasskey(body);
    if (err) return c.json({ error: err }, 400);

    mkdirSync(dirname(opts.fixturePath), { recursive: true });
    writeFileSync(opts.fixturePath, `${JSON.stringify(body, null, 2)}\n`);
    return c.json({ ok: true, path: opts.fixturePath });
  });

  return app;
}
