# Per-Agent Vault — Live Provisioning Test (passkey-capture tool) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a real WebAuthn guardian passkey from a browser and use it to provision one real Turnkey sub-org via `provisionAgentVault`, proving the per-agent vault flow works against live Turnkey.

**Architecture:** A throwaway dev tool under `backend/tools/passkey-capture/` (a tiny Hono server + a browser page that calls Turnkey's `getWebAuthnAttestation`) writes a gitignored fixture file. A gated `provisioner.live.test.ts` reads that fixture and calls the already-built `provisionAgentVault`. Nothing in `src/` changes — this is purely additive.

**Tech Stack:** TypeScript (ESM, Node ≥20.18), Hono + `@hono/node-server`, `@turnkey/http` (`getWebAuthnAttestation`, already installed), `@turnkey/sdk-server`, esbuild 0.28.0 (bundles the browser entry), vitest, biome.

## Global Constraints

Every task's requirements implicitly include these (copied from the design):

- **Additive only — no `src/` changes.** New code lives in `backend/tools/passkey-capture/` and `backend/test/`. The only edits to existing files are config plumbing: `backend/package.json` (one script), `backend/.gitignore` (two ignores), `backend/biome.json` (one ignore).
- **Use Turnkey's `getWebAuthnAttestation`** (from `@turnkey/http`) for the attestation — no hand-rolled WebAuthn/base64url encoding.
- **The live test is gated.** It runs only when ALL of: `process.env.LIVE_TURNKEY === "1"`, the fixture file exists, and `cfg.turnkey.delegatedApiPublicKey` is set. Otherwise it `describe.skip`s with a message. Free-tier Turnkey is metered.
- **Fixture contract** = exactly `GuardianPasskey`: `{ challenge: string, attestation: { credentialId: string, clientDataJson: string, attestationObject: string, transports: string[] } }`.
- **Capture server:** Hono on `http://localhost:8899` (override via `PORT`). WebAuthn `rpId: "localhost"` (WebAuthn requires a secure context = `http://localhost`).
- **Secret/artifact hygiene.** The fixture (`test/fixtures/*.local.json`) and the built bundle (`tools/passkey-capture/capture.js`) are gitignored — never committed.
- **Quality gate per task:** `npm run typecheck` + `npm run lint` clean; `npx vitest run --exclude '**/*.live.test.ts'` green. Commit at the end of each task. All commands run from `backend/`.
- **WSL2 note:** the page is authenticator-agnostic; on WSL2 use Chrome DevTools' **virtual authenticator** (WebAuthn tab) — no hardware needed.

## File structure

| File | Responsibility |
|---|---|
| `backend/tools/passkey-capture/server.ts` (create) | `buildCaptureApp(opts)` Hono factory + `validateCapturedPasskey` — serves the page, validates + writes the fixture. The tested unit. |
| `backend/tools/passkey-capture/main.ts` (create) | Entry point: builds the app with real paths + `serve()` on 8899. Run by the npm script via tsx. |
| `backend/tools/passkey-capture/index.html` (create) | Minimal page: one button + status line; loads `/capture.js`. |
| `backend/tools/passkey-capture/capture.entry.ts` (create) | Browser entry (esbuild-bundled): `getWebAuthnAttestation` → `POST /capture`. Not typechecked by tsc (outside `include`). |
| `backend/tools/passkey-capture/capture.js` | esbuild output — **gitignored**, never edited by hand. |
| `backend/test/tools/passkey-capture.server.test.ts` (create) | Deterministic unit test for `validateCapturedPasskey` + `POST /capture`. |
| `backend/test/adapters/turnkey/provisioner.live.test.ts` (modify) | Replace the stub: gated live provision + assertions. |
| `backend/test/fixtures/guardian-passkey.local.json` | Runtime capture output — **gitignored**. |
| `backend/package.json` (modify) | Add `passkey:capture` script. |
| `backend/.gitignore` (modify) | Ignore `test/fixtures/*.local.json` and `tools/passkey-capture/capture.js`. |
| `backend/biome.json` (modify) | Ignore `tools/passkey-capture/capture.js`. |

**Why `server.ts` is typechecked but `main.ts`/`capture.entry.ts` are not:** tsconfig `include` is `["src","scripts","test","vitest.config.ts"]`. `server.ts` is pulled into the tsc program because the unit test (in `test/`) imports it. `main.ts` (Node entry) and `capture.entry.ts` (browser/DOM) are only run by tsx/esbuild respectively and are not imported by any included file, so their non-Node/entry concerns never reach tsc. This is intentional and needs no tsconfig change.

---

### Task 1: Capture server — `buildCaptureApp` + validation + unit test

**Files:**
- Create: `backend/tools/passkey-capture/server.ts`
- Test: `backend/test/tools/passkey-capture.server.test.ts`

**Interfaces:**
- Produces:
  - `export interface CapturedPasskey { challenge: string; attestation: { credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] } }`
  - `export function validateCapturedPasskey(body: unknown): string | null` — returns `null` if valid, else an error message.
  - `export interface CaptureAppOptions { staticDir: string; fixturePath: string }`
  - `export function buildCaptureApp(opts: CaptureAppOptions)` — a Hono app with `GET /`, `GET /capture.js`, `POST /capture`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tools/passkey-capture.server.test.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildCaptureApp, validateCapturedPasskey } from "../../tools/passkey-capture/server";

