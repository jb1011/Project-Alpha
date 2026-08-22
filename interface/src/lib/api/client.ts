import { API_URL } from "./config";
import type {
  AgentRun,
  AgentSpec,
  ApiErrorBody,
  ApiKeyView,
  AuthSession,
  BootstrapPackage,
  Capability,
  ConnectionPackage,
  EntityView,
  GuardianPasskey,
  JobView,
  PasskeyView,
  PublicConfig,
  ReputationView,
  TransparencyView,
  TreasuryView,
  WorldIdAttestContext,
  WorldIdContext,
  WorldIdMe,
  WorldIdRequestView,
  WorldIdStatusView,
} from "./types";
import { ApiError } from "./types";

type RequestOpts = {
  method?: string;
  token?: string;
  body?: unknown;
};

/**
 * The ONE error path for every response this client reads (M4).
 *
 * Both callers — the JSON `request` helper and the bytes-returning `downloadDocument` — need the
 * identical treatment of a failure: prefer the backend's own `{error:{code,message}}` envelope,
 * fall back to a synthesized one, and NEVER surface a blank message (statusText is routinely
 * empty on HTTP/2 and on bare 500s). Two copies of that is two chances for a download to fail
 * with an empty string where a request would have failed with a reason.
 *
 * Returns the parsed body on success so `request` does not have to read the stream twice; the
 * download path ignores it and reads the bytes itself.
 */
async function throwIfNotOk(res: Response): Promise<unknown> {
  if (res.ok) return undefined;
  const json = (await res.json().catch(() => null)) as ApiErrorBody | null;
  throw new ApiError(
    res.status,
    json && typeof json === "object" && "error" in json
      ? json.error
      : {
          code: "http_error",
          // statusText is often empty (HTTP/2, bare 500s) — never surface a blank error.
          message: res.statusText || `Request failed (HTTP ${res.status})`,
        },
  );
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  await throwIfNotOk(res);
  return (await res.json().catch(() => null)) as T;
}

export async function healthCheck(): Promise<{ ok: boolean }> {
  return request("/healthz");
}

export async function getNonce(): Promise<{ nonce: string }> {
  return request("/auth/nonce");
}

export async function verifySiwe(
  message: string,
  signature: `0x${string}`,
): Promise<AuthSession> {
  return request("/auth/verify", {
    method: "POST",
    body: { message, signature },
  });
}

export async function getPasskeyChallenge(
  token: string,
): Promise<{ challenge: string; rpId: string }> {
  return request("/passkey/challenge", { token });
}

/** Public deployment capabilities — no auth. Used by the custody step so the wizard can't offer
 *  an option this deployment would reject at submit. */
export async function getPublicConfig(): Promise<PublicConfig> {
  return request("/config");
}

/** Public transparency surface — no auth. Platform stats + the on-chain entity registry. */
export async function getTransparency(): Promise<TransparencyView> {
  return request("/transparency");
}

export async function onboardEntity(
  token: string,
  spec: AgentSpec,
  guardianPasskey: GuardianPasskey,
  idempotencyKey?: string,
  custody?: "turnkey" | "circle",
): Promise<{ id: string; status: string }> {
  return request("/onboard", {
    method: "POST",
    token,
    body: { spec, guardianPasskey, idempotencyKey, custody },
  });
}

export async function getEntity(
  token: string,
  id: string,
): Promise<EntityView> {
  return request(`/entities/${encodeURIComponent(id)}`, { token });
}

export async function listEntities(token: string): Promise<EntityView[]> {
  return request("/entities", { token });
}

export async function fundEntity(
  token: string,
  id: string,
  amountAtomic: string,
): Promise<{ id: string; status: string }> {
  return request(`/entities/${encodeURIComponent(id)}/fund`, {
    method: "POST",
    token,
    body: { amount: amountAtomic },
  });
}

export async function getEntityTreasury(token: string, id: string): Promise<TreasuryView> {
  return request(`/entities/${encodeURIComponent(id)}/treasury`, { token });
}

export async function getEntityRuns(token: string, id: string): Promise<{ runs: AgentRun[] }> {
  return request(`/entities/${encodeURIComponent(id)}/runs`, { token });
}

export async function getEntityReputation(
  token: string,
  id: string,
): Promise<{ reputation: ReputationView }> {
  return request(`/entities/${encodeURIComponent(id)}/reputation`, { token });
}

export async function listEntityJobs(token: string, id: string): Promise<JobView[]> {
  return request(`/entities/${encodeURIComponent(id)}/jobs`, { token });
}

export async function getJob(token: string, jobKey: string): Promise<JobView> {
  return request(`/jobs/${encodeURIComponent(jobKey)}`, { token });
}

export async function schedulePolicyUpdate(
  token: string,
  id: string,
  body: {
    capUsdc: string;
    periodSeconds: number;
    allowlistOn: boolean;
    payoutAddress: string;
  },
): Promise<{ txHash: string }> {
  return request(`/entities/${encodeURIComponent(id)}/policy`, {
    method: "POST",
    token,
    body,
  });
}

export async function executePolicyUpdate(
  token: string,
  id: string,
  policyId: string,
): Promise<{ txHash: string }> {
  return request(`/entities/${encodeURIComponent(id)}/policy/execute`, {
    method: "POST",
    token,
    body: { policyId },
  });
}

