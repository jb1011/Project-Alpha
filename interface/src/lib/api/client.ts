import { API_URL } from "./config";
import type {
  AgentRun,
  AgentSpec,
  ApiErrorBody,
  ApiKeyView,
  AuthSession,
  EntityView,
  GuardianPasskey,
  JobView,
  MintedApiKey,
  ReputationView,
  TreasuryView,
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
        : { code: "http_error", message: res.statusText };
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

export async function getPasskeyChallenge(): Promise<{
  challenge: string;
  rpId: string;
}> {
  return request("/passkey/challenge");
}

export async function onboardEntity(
  token: string,
  spec: AgentSpec,
  guardianPasskey: GuardianPasskey,
  idempotencyKey?: string,
): Promise<{ id: string; status: string }> {
  return request("/onboard", {
    method: "POST",
    token,
    body: { spec, guardianPasskey, idempotencyKey },
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

export async function mintApiKey(
  token: string,
  label?: string,
): Promise<MintedApiKey> {
  return request("/api-keys", {
    method: "POST",
    token,
    body: label ? { label } : {},
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

export async function fetchAgentSchema(): Promise<Record<string, unknown>> {
  return request("/schema/agent-spec.json");
}
