import { CredentialRequest, IDKit, any as anyOf, hashSignal } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";

/** World ID config slice (mirrors Config["world"]). */
export interface WorldIdConfig {
  appId: string;
  rpId: string;
  rpSigningKey: string;
  action: string;
  environment: "production" | "staging" | "sandbox";
}

const VERIFY_HOST = "https://developer.world.org";

/** Credential identifiers acceptable for GUARDIANSHIP. A guardian is the legally accountable
 *  natural person, so we require Orb-grade uniqueness (v4 proof_of_human / v3 orb) or a
 *  government-document tier. Device/selfie tiers are rejected — they prove neither uniqueness
 *  nor identity strongly enough for a FinCEN-CDD-shaped role. */
const ACCEPTED_CREDENTIALS = new Set([
  "proof_of_human",
  "orb",
  "passport",
  "mnc",
  "secure_document",
  "document",
]);

/** The tiers the guardian request OFFERS in World App. Must stay a subset of
 *  ACCEPTED_CREDENTIALS: offering a tier the verifier refuses would let a human scan
 *  successfully on their phone and then be rejected here. */
const guardianConstraints = (signal: string) =>
  anyOf(
    CredentialRequest("proof_of_human", { signal }),
    CredentialRequest("passport", { signal }),
    CredentialRequest("mnc", { signal }),
  );

export class WorldIdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** v4 requires a signed rp_context on every request. camelCase -> snake_case is intentional.
 *  The signature covers the ACTION, so a request for a different action (e.g. the attestation
 *  step-up) must be signed for that action or World rejects it — hence the override. */
export function makeRpContext(cfg: WorldIdConfig, action: string = cfg.action) {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: cfg.rpSigningKey,
    action,
    ttl: 300,
  });
  return { rp_id: cfg.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig };
}

export interface StartedVerification {
  requestId: string;
  connectorURI: string;
  /** Resolves when the human approves/rejects in World App (or the bridge times out). */
  completion: Promise<{ success: boolean; result?: unknown; error?: unknown }>;
}

let fetchPatchedForWasm = false;

/**
 * WORKAROUND — @worldcoin/idkit-core@4.2.2 cannot initialize in plain Node.
 *
 * Its WASM loader resolves the bundled `idkit_wasm_bg.wasm` to a `file://` URL and then calls
 * `fetch()` on it. Browsers and bundlers handle that; Node's fetch does not support the file
 * scheme, so every request fails with "Failed to initialize IDKit WASM: TypeError: fetch failed".
 * `initIDKit()` takes no argument and isn't exported, so there is no supported way to hand it
 * the module.
 *
 * We install a narrow shim: `file://` URLs are read from disk and returned as a Response;
 * every other request is delegated to the original fetch untouched. Installed once, lazily,
 * and only on the Node path.
 */
export function ensureNodeWasmFetch(): void {
  if (fetchPatchedForWasm || typeof globalThis.fetch !== "function") return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url?.startsWith("file://")) {
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import("node:fs/promises"),
        import("node:url"),
      ]);
      const bytes = await readFile(fileURLToPath(url));
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/wasm" },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  fetchPatchedForWasm = true;
}

/** Open a World ID proof request. `signal` binds the tenant wallet into the proof. */
export async function startGuardianVerification(
  cfg: WorldIdConfig,
  tenantWallet: string,
): Promise<StartedVerification> {
  ensureNodeWasmFetch();
  const request = await IDKit.request({
    app_id: cfg.appId,
    action: cfg.action,
    rp_context: makeRpContext(cfg),
    allow_legacy_proofs: true,
    environment: cfg.environment,
    // biome-ignore lint/suspicious/noExplicitAny: SDK request config typing is loose across versions.
  } as any).constraints(guardianConstraints(tenantWallet));

  return {
    requestId: request.requestId,
    connectorURI: request.connectorURI,
    completion: request.pollUntilCompletion({
      pollInterval: 2_000,
      timeout: 300_000,
      // biome-ignore lint/suspicious/noExplicitAny: poll options typing varies by SDK version.
    } as any) as Promise<{ success: boolean; result?: unknown; error?: unknown }>,
  };
}

export interface VerifiedAttestation {
  nullifier: string;
  credential: string;
  /** The threshold WE asked to be proven — World does not echo attribute values back. */
  minAge: number;
  issuerSchemaId: number | null;
  expiresAtMin: number | null;
  raw: unknown;
}

/**
 * Identity Check step-up. Captured response shape (staging, 2026-07-25 — fixture at
 * test/world/fixtures/attest-verify-response.json):
 *
 *   verify response: { success, action, nullifier, created_at, environment, results:[{identifier,
 *                      success, nullifier}], message }      <- NO attribute echo, no identity_attested
 *   idkit result:    { action, environment, identity_attested, nonce, protocol_version,
 *                      responses:[{expires_at_min, identifier, issuer_schema_id, nullifier, ...}] }
 *
 * ⚠ TRUST LIMIT: `identity_attested` lives on the CLIENT payload, not on World's response, and the
 * verify endpoint returns nothing about which attributes were asserted. A client that requested no
 * attributes but set the flag is therefore indistinguishable from a genuine attestation at this
 * layer — World's own demo prescribes exactly this check, so it appears to assume the RP controls
 * the client, which is not true for a browser. We follow the prescribed rule and mark the
 * attestation as claim-grade: good enough to unlock guidance, NOT to stand in for real KYC at
 * filing time. Raised with the World team.
 *
 * What IS load-bearing: a mismatched assertion fails earlier, client-side — requesting an
 * impossible attribute returns `identity_attributes_not_matched` and never reaches us.
 */
