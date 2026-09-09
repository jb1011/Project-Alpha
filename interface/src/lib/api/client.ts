import { API_URL } from "./config";
import type {
  AgentBookRegisterBody,
  AgentBookRegisterResult,
  AgentBookSessionView,
  AgentBookStatusView,
  AgentRun,
  AgentSpec,
  ApiErrorBody,
  ApiKeyView,
  AuthSession,
  BootstrapPackage,
  Capability,
  CompanyDetailView,
  CompanyIntakeInput,
  FormationRules,
  CompanyIntakeUpdate,
  CompanyView,
  ComplianceView,
  ConnectionPackage,
  EntityView,
  FormationPartyInput,
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
  /**
   * The company this agent is ATTACHED to (design §7, A3).
   *
   * ⚠ Never a `partyId`. A1's backend shim used to mint a 1:1 company for a party-only onboard;
   * A3 removed it, and the door now REFUSES a party handle rather than ignoring it. The wizard
   * sequences the two calls instead: `createCompany` then `onboardEntity` — which is what keeps
   * personal data (and, since A2, a potential SSN) off this request entirely.
   */
  companyId?: string,
): Promise<{ id: string; status: string }> {
  return request("/onboard", {
    method: "POST",
    token,
    body: { spec, guardianPasskey, idempotencyKey, custody, companyId },
  });
}

/**
 * Record the legal identity of the responsible natural person, and get back a handle.
 *
 * The ONE call in this client that carries personal data, and the reason the flow is two calls
 * instead of a field on `/onboard`: the identity must never ride inside `spec` (which is
 * persisted verbatim and rendered back out) and must never be held anywhere the wizard could
 * later serialize. The response deliberately carries the handle and NOTHING else — echoing the
 * stored identity back would put it in a response body and in every client that caches one.
 *
 * `{ synthetic: true }` is the sandbox path: no identity is collected or sent at all, and the
 * backend files with its own labeled demo fixture.
 */
export async function createFormationParty(
  token: string,
  body: { synthetic: true } | FormationPartyInput,
): Promise<{ partyId: string }> {
  return request("/formation-party", { method: "POST", token, body });
}

/* ── COMPANIES (design §7) ─────────────────────────────────────────────────── */

/**
 * The industry labels a company may be filed under — PUBLIC, and cached hard.
 *
 * A federal reference table compiled into the backend build (821 labels), served from its own
 * route rather than from `/config` because `/config` is fetched by every page before auth and
 * cached for the life of the tab. The picker validates against what this returns, and the door
 * validates against the same array, so a form cannot offer a label the create would refuse.
 */
/**
 * THE INTAKE RULES — the industry labels, and the four limits the form enforces (§5/§7).
 *
 * It was `/formation/industries`, serving the one field that obviously could not be hard-coded
 * while the four beside it were hard-coded anyway, each with a `Mirrors …` comment naming the
 * backend constant it copied. A mirror is a second copy with a promise attached: the day one
 * moves, this form either refuses a name the door would take, or PROMISES one the door refuses —
 * after a founder has typed three of them.
 */
export async function fetchFormationRules(): Promise<FormationRules> {
  return request("/formation/rules");
}

/**
 * Create the legal body, and get back an opaque company id.
 *
 * ⚠ THE ONE CALL IN THIS CLIENT THAT CAN CARRY AN SSN (§4.1), and the reason the wizard is two
 * calls rather than a field on `/onboard`: the number is sealed under an AAD of
 * `party_id || company_id`, so it has to ride the request that mints the company. It is a plain
 * argument here — never a React Query key, never a stored value, never echoed back.
 */
export async function createCompany(
  token: string,
  intake: CompanyIntakeInput,
): Promise<{ companyId: string }> {
  return request("/companies", { method: "POST", token, body: intake });
}

/** The §4.7 edit-and-retry: re-open a rejected intake, with a fresh SSN capture. */
export async function updateCompanyIntake(
  token: string,
  companyId: string,
  intake: CompanyIntakeUpdate,
): Promise<{ companyId: string }> {
  return request(`/companies/${encodeURIComponent(companyId)}`, {
    method: "PATCH",
    token,
    body: intake,
  });
}

/** The tenant's companies, NEWEST FIRST — the ordering the reuse picker's default depends on. */
export async function listCompanies(token: string): Promise<{ companies: CompanyView[] }> {
  return request("/companies", { token });
}

