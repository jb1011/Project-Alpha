import { expect, test } from "vitest";
import { buildOnboardingApp } from "../../src/onboarding/server";

test("POST /onboard provisions + returns the vault ids", async () => {
  const app = buildOnboardingApp({
    runOnboarding: async () => ({
      status: "funded",
      turnkeySubOrgId: "s1",
      turnkeyWalletId: "w1",
      operator: "0x00000000000000000000000000000000000000ab",
    }),
  } as never);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "Agent" },
      guardianPasskey: {
        challenge: "c",
        attestation: {
          credentialId: "id",
          clientDataJson: "j",
          attestationObject: "a",
          transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    subOrgId: "s1",
    walletId: "w1",
    operator: "0x00000000000000000000000000000000000000ab",
    status: "funded",
  });
});

test("POST /onboard returns 400 when body is missing spec", async () => {
  const app = buildOnboardingApp({
    runOnboarding: async () => ({
      status: "funded",
      turnkeySubOrgId: "s1",
      turnkeyWalletId: "w1",
      operator: "0xab",
    }),
  } as never);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guardianPasskey: { challenge: "c" } }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: expect.any(String) });
});

test("POST /onboard returns 502 when runOnboarding throws", async () => {
  const app = buildOnboardingApp({
    runOnboarding: async () => {
      throw new Error("provision failed");
    },
  } as never);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "Agent" },
      guardianPasskey: {
        challenge: "c",
        attestation: {
          credentialId: "id",
          clientDataJson: "j",
          attestationObject: "a",
          transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
        },
      },
    }),
  });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: expect.any(String) });
});

test("POST /onboard passes idempotencyKey from body when provided", async () => {
  let capturedIdempotencyKey: string | undefined;
  const app = buildOnboardingApp({
    runOnboarding: async (_spec, _passkey, idempotencyKey) => {
      capturedIdempotencyKey = idempotencyKey;
      return {
        status: "funded",
        turnkeySubOrgId: "s1",
        turnkeyWalletId: "w1",
        operator: "0x00000000000000000000000000000000000000ab",
      } as never;
    },
  });
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "Agent" },
      guardianPasskey: {
        challenge: "c",
        attestation: {
          credentialId: "id",
          clientDataJson: "j",
          attestationObject: "a",
          transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
        },
      },
      idempotencyKey: "my-custom-key",
    }),
  });
  expect(res.status).toBe(200);
  expect(capturedIdempotencyKey).toBe("my-custom-key");
});

test("POST /onboard defaults idempotencyKey to spec.name when not provided", async () => {
  let capturedIdempotencyKey: string | undefined;
  const app = buildOnboardingApp({
    runOnboarding: async (_spec, _passkey, idempotencyKey) => {
      capturedIdempotencyKey = idempotencyKey;
      return {
        status: "funded",
        turnkeySubOrgId: "s1",
        turnkeyWalletId: "w1",
        operator: "0x00000000000000000000000000000000000000ab",
      } as never;
    },
  });
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "MyAgent" },
      guardianPasskey: {
        challenge: "c",
        attestation: {
          credentialId: "id",
          clientDataJson: "j",
          attestationObject: "a",
          transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  expect(capturedIdempotencyKey).toBe("MyAgent");
});

test("POST /onboard returns 502 when guardianPasskey provided but vault ids are missing", async () => {
  const app = buildOnboardingApp({
    runOnboarding: async () =>
      ({
        status: "created",
        turnkeySubOrgId: undefined,
        turnkeyWalletId: undefined,
        operator: "0x00000000000000000000000000000000000000ab",
      }) as never,
  });
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: { name: "Agent" },
      guardianPasskey: {
        challenge: "c",
        attestation: {
          credentialId: "id",
          clientDataJson: "j",
          attestationObject: "a",
          transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
        },
      },
    }),
  });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: "provisioning did not complete" });
});