const validBody = {
  challenge: "Y2hhbA",
  attestation: {
    credentialId: "Y2lk",
    clientDataJson: "Y2Rq",
    attestationObject: "YXR0",
    transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
  },
};

function tmpFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "passkey-capture-"));
  return join(dir, "guardian-passkey.local.json");
}

test("validateCapturedPasskey accepts a well-formed passkey", () => {
  expect(validateCapturedPasskey(validBody)).toBeNull();
});

test("validateCapturedPasskey rejects a missing attestation field", () => {
  const bad = {
    challenge: "c",
    attestation: { credentialId: "id", clientDataJson: "j", transports: [] },
  };
  expect(validateCapturedPasskey(bad)).toMatch(/attestationObject/);
});

test("POST /capture writes the fixture and returns ok", async () => {
  const fixturePath = tmpFixture();
  const app = buildCaptureApp({ staticDir: "tools/passkey-capture", fixturePath });
  const res = await app.request("/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
  expect(JSON.parse(readFileSync(fixturePath, "utf8"))).toEqual(validBody);
});

test("POST /capture rejects a malformed body with 400 and does not write", async () => {
  const fixturePath = tmpFixture();
  const app = buildCaptureApp({ staticDir: "tools/passkey-capture", fixturePath });
  const res = await app.request("/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: "c" }),
  });
  expect(res.status).toBe(400);
  expect(existsSync(fixturePath)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/tools/passkey-capture.server.test.ts`
Expected: FAIL — cannot find module `../../tools/passkey-capture/server`.

- [ ] **Step 3: Implement the server**

```ts
// backend/tools/passkey-capture/server.ts
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
  if (!Array.isArray(a.transports)) return "missing or invalid field: attestation.transports";
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

  app.get("/", (c) => c.html(readFileSync(join(opts.staticDir, "index.html"), "utf8")));

  app.get("/capture.js", (c) =>
    c.body(readFileSync(join(opts.staticDir, "capture.js"), "utf8"), 200, {
      "content-type": "application/javascript; charset=utf-8",
    }),
  );

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/tools/passkey-capture.server.test.ts`
Expected: PASS (4 tests). Then `npm run typecheck && npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add backend/tools/passkey-capture/server.ts backend/test/tools/passkey-capture.server.test.ts
git commit -m "feat(passkey-capture): Hono capture server + fixture validation"
```

---

### Task 2: Browser page + entry + wiring (build the tool)

**Files:**
- Create: `backend/tools/passkey-capture/index.html`
- Create: `backend/tools/passkey-capture/capture.entry.ts`
- Create: `backend/tools/passkey-capture/main.ts`
- Modify: `backend/package.json` (add script)
- Modify: `backend/biome.json` (ignore `capture.js`)
- Modify: `backend/.gitignore` (ignore fixture + bundle)

**Interfaces:**
- Consumes: `buildCaptureApp` from Task 1.
- Produces: `npm run passkey:capture` — bundles `capture.entry.ts` → `capture.js` then serves on `http://localhost:8899`. No code consumes these; this task's deliverable is "the tool builds and boots."

- [ ] **Step 1: Create the page** — `backend/tools/passkey-capture/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Guardian Passkey Capture</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
      button { font-size: 1rem; padding: 0.6rem 1rem; cursor: pointer; }
      #status { margin-top: 1rem; white-space: pre-wrap; }
      .ok { color: #157f3b; }
      .err { color: #b00020; }
    </style>
  </head>
  <body>
    <h1>Guardian Passkey Capture</h1>
    <p>Creates one real WebAuthn passkey and saves its attestation for the live provisioning test.</p>
    <button id="create">Create guardian passkey</button>
    <div id="status"></div>
    <script type="module" src="/capture.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the browser entry** — `backend/tools/passkey-capture/capture.entry.ts`

```ts
// backend/tools/passkey-capture/capture.entry.ts
// Browser entry — bundled by esbuild to capture.js. Not typechecked by tsc (outside tsconfig include).
import { getWebAuthnAttestation } from "@turnkey/http";

const statusEl = document.getElementById("status") as HTMLDivElement;
const btn = document.getElementById("create") as HTMLButtonElement;

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  statusEl.className = "";
  statusEl.textContent = "Waiting for authenticator…";
  try {
    const challenge = randomBytes(32);
    const userId = randomBytes(16);
    const attestation = await getWebAuthnAttestation({
      publicKey: {
        rp: { id: "localhost", name: "Agent Vault Guardian" },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        user: { id: userId, name: "guardian@local", displayName: "Guardian" },
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        timeout: 60000,
      },
    });

    const payload = { challenge: base64url(challenge), attestation };
    const res = await fetch("/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `capture failed (${res.status})`);
    statusEl.className = "ok";
    statusEl.textContent = `Saved attestation to:\n${json.path}\n\nYou can close this tab and run the live test.`;
  } catch (e) {
    statusEl.className = "err";
    statusEl.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    btn.disabled = false;
  }
});
```

- [ ] **Step 3: Create the entry point** — `backend/tools/passkey-capture/main.ts`

```ts
// backend/tools/passkey-capture/main.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { buildCaptureApp } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "test", "fixtures", "guardian-passkey.local.json");

const app = buildCaptureApp({ staticDir: here, fixturePath });
const port = Number(process.env.PORT ?? 8899);
serve({ fetch: app.fetch, port });
console.log(`Passkey capture on http://localhost:${port}  (writes ${fixturePath})`);
```

- [ ] **Step 4: Add the npm script** — in `backend/package.json`, add to `"scripts"` (after `"onboarding"`):

```json
    "passkey:capture": "esbuild tools/passkey-capture/capture.entry.ts --bundle --format=esm --platform=browser --outfile=tools/passkey-capture/capture.js && tsx tools/passkey-capture/main.ts"
```

- [ ] **Step 5: Add ignores**

In `backend/.gitignore`, append:

```
test/fixtures/*.local.json
tools/passkey-capture/capture.js
```

In `backend/biome.json`, change the `files.ignore` array to include the bundle:

```json
  "files": { "ignore": ["dist", "data", "src/abis/generated.ts", "node_modules", "tools/passkey-capture/capture.js"] },
```

- [ ] **Step 6: Build the bundle to verify it compiles**

Run: `cd backend && npx esbuild tools/passkey-capture/capture.entry.ts --bundle --format=esm --platform=browser --outfile=tools/passkey-capture/capture.js`
Expected: exits 0, prints a summary line, and `tools/passkey-capture/capture.js` now exists.
Verify: `test -f tools/passkey-capture/capture.js && echo BUNDLE_OK`
Expected: `BUNDLE_OK`.

> If esbuild reports an unresolved Node built-in from `@turnkey/http`, add `--external:crypto` and retry. The attestation path uses only Web Crypto (`crypto.subtle`/`getRandomValues`), which exists in the browser.

- [ ] **Step 7: Verify the gates stay clean**

Run: `cd backend && npm run typecheck && npm run lint`
Expected: both clean. (`capture.entry.ts` is outside tsc's `include`; `capture.js` is biome-ignored; `server.ts`/`main.ts` are valid Node TS.)

- [ ] **Step 8: Manual boot smoke (one-time, not CI)**

Run: `cd backend && npm run passkey:capture`
Expected: prints `Passkey capture on http://localhost:8899 …`. Open `http://localhost:8899` in a browser (on WSL2, the Windows browser reaches it via localhost forwarding; use Chrome DevTools → WebAuthn → "Add virtual authenticator" if no real authenticator). Confirm the page + button render. Stop with Ctrl-C. (The actual passkey click is exercised in Task 3's live verification.)

- [ ] **Step 9: Commit**

```bash
git add backend/tools/passkey-capture/index.html backend/tools/passkey-capture/capture.entry.ts \
        backend/tools/passkey-capture/main.ts backend/package.json backend/.gitignore backend/biome.json
git commit -m "feat(passkey-capture): browser page + entry + passkey:capture script"
```

---

### Task 3: Flesh out the live provisioning test

**Files:**
- Modify: `backend/test/adapters/turnkey/provisioner.live.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (`src/config/env.ts`), `buildTurnkeyProvisionDeps` (`src/adapters/turnkey/clients.ts`), `provisionAgentVault` (`src/adapters/turnkey/provisioner.ts`), and the gitignored fixture `test/fixtures/guardian-passkey.local.json`.
- Produces: nothing (terminal test).

- [ ] **Step 1: Replace the stub with the gated live test**

```ts
// backend/test/adapters/turnkey/provisioner.live.test.ts
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildTurnkeyProvisionDeps } from "../../../src/adapters/turnkey/clients";
import { provisionAgentVault } from "../../../src/adapters/turnkey/provisioner";
import { loadConfig } from "../../../src/config/env";

const FIXTURE = fileURLToPath(new URL("../../fixtures/guardian-passkey.local.json", import.meta.url));

// loadConfig throws if required env is missing — tolerate that while deciding whether to gate.
const cfg = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();

const gated =
  process.env.LIVE_TURNKEY === "1" && existsSync(FIXTURE) && !!cfg?.turnkey?.delegatedApiPublicKey;

const run = gated ? describe : describe.skip;

// To run live: `npm run passkey:capture`, click the button, then
// `LIVE_TURNKEY=1 npx vitest run test/adapters/turnkey/provisioner.live.test.ts`
run("live Turnkey provisioning (creates a throwaway sub-org)", () => {
  test("provisionAgentVault returns guardian-root + sign-only delegated vault ids", async () => {
    const config = loadConfig();
    const deps = buildTurnkeyProvisionDeps(config);
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

    const ids = await provisionAgentVault(deps, {
      subOrgName: `live-test agent vault ${Date.now()}`,
      guardianPasskey: fixture,
      delegatedApiPublicKey: config.turnkey?.delegatedApiPublicKey ?? "",
    });

    expect(ids.subOrgId).toBeTruthy();
    expect(ids.walletId).toBeTruthy();
    expect(ids.guardianUserId).toBeTruthy();
    expect(ids.delegatedUserId).toBeTruthy();
    expect(ids.operator).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Read-back (belt-and-suspenders): the delegated client can see the wallet it will sign for.
    const wallets = await deps.makeDelegatedClient(ids.subOrgId).getWallets({
      organizationId: ids.subOrgId,
    });
    const found = wallets.wallets.find((w: { walletId: string }) => w.walletId === ids.walletId);
    expect(found).toBeTruthy();
  }, 60_000);
});
```

> If the installed `@turnkey/sdk-server` returns `getWallets()` under a different field than `wallets`, adjust the read-back accordingly (or drop it) — the primary proof is the `VaultIds` return, which already implies all three Turnkey steps ran (each throws on rejection).

- [ ] **Step 2: Verify it skips cleanly when gated off**

Run: `cd backend && npx vitest run test/adapters/turnkey/provisioner.live.test.ts`
Expected: PASS with the suite reported **skipped** (0 failures) — `LIVE_TURNKEY` is unset, so `describe.skip` is used.

- [ ] **Step 3: Verify the deterministic suite stays green**

Run: `cd backend && npx vitest run --exclude '**/*.live.test.ts'`
Expected: all green (the live test is excluded by the glob; nothing in `src/` changed).
Then: `npm run typecheck && npm run lint` → clean.

- [ ] **Step 4: Commit**

```bash
git add backend/test/adapters/turnkey/provisioner.live.test.ts
git commit -m "test(turnkey): live per-agent vault provisioning from a captured passkey"
```

- [ ] **Step 5: Live verification (manual — the definition of done)**

This is the actual proof-of-life; it needs a human passkey gesture + real Turnkey creds in `.env` (parent `TURNKEY_*` + the delegated keypair, both already present).

```bash
cd backend
npm run passkey:capture           # serves http://localhost:8899
# open the page, click "Create guardian passkey" (Windows Hello / security key /
#   Chrome DevTools virtual authenticator). Confirm "Saved attestation to …". Ctrl-C.
LIVE_TURNKEY=1 npx vitest run test/adapters/turnkey/provisioner.live.test.ts
```

Expected: 1 test passes — a real sub-org `live-test agent vault <ts>` is created with a guardian-root passkey + a sign-only delegated key, and the assertions hold. Record the resulting `subOrgId` in the project notes. (Throwaway sub-orgs accumulate under the parent org; Turnkey's API can't delete them — this is the documented trade-off.)

**Plan gate:** `tsc` + `biome` clean; `npx vitest run --exclude '**/*.live.test.ts'` green; no `src/` changes; the fixture + bundle gitignored. With a captured passkey, `LIVE_TURNKEY=1` provisioning creates one real per-agent vault and passes.

---

## Self-Review

- **Spec coverage:**
  - Capture tool (page + server + one-click auto-capture) → Tasks 1 + 2.
  - Bundle Turnkey's `getWebAuthnAttestation` via esbuild → Task 2 (Steps 2, 6).
  - Fixture contract = `GuardianPasskey`, gitignored → Task 1 (validation/write) + Task 2 (Step 5 ignores).
  - Gated live provisioner test (provisioner-only scope) + assertions + read-back → Task 3.
  - Error handling (browser/server/test skip-loudly) → Task 2 (entry try/catch), Task 1 (400 validation), Task 3 (`describe.skip` gating).
  - Deterministic unit test for `POST /capture` → Task 1.
  - Known trade-offs (throwaway sub-orgs; manual capture step) → Task 3 Step 5 note + Global Constraints.
  - Definition of done (page boots; `LIVE_TURNKEY=1` passes; gates green; artifacts ignored) → Task 3 Step 5 + Plan gate.
- **Placeholder scan:** none — every code/HTML/JSON block is complete; the two `>` notes are concrete contingencies (esbuild `--external:crypto`; `getWallets` field name), not deferred work.
- **Type consistency:** `CaptureAppOptions { staticDir, fixturePath }` is used identically in the test, `server.ts`, and `main.ts`. `validateCapturedPasskey(body): string | null` matches its test (`toBeNull()` / `toMatch(...)`). The fixture shape (`challenge` + `attestation.{credentialId,clientDataJson,attestationObject,transports}`) is identical across the validator, the browser payload, and the live test's `provisionAgentVault` call. `provisionAgentVault(deps, { subOrgName, guardianPasskey, delegatedApiPublicKey })` → `VaultIds { subOrgId, walletId, operator, guardianUserId, delegatedUserId }` matches the committed provisioner.
- **Scope check:** single subsystem (one dev tool + one test); one plan is correct.
