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

test("validateCapturedPasskey rejects non-string transports", () => {
  const bad = {
    challenge: "c",
    attestation: {
      credentialId: "id",
      clientDataJson: "j",
      attestationObject: "a",
      transports: [1, null],
    },
  };
  expect(validateCapturedPasskey(bad)).toMatch(/transports/);
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