export async function getCompany(token: string, companyId: string): Promise<CompanyDetailView> {
  return request(`/companies/${encodeURIComponent(companyId)}`, { token });
}

/**
 * The compliance calendar — LAZY, and it may refuse.
 *
 * The backend fetches it from the filing agent on view and caches it for a day. A provider that
 * did not answer is a 502 here, deliberately: "we could not ask" and "nothing is due" are
 * opposite facts, and a page that rendered the first as the second would tell an owner their
 * annual report is not due when nobody asked.
 */
export async function getCompanyCompliance(
  token: string,
  companyId: string,
): Promise<ComplianceView> {
  return request(`/companies/${encodeURIComponent(companyId)}/compliance`, { token });
}

/**
 * Correct the responsible person on a filing the provider REFUSED (design §7, A3).
 *
 * The one exit from a company parked on `awaitingPartyEdit`. Editable only until the filing has
 * been sent: once the provider holds the person it is never asked for them again, so an edit
 * afterwards would change our copy and nothing else. NO ssn — there is no field for one.
 *
 * ⚠ Addressed by COMPANY. The door took a party handle first, which meant this form had to ask a
 * human to paste a uuid no surface in the system ever serves back — and a mistyped one rewrote
 * the responsible person of a different company. The backend resolves the party from the
 * company's UNIQUE `company_id`, so the wrong-company edit is not a request that can be made.
 */
export async function updateCompanyParty(
  token: string,
  companyId: string,
  body: FormationPartyInput,
): Promise<{ partyId: string }> {
  return request(`/companies/${encodeURIComponent(companyId)}/party`, {
    method: "PATCH",
    token,
    body,
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
export function entityAgentBook(token: string, id: string): Promise<AgentBookStatusView> {
  return request<AgentBookStatusView>(`/entities/${encodeURIComponent(id)}/agentbook`, { token });
}

/** Start a vouch: the backend reads the registry nonce and records a pending session. 403 when the
 *  guardian's World ID is not from an Orb, 409 before the agent is on chain, 503 where this
 *  deployment cannot write (`PublicConfig.agentBookRegistrationAvailable`). */
export function agentBookSession(token: string, id: string): Promise<AgentBookSessionView> {
  return request<AgentBookSessionView>(`/entities/${encodeURIComponent(id)}/agentbook/session`, {
    token,
    body: {},
  });
}

/** Hand the World ID proof to the backend, which submits the registration on World Chain. A proof
 *  is single-use, so a 400 `proof_rejected` means starting the whole flow again, not retrying. */
export function agentBookRegister(
  token: string,
  id: string,
  body: AgentBookRegisterBody,
): Promise<AgentBookRegisterResult> {
  return request<AgentBookRegisterResult>(`/entities/${encodeURIComponent(id)}/agentbook/register`, {
    token,
    body,
  });
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
 * Download one legal document as a Blob, by COMPANY (design §7, A3).
 *
 * Keyed by the company rather than by an entity because that is what the documents belong to: a
 * filing can complete, and its Articles and Operating Agreement arrive, before any agent is
 * attached to it.
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
  companyId: string,
  docId: string,
): Promise<{ blob: Blob; filename: string | null }> {
  const res = await fetch(
    `${API_URL}/companies/${encodeURIComponent(companyId)}/documents/${encodeURIComponent(docId)}`,
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
  return {
    blob,
    filename: parseAttachmentFilename(res.headers.get("content-disposition")),
  };
}

/**
 * The download's filename, from `Content-Disposition`, or null.
 *
 * The backend derives this name from the document TYPE and never echoes a provider-supplied
 * string, so it arrives safe. It is re-sanitized here anyway because it has crossed a proxy by
 * the time we read it, and it is about to become the `download` attribute of an anchor: anything
 * with a path separator, a control character or a non-PDF extension is discarded in favour of the
 * caller's own name rather than trusted.
 */
function parseAttachmentFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!raw) return null;
  // Basename only — a "directory/../name.pdf" never becomes a path.
  const base = raw.split(/[/\\]/).pop() ?? "";
  if (!/^[A-Za-z0-9._-]{1,128}\.pdf$/.test(base)) return null;
  if (base.includes("..")) return null;
  return base;
}
