import { expect, test } from "vitest";
import { buildOnboardingApp } from "../../src/onboarding/server";

/** The address the server forces into `roles.manager` — the controller, in controller mode. */
const PLATFORM_MANAGER = "0x4819bd1e7f5F1e2b0e07A2E4f3d0B3E1C2A4f6e0";

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
    platformManagerAddress: PLATFORM_MANAGER,
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
    platformManagerAddress: PLATFORM_MANAGER,
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
    platformManagerAddress: PLATFORM_MANAGER,
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

/**
 * The THIRD onboarding door (NoviController design §3/§5).
 *
 * The REST door (api/routes/onboard.ts) and the MCP door (mcp/server.ts) both force
 * `roles.manager` to the platform manager identity. This standalone server used to pass the
 * caller's spec through verbatim — which in controller mode means the factory's M4 check
 * (`manager == owner()`) rejects every onboarding that came through here.
 */
test("POST /onboard forces roles.manager to the platform manager identity", async () => {
  let captured: { roles?: { manager?: string; guardian?: string } } | undefined;
  const app = buildOnboardingApp({
    runOnboarding: async (spec) => {
      captured = spec as never;
      return {
        status: "funded",
        turnkeySubOrgId: "s1",
        turnkeyWalletId: "w1",
        operator: "0x00000000000000000000000000000000000000ab",
      } as never;
    },
    platformManagerAddress: PLATFORM_MANAGER,
  });
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // A caller nominating ITSELF as manager — the exact spec that would mint a rogue-managed
      // body in Novi's registry namespace if the server honored it.
      spec: {
        name: "Agent",
        roles: { manager: "0x00000000000000000000000000000000deadbeef", guardian: "0xg" },
      },
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
  expect(captured?.roles?.manager).toBe(PLATFORM_MANAGER);
  // Only the manager is server-owned here; the rest of the caller's roles survive.
  expect(captured?.roles?.guardian).toBe("0xg");
});

test("POST /onboard sets roles.manager even when the spec carries no roles at all", async () => {
  let captured: { roles?: { manager?: string } } | undefined;
  const app = buildOnboardingApp({
    runOnboarding: async (spec) => {
      captured = spec as never;
      return {
        status: "funded",
        turnkeySubOrgId: "s1",
        turnkeyWalletId: "w1",
        operator: "0x00000000000000000000000000000000000000ab",
      } as never;
    },
    platformManagerAddress: PLATFORM_MANAGER,
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
  expect(res.status).toBe(200);
  expect(captured?.roles?.manager).toBe(PLATFORM_MANAGER);
});
