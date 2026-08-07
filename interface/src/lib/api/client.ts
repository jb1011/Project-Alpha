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

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const json = (await res.json().catch(() => null)) as
    | T
    | ApiErrorBody
    | null;

  if (!res.ok) {
    const err =
      json && typeof json === "object" && "error" in json
        ? (json as ApiErrorBody).error
        : {
            code: "http_error",
            // statusText is often empty (HTTP/2, bare 500s) — never surface a blank error.
            message: res.statusText || `Request failed (HTTP ${res.status})`,
          };
    throw new ApiError(res.status, err);
  }

  return json as T;
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
): Promise<{ registered: boolean; humanId?: string; operator?: string; register?: string }> {
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