export async function verifyAttestation(
  cfg: WorldIdConfig,
  idkitResult: unknown,
  minAge: number,
  expectedSignal: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedAttestation> {
  const client = idkitResult as {
    identity_attested?: boolean;
    responses?: { issuer_schema_id?: number; expires_at_min?: number }[];
  };
  if (client?.identity_attested !== true)
    throw new WorldIdError(
      "not_attested",
      "the proof carries no identity attestation (identity_attested is not true)",
    );

  const verified = await verifyProof(cfg, idkitResult, expectedSignal, fetchImpl);
  const item = (client.responses ?? [])[0];
  return {
    nullifier: verified.nullifier,
    credential: verified.credential,
    minAge,
    issuerSchemaId: item?.issuer_schema_id ?? verified.issuerSchemaId,
    expiresAtMin: item?.expires_at_min ?? verified.expiresAtMin,
    raw: verified.raw,
  };
}

export interface VerifiedProof {
  /** Decimal-normalized nullifier — the ONLY identity datum we store. */
  nullifier: string;
  credential: string;
  issuerSchemaId: number | null;
  environment: string | null;
  expiresAtMin: number | null;
  raw: unknown;
}

/** Forward the IDKit result AS-IS to the Developer Portal and enforce the credential tier.
 *  Sending the payload byte-for-byte matters — remapping it is the #1 cause of invalid_proof. */
/**
 * @param expectedSignal the value the proof MUST be bound to — the caller's tenant. World cannot
 *   check this for us: it never learns which signal we asked for, so a proof minted for one tenant
 *   verifies perfectly well when replayed under another unless we compare it ourselves.
 */
export async function verifyProof(
  cfg: WorldIdConfig,
  idkitResult: unknown,
  expectedSignal: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedProof> {
  const res = await fetchImpl(`${VERIFY_HOST}/api/v4/verify/${cfg.rpId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(idkitResult),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    code?: string;
    detail?: string;
    nullifier?: string;
    environment?: string;
    action?: string;
    results?: {
      identifier?: string;
      success?: boolean;
      nullifier?: string;
      code?: string;
      detail?: string;
    }[];
  };
  if (!res.ok || !body.success)
    throw new WorldIdError(
      body.code ?? "verify_failed",
      body.detail ?? `verify HTTP ${res.status}`,
    );

  // ── Bind the proof to THIS caller and THIS action ────────────────────────────────────────
  // World tells us the proof is genuine; it cannot tell us the proof was meant for us. Without
  // the two checks below, a proof obtained for another tenant — or for another action of the
  // same app, which yields a DIFFERENT nullifier for the same human — verifies here and defeats
  // the one-human-one-account rule.
  if (body.action != null && body.action !== cfg.action)
    throw new WorldIdError(
      "action_mismatch",
      `proof was issued for action "${body.action}", not "${cfg.action}"`,
    );

  const expectedHash = hashSignal(expectedSignal).toLowerCase();
  const signals = ((idkitResult as { responses?: { signal_hash?: string }[] })?.responses ?? [])
    .map((r) => r.signal_hash?.toLowerCase())
    .filter((h): h is string => Boolean(h));
  if (signals.length === 0)
    throw new WorldIdError("no_signal", "proof carries no signal_hash to bind it to this account");
  if (signals.some((h) => h !== expectedHash))
    throw new WorldIdError(
      "signal_mismatch",
      "proof was not issued for this account (signal mismatch)",
    );

  // 200 means at least one proof verified; pick the first successful result of an accepted tier.
  const ok = (body.results ?? []).filter((r) => r.success !== false);
  const accepted = ok.find((r) => r.identifier && ACCEPTED_CREDENTIALS.has(r.identifier));
  if (!accepted)
    throw new WorldIdError(
      "credential_not_accepted",
      `guardianship requires an Orb or document-grade credential; got ${
        ok.map((r) => r.identifier).join(",") || "none"
      }`,
    );

  const rawNullifier = accepted.nullifier ?? body.nullifier;
  if (!rawNullifier) throw new WorldIdError("no_nullifier", "verify response carried no nullifier");

  // Normalize to decimal: hex casing/parsing differences would otherwise defeat the dedupe.
  let nullifier: string;
  try {
    nullifier = BigInt(rawNullifier).toString(10);
  } catch {
    throw new WorldIdError("bad_nullifier", "nullifier is not a parseable integer");
  }

  const item = ((
    idkitResult as { responses?: { issuer_schema_id?: number; expires_at_min?: number }[] }
  )?.responses ?? [])[0];
  return {
    nullifier,
    credential: accepted.identifier as string,
    issuerSchemaId: item?.issuer_schema_id ?? null,
    environment: body.environment ?? null,
    expiresAtMin: item?.expires_at_min ?? null,
    raw: body,
  };
}