export async function patchTrustPolicy(
  token: string,
  id: string,
  trustPolicy: "open" | "verified-sellers-only" | "verified-legal-bodies-only" | null,
): Promise<{ trustPolicy: string | null }> {
  return request(`/entities/${encodeURIComponent(id)}/trust-policy`, {
    method: "PATCH",
    token,
    body: { trustPolicy },
  });
}

export async function patchPerTxCap(
  token: string,
  id: string,
  perTxCapUsdc: string | null,
): Promise<{ perTxCap: string | null }> {
  return request(`/entities/${encodeURIComponent(id)}/per-tx-cap`, {
    method: "PATCH",
    token,
    body: { perTxCapUsdc },
  });
}

export async function listApiKeys(token: string): Promise<ApiKeyView[]> {
  return request("/api-keys", { token });
}

export async function revokeApiKey(token: string, id: string): Promise<void> {
  await request(`/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
}

export async function createConnectionPackage(
  token: string,
  entityId: string,
  capability: Capability,
): Promise<ConnectionPackage> {
  return request("/connection-package", { method: "POST", token, body: { entityId, capability } });
}

export async function bootstrapConnection(
  token: string,
  passkeyId: string,
  capability: Capability,
): Promise<BootstrapPackage> {
  return request("/bootstrap-connection", { method: "POST", token, body: { passkeyId, capability } });
}

export async function storePasskey(
  token: string,
  passkey: GuardianPasskey,
): Promise<{ id: string }> {
  return request("/passkey", { method: "POST", token, body: passkey });
}

export async function listPasskeys(token: string): Promise<PasskeyView[]> {
  return request("/passkeys", { token });
}

export async function revokePasskey(token: string, id: string): Promise<void> {
  await request(`/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", token });
}

export async function fetchAgentSchema(): Promise<Record<string, unknown>> {
  return request("/schema/agent-spec.json");
}

// ── World ID guardian verification ────────────────────────────────────────────
/** Current guardian-verification state for the signed-in wallet. */
export function worldIdMe(token: string): Promise<WorldIdMe> {
  return request<WorldIdMe>("/world-id/me", { token });
}

/** Open a World ID verification request; returns a connectorURI to scan in World App. */
export function worldIdRequest(token: string): Promise<WorldIdRequestView> {
  return request<WorldIdRequestView>("/world-id/request", { token, body: {} });
}

/** Poll a verification request until it resolves. */
export function worldIdStatus(token: string, requestId: string): Promise<WorldIdStatusView> {
  return request<WorldIdStatusView>(`/world-id/status/${requestId}`, { token });
}

/** AgentBook standing for an agent: does a verified human publicly answer for its wallet? */
export function entityAgentBook(
  token: string,
  id: string,
): Promise<{
  registered: boolean;
  reason?: "not registered" | "no-operator-yet";
  humanId?: string;
  operator?: string;
  register?: string;
}> {
  return request(`/entities/${encodeURIComponent(id)}/agentbook`, { token });
}

/** Params for the identity step-up widget. 404 when the deployment has no attest action; 403
 *  until the caller is already a verified guardian — it is a step-up, not a way in. */
export function worldIdAttestContext(token: string): Promise<WorldIdAttestContext> {
  return request<WorldIdAttestContext>("/world-id/attest/context", { token });
}

/** Submit an identity-attestation proof produced by the widget. */
export function worldIdAttestVerify(token: string, proof: unknown): Promise<unknown> {
  return request("/world-id/attest/verify", { token, body: { proof } });
}

/** Params for the browser IDKit widget, including the v4-mandatory signed request context. */
export function worldIdContext(token: string): Promise<WorldIdContext> {
  return request<WorldIdContext>("/world-id/context", { token });
}

/** Submit a proof produced by the browser widget for verification + binding. */
export function worldIdVerify(token: string, proof: unknown): Promise<WorldIdStatusView> {
  return request<WorldIdStatusView>("/world-id/verify", { token, body: { proof } });
}

/** Redeem an admin-issued guardian waiver code — the escape hatch for humans with no World ID
 *  path (no Orb in their country, passport outside World's credential list). */
export function worldIdWaiver(token: string, code: string): Promise<WorldIdStatusView> {
  return request<WorldIdStatusView>("/world-id/waiver", { token, body: { code } });
}

/**
 * Download one legal document as a Blob.
 *
 * The only bytes-returning call in this client, and it has to exist: an `<a href>` cannot carry a
 * Bearer token, so the browser path is fetch -> blob -> objectURL rather than a plain link. The
 * shared `request` helper is json-only by construction (it calls `res.json()`), so this goes
 * around it — and therefore repeats the auth header and the error envelope by hand.
 *
 * The response is deliberately NOT trusted to be a PDF just because it was asked for: a proxy
 * error page or an expired-session redirect would otherwise be handed to the caller as a
 * "document" and saved to disk under a .pdf name.
 */
export async function downloadDocument(
  token: string,
  id: string,
  docId: string,
): Promise<Blob> {
  const res = await fetch(
    `${API_URL}/entities/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  await throwIfNotOk(res);

  const blob = await res.blob();
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/pdf") {
    throw new ApiError(res.status, {
      code: "unexpected_content_type",
      message: `expected a PDF, got "${contentType || "(none)"}"`,
    });
  }
  return blob;
}
