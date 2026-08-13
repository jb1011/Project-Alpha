import { createHash, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import {
  type WorldIdConfig,
  WorldIdError,
  makeRpContext,
  startGuardianVerification,
  verifyAttestation,
  verifyProof,
} from "../../adapters/worldid/guardianGate";
import { type AuthVars, requireAuth } from "../../auth/middleware";
import type { WorldStore } from "../../persistence/worldStore";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

export interface WorldIdDeps {
  cfg: WorldIdConfig & { attestAction?: string };
  /** Age threshold requested by the step-up. */
  attestMinAge: number;
  store: WorldStore;
  /** Absent = no ceiling on legal entities per human. */
  maxEntitiesPerHuman?: number;
  requireGuardian: boolean;
}

const REQUEST_TTL_MS = 10 * 60_000;

/** Why a World verification was refused. The backend logs nothing per-request, so when a scan
 *  failed in the field we could not tell whether the proof had even reached us — only that the
 *  user saw an error on their phone. Log the reason (never the nullifier; tenant truncated). */
/**
 * ⚠ `expires_at_min` is NOT a credential expiry — do not gate on it.
 *
 * Measured against three real production verifications (2026-07-25/26/29), the value is
 * consistently 19–44 seconds BEFORE the moment we record the verification:
 *
 *   verified_at 2026-07-29T09:36:09Z   expires_at_min*1000 2026-07-29T09:35:26Z   (+44s)
 *   verified_at 2026-07-26T10:07:12Z   expires_at_min*1000 2026-07-26T10:06:53Z   (+19s)
 *   verified_at 2026-07-25T16:10:30Z   expires_at_min*1000 2026-07-25T16:10:02Z   (+29s)
 *
 * So it tracks the proof's own short-lived validity window, not how long the human's credential
 * remains good. Read as seconds, every credential is "expired" on arrival — gating on it would
 * refuse 100% of guardians. Read as minutes (the original code) it is the year 5363, i.e. it
 * never fires, which is why nobody noticed. Neither reading is a credential lifetime.
 *
 * We therefore store the raw value for forensics and gate on nothing until World clarifies the
 * field's meaning. Raised with them alongside the other AgentKit findings.
 */

function logWorldRejection(kind: string, tenantId: string, detail: string): void {
  console.warn(`world-id ${kind} refused for ${tenantId.slice(0, 10)}…: ${detail}`);
}

/**
 * Guardian proof-of-personhood gate. Server-driven idkit-core flow so it works for BOTH the web
 * wizard and MCP-first onboarding (the client only needs to display/scan `connectorURI`).
 *
 * POST /world-id/request      -> { requestId, connectorURI }  (authed; binds to the caller's tenant)
 * GET  /world-id/status/:id   -> { status, verified?, nullifier?, entitiesUsed? }
 *
 * The nullifier is the only identity datum stored: stable per (human, rp, action) and unlinkable
 * across apps, so it proves uniqueness without identifying anyone.
 */
export function mountWorldIdRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  const world = deps.worldId;
  if (!world) return;

  // In-flight bridge polls, keyed by requestId. Kept in-process: a restart just means the client
  // re-requests (the DB row is the durable record, and verification itself is one-shot).
  const pending = new Map<
    string,
    Promise<{ success: boolean; result?: unknown; error?: unknown }>
  >();

  app.post("/world-id/request", requireAuth(deps.jwtSecret), async (c) => {
    const tenantId = c.get("tenantId");
    const started = await startGuardianVerification(world.cfg, tenantId);
    const now = Date.now();
    world.store.createRequest({
      requestId: started.requestId,
      tenantId,
      action: world.cfg.action,
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
    });
    // Swallow rejections here; /status surfaces them (an unhandled rejection would crash the process).
    pending.set(
      started.requestId,
      started.completion.catch((e) => ({ success: false, error: String(e) })),
    );
    return c.json({
      requestId: started.requestId,
      connectorURI: started.connectorURI,
      action: world.cfg.action,
      environment: world.cfg.environment,
    });
  });

  app.get("/world-id/status/:requestId", requireAuth(deps.jwtSecret), async (c) => {
    const tenantId = c.get("tenantId");
    const requestId = c.req.param("requestId");
    const row = world.store.getRequest(requestId);
    if (!row || row.tenantId !== tenantId)
      throw new ApiError("not_found", 404, "verification request not found");

    if (row.status === "verified" || row.status === "failed")
      return c.json({ status: row.status, detail: row.detail });

    const completion = pending.get(requestId);
    if (!completion) return c.json({ status: "pending", detail: "awaiting World App approval" });

    // Non-blocking peek: resolved -> process; still pending -> tell the client to poll again.
    const settled = await Promise.race([
      completion.then((v) => ({ done: true as const, v })),
      Promise.resolve({ done: false as const, v: undefined }),
    ]);
    if (!settled.done) return c.json({ status: "pending" });

    pending.delete(requestId);
    const outcome = settled.v;
    if (!outcome?.success) {
      const detail = String(outcome?.error ?? "verification not completed");
      world.store.updateRequest(requestId, "failed", detail);
      return c.json({ status: "failed", detail });
    }

    try {
      const proof = await verifyProof(world.cfg, outcome.result, tenantId);
      // Sybil gate: this human may already be bound to a DIFFERENT tenant.
      const stored = world.store.recordVerification({
        nullifier: proof.nullifier,
        action: world.cfg.action,
        tenantId,
        issuerSchemaId: proof.issuerSchemaId,
        credential: proof.credential,
        environment: proof.environment,
        verifiedAt: Date.now(),
        expiresAtMin: proof.expiresAtMin,
      });
      if (!stored) {
        world.store.updateRequest(requestId, "failed", "human already bound to another tenant");
        throw new ApiError(
          "human_already_bound",
          409,
          "this human is already the guardian of another account",
        );
      }
      world.store.updateRequest(requestId, "verified", proof.credential);
      return c.json({
        status: "verified",
        credential: proof.credential,
        nullifier: proof.nullifier,
        entitiesUsed: world.store.countEntitiesForNullifier(proof.nullifier, world.cfg.action),
        maxEntities: world.maxEntitiesPerHuman,
      });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const detail = e instanceof WorldIdError ? `${e.code}: ${e.message}` : String(e);
      world.store.updateRequest(requestId, "failed", detail);
      throw new ApiError("verification_failed", 400, detail);
    }
  });

  // ── Browser flow ────────────────────────────────────────────────────────────────────────────
  // IDKit is designed to run client-side: the browser creates the request and produces the proof,
  // and the server only verifies it. Verification is a plain HTTPS call to World — no WASM — which
  // also keeps the web path free of the Node/WASM constraints of the headless (MCP) flow above.

  /** Everything the browser widget needs, including the v4-mandatory signed request context. */
  app.get("/world-id/context", requireAuth(deps.jwtSecret), (c) => {
    const tenantId = c.get("tenantId");
    return c.json({
      appId: world.cfg.appId,
      action: world.cfg.action,
      environment: world.cfg.environment,
      // Bound into the proof as its signal and re-checked in verifyProof, so a proof minted for
      // one account cannot be replayed to verify another.
      signal: tenantId,
      rpContext: makeRpContext(world.cfg),
    });
  });

  /** Verify a proof produced by the browser widget, then apply our sybil gate + cap. */
  app.post("/world-id/verify", requireAuth(deps.jwtSecret), async (c) => {
    const tenantId = c.get("tenantId");
    let body: { proof?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (!body.proof) throw new ApiError("validation_error", 400, "proof is required");

    let proof: Awaited<ReturnType<typeof verifyProof>>;
    try {
      proof = await verifyProof(world.cfg, body.proof, tenantId);
    } catch (e) {
      const detail = e instanceof WorldIdError ? `${e.code}: ${e.message}` : String(e);
      logWorldRejection("verify", tenantId, detail);
      throw new ApiError("verification_failed", 400, detail);
    }

    const existing = world.store.findByNullifier(proof.nullifier, world.cfg.action);
    if (existing && existing.tenantId !== tenantId) {
      logWorldRejection("verify", tenantId, "human already bound to another tenant");
      throw new ApiError(
        "human_already_bound",
        409,
        "this human is already the guardian of another account",
      );
    }

    world.store.recordVerification({
      nullifier: proof.nullifier,
      action: world.cfg.action,
      tenantId,
      issuerSchemaId: proof.issuerSchemaId,
      credential: proof.credential,
      environment: proof.environment,
      verifiedAt: Date.now(),
      expiresAtMin: proof.expiresAtMin,
    });
    return c.json({
      status: "verified",
      credential: proof.credential,
      nullifier: proof.nullifier,
      entitiesUsed: world.store.countEntitiesForNullifier(proof.nullifier, world.cfg.action),
      maxEntities: world.maxEntitiesPerHuman,
    });
  });

  // ── Guardian waiver ──────────────────────────────────────────────────────────────────────────
  // The escape hatch for humans with NO World ID path: no Orb in their country AND a passport
  // outside World's ~12-country credential list (France is the canonical case — Orb operations
  // ended there in 2023). Codes are admin-issued via the CLI, single-use, and recorded as
  // credential "waiver" so nothing downstream can mistake access for verification: the metadata
  // block publishes humanVerified: false for waived guardians.
  app.post("/world-id/waiver", requireAuth(deps.jwtSecret), async (c) => {
    const tenantId = c.get("tenantId");
    let body: { code?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.code !== "string" || !body.code.trim())
      throw new ApiError("validation_error", 400, "code is required");

    // A real verification outranks a waiver; never overwrite one (recordVerification would
    // upsert this tenant's row only if the nullifier matched, but refusing early keeps /me
    // reporting the stronger credential and makes the mistake visible to the caller).
    if (world.store.findByTenant(tenantId, world.cfg.action))
      throw new ApiError("already_verified", 409, "this account already has a guardian on record");

    const codeHash = createHash("sha256").update(body.code.trim()).digest("hex");
    const redeemed = world.store.redeemWaiver(codeHash, tenantId, Date.now());
    if (!redeemed) {
      // Unknown, used, expired, and revoked are deliberately one answer: a waiver code is a
      // bearer secret, and distinguishing states would let anyone probe issued codes.
      logWorldRejection("waiver", tenantId, "code not redeemable");
      throw new ApiError("waiver_invalid", 404, "this waiver code cannot be redeemed");
    }

    const nullifier = `waiver:${codeHash}`;
    world.store.recordVerification({
      nullifier,
      action: world.cfg.action,
      tenantId,
      issuerSchemaId: null,
      credential: "waiver",
      environment: null,
      verifiedAt: Date.now(),
      expiresAtMin: null,
    });
    console.warn(`world-id waiver redeemed by ${tenantId.slice(0, 10)}… (${redeemed.note})`);
    return c.json({
      status: "verified",
      credential: "waiver",
      nullifier,
      entitiesUsed: world.store.countEntitiesForNullifier(nullifier, world.cfg.action),
      maxEntities: world.maxEntitiesPerHuman,
    });
  });

  // ── Identity Check step-up ───────────────────────────────────────────────────────────────────
  // Optional, and deliberately not a gate: World's document credentials cover ~12 countries, so
  // requiring one would lock out most of Europe (including this project's own founder).

  /** Guard shared by both step-up routes: unmounted without config, and never an entry point. */
  const attestPreconditions = (tenantId: string) => {
    const action = world.cfg.attestAction;
    if (!action) throw new ApiError("not_found", 404, "identity attestation is not configured");
    if (!world.store.findByTenant(tenantId, world.cfg.action))
      throw new ApiError(
        "guardian_not_verified",
        403,
        "verify as a guardian before adding an attestation",
      );
    return action;
  };

  app.get("/world-id/attest/context", requireAuth(deps.jwtSecret), (c) => {
    const tenantId = c.get("tenantId");
    const action = attestPreconditions(tenantId);
    return c.json({
      appId: world.cfg.appId,
      action,
      environment: world.cfg.environment,
      signal: tenantId,
      // The v4 request signature covers the ACTION, so this must be minted for the step-up action.
      rpContext: makeRpContext(world.cfg, action),
      minAge: world.attestMinAge,
    });
  });

  app.post("/world-id/attest/verify", requireAuth(deps.jwtSecret), async (c) => {
    const tenantId = c.get("tenantId");
    const action = attestPreconditions(tenantId);
    let body: { proof?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (!body.proof) throw new ApiError("validation_error", 400, "proof is required");

    let attested: Awaited<ReturnType<typeof verifyAttestation>>;
    try {
      attested = await verifyAttestation(
        { ...world.cfg, action },
        body.proof,
        world.attestMinAge,
        tenantId,
      );
    } catch (e) {
      const detail = e instanceof WorldIdError ? `${e.code}: ${e.message}` : String(e);
      logWorldRejection("attestation", tenantId, detail);
      throw new ApiError("attestation_failed", 400, detail);
    }

    const stored = world.store.recordAttestation({
      nullifier: attested.nullifier,
      action,
      tenantId,
      minAge: attested.minAge,
      credential: attested.credential,
      issuerSchemaId: attested.issuerSchemaId,
      verifiedAt: Date.now(),
      expiresAtMin: attested.expiresAtMin,
    });
    if (!stored)
      throw new ApiError(
        "human_already_bound",
        409,
        "this human already holds an attestation on another account",
      );

    return c.json({ status: "attested", minAge: attested.minAge, credential: attested.credential });
  });

  // ── AgentBook standing for an agent (W9.3) ─────────────────────────────────────────────────
  // Answers "does a verified human publicly answer for this agent's wallet?" — a live World
  // Chain read through the positive-only cache. Registration itself happens in World App (the
  // human scans); we only ever read.
  app.get("/entities/:id/agentbook", requireAuth(deps.jwtSecret), async (c) => {
    const id = c.req.param("id");
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    const ak = deps.x402Demo?.agentkit;
    if (!ak) throw new ApiError("not_found", 404, "AgentBook reads are not configured");
    const operator = rec.operator;
    if (!operator) return c.json({ registered: false, reason: "no-operator-yet" });

    let humanId = ak.store.getCachedHuman(operator, Date.now(), 10 * 60_000);
    if (!humanId) {
      try {
        const { createAgentBookVerifier } = await import("@worldcoin/agentkit");
        const verifier = createAgentBookVerifier({
          ...(ak.worldChainRpc ? { rpcUrl: ak.worldChainRpc } : {}),
          ...(ak.agentBookAddress ? { contractAddress: ak.agentBookAddress } : {}),
          // biome-ignore lint/suspicious/noExplicitAny: options typing varies across SDK versions.
        } as any);
        const looked = await verifier.lookupHuman(operator);
        if (looked && !/^0x0*$/.test(looked) && looked !== "0") {
          humanId = looked;
          ak.store.cacheHuman(operator, humanId, Date.now());
        }
      } catch {
        // SDK swallows RPC errors into null; either way: unknown -> report unregistered,
        // never throw — this is a status chip, not a gate.
      }
    }
    return c.json(
      humanId
        ? { registered: true, humanId, operator }
        : {
            registered: false,
            operator,
            register: `npx @worldcoin/agentkit-cli register ${operator}`,
          },
    );
  });

  // Current guardian-verification state for the caller's tenant (drives UI + the onboarding gate).
  app.get("/world-id/me", requireAuth(deps.jwtSecret), (c) => {
    const tenantId = c.get("tenantId");
    const attestAvailable = Boolean(world.cfg.attestAction);
    const v = world.store.findByTenant(tenantId, world.cfg.action);
    if (!v) return c.json({ verified: false, required: world.requireGuardian, attestAvailable });
    return c.json({
      verified: true,
      required: world.requireGuardian,
      credential: v.credential,
      verifiedAt: v.verifiedAt,
      // The caller's own pseudonym. Safe to show them: it is scoped to this app and identifies
      // no one outside it — and seeing it is the point, it's the only datum we keep.
      nullifier: v.nullifier,
      entitiesUsed: world.store.countEntitiesForNullifier(v.nullifier, world.cfg.action),
      maxEntities: world.maxEntitiesPerHuman,
      attestAvailable,
      ...attestationView(tenantId),
    });
  });

  /** Attestation slice of /me. Absent when unconfigured or unattested; expiry demotes it. */
  const attestationView = (tenantId: string) => {
    const action = world.cfg.attestAction;
    if (!action) return { formationReady: false };
    const a = world.store.findAttestationByTenant(tenantId, action);
    // Deliberately not gated on expires_at_min — see the note above the imports.
    const live = Boolean(a);
    if (!a || !live) return { formationReady: false };
    return {
      formationReady: true,
      attestation: { minAge: a.minAge, credential: a.credential, verifiedAt: a.verifiedAt },
    };
  };
}

/** Onboarding gate: throws unless the tenant's guardian is a verified unique human under the cap.
 *  No-op when World isn't configured or enforcement is off — existing deployments are unaffected. */
export function assertGuardianAllowed(world: WorldIdDeps | undefined, tenantId: string): void {
  if (!world || !world.requireGuardian) return;
  const v = world.store.findByTenant(tenantId, world.cfg.action);
  if (!v)
    throw new ApiError(
      "guardian_not_verified",
      403,
      "guardian must complete World ID verification before creating a legal entity",
    );
  // The ceiling is optional: unset means a verified human may form as many legal bodies as they
  // like, which is what the law actually allows.
  if (world.maxEntitiesPerHuman == null) return;
  const used = world.store.countEntitiesForNullifier(v.nullifier, world.cfg.action);
  if (used >= world.maxEntitiesPerHuman)
    throw new ApiError(
      "guardian_entity_cap",
      403,
      `this human already controls ${used} legal entities (max ${world.maxEntitiesPerHuman})`,
    );
}
