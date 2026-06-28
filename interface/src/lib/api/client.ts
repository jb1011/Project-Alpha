import { API_URL } from "./config";
import type {
  AgentSpec,
  ApiErrorBody,
  AuthSession,
  EntityView,
  GuardianPasskey,
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

export async function fetchAgentSchema(): Promise<Record<string, unknown>> {
  return request("/schema/agent-spec.json");
}
