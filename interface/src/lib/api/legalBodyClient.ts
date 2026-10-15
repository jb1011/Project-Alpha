/**
 * The calls the legal-body flow makes.
 *
 * Every authenticated door goes through `request` and `API_URL`, the site's proxy by default, with
 * the session's bearer token, and fails the way every other call of this client fails: an
 * `ApiError` carrying the house code. Two answers are read here instead, because they are not
 * failures:
 *
 *  - the link door's flat 422, a refusal that carries the order as it now stands (still `draft`
 *    before the reservation, `lapsed` after it), which the screen needs in order to continue;
 *  - the public by-agent read, which goes to the API's own origin (`PUBLIC_API_ORIGIN`) with no
 *    header at all, so the browser is its own caller to the public limiter and the read stays a
 *    simple cross-origin GET. It never throws and never turns a failure into a negative: a 429 is
 *    "could not check", not "no legal body".
 */
import { clientBudgetMs } from "./budgets";
import { request, throwIfNotOk } from "./client";
import { API_URL, PUBLIC_API_ORIGIN } from "./config";
import { fetchWithTimeout, readJsonBounded, TIMEOUT_CODE } from "./timeout";
import type {
  BindingView,
  CustomerCompanyInput,
  CustomerStatementInput,
  Hex,
  LegalBodyAgreement,
  LegalBodyByAgent,
  LegalBodyOrderView,
  LinkMessageResult,
  LinkRefusal,
  LinkSubmitAnswer,
  LinkTypedDataWire,
  PublicRefusal,
  StatementMessageAnswer,
} from "./types";
import { ApiError } from "./types";

const orderPath = (id: string) => `/legal-body-orders/${encodeURIComponent(id)}`;

/** `POST /companies/customer/statement-message`: the statement to sign. Writes nothing. */
export function requestStatementMessage(
  token: string,
  input: CustomerStatementInput,
): Promise<StatementMessageAnswer> {
  return request("/companies/customer/statement-message", { method: "POST", token, body: input });
}

/** `POST /companies/customer`: the company, from the signed statement. A retry of the same signed
 *  statement answers the same id. */
export function createCustomerCompany(
  token: string,
  input: CustomerCompanyInput,
): Promise<{ companyId: string }> {
  return request("/companies/customer", { method: "POST", token, body: input });
}

/** `POST /companies/:id/abandon`: 204. The door reads no body, so none is sent. */
export async function abandonCompany(token: string, companyId: string): Promise<void> {
  await request(`/companies/${encodeURIComponent(companyId)}/abandon`, { method: "POST", token });
}

export function listLegalBodyOrders(token: string): Promise<{ orders: LegalBodyOrderView[] }> {
  return request("/legal-body-orders", { token });
}

export function createLegalBodyOrder(token: string, companyId: string): Promise<LegalBodyOrderView> {
  return request("/legal-body-orders", { method: "POST", token, body: { companyId } });
}

export function getLegalBodyOrder(token: string, id: string): Promise<LegalBodyOrderView> {
  return request(orderPath(id), { token });
}

export function getLegalBodyAgreement(token: string, id: string): Promise<LegalBodyAgreement> {
  return request(`${orderPath(id)}/agreement`, { token });
}

/** `POST /legal-body-orders/:id/abandon`: the order as abandoned. Reads no body. */
export function abandonLegalBodyOrder(token: string, id: string): Promise<LegalBodyOrderView> {
  return request(`${orderPath(id)}/abandon`, { method: "POST", token });
}

/** `POST /legal-body-orders/:id/link-message`: the link to sign. `ttlSeconds` is sent only when
 *  given, so the server's own default applies otherwise. */
export function requestLinkMessage(
  token: string,
  id: string,
  body: { agentId: string; ttlSeconds?: number },
): Promise<LinkMessageResult> {
  const sent: { agentId: string; ttlSeconds?: number } = { agentId: body.agentId };
  if (body.ttlSeconds !== undefined) sent.ttlSeconds = body.ttlSeconds;
  return request(`${orderPath(id)}/link-message`, { method: "POST", token, body: sent });
}

/**
 * `POST /legal-body-orders/:id/link`: the signed link.
 *
 * 200 is the order with its body deployed, 202 the order still `reserved` while the create is not
 * confirmed; both are answers with the order as served. A 422 whose JSON carries a top-level
 * string `code` is the door's flat refusal, also an answer, with the order it carries. Anything
 * else that is not a success, a 422 in the house envelope included, is the house error.
 */
export async function submitLink(
  token: string,
  id: string,
  body: { message: LinkTypedDataWire["message"]; signature: Hex },
): Promise<LinkSubmitAnswer> {
  const path = `${orderPath(id)}/link`;
  const res = await fetchWithTimeout(
    `${API_URL}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: body.message, signature: body.signature }),
    },
    clientBudgetMs("POST", path),
  );

  if (res.status === 200 || res.status === 202) {
    const order = (await readJsonBounded<LegalBodyOrderView>(res)) as LegalBodyOrderView;
    return { status: res.status, body: order };
  }
  if (res.status === 422) {
    // Read from a copy: a 422 that is not the flat refusal is handed on whole to `throwIfNotOk`.
    const refusal = await readJsonBounded<unknown>(res.clone());
    if (isFlatRefusal(refusal)) return { status: 422, body: refusal };
  }
  await throwIfNotOk(res);
  // A success the door never answers: not an order, so not something to continue from.
  throw new ApiError(res.status, {
    code: "http_error",
    message: `Unexpected answer from the link door (HTTP ${res.status})`,
  });
}

function isFlatRefusal(value: unknown): value is LinkRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

export function getBinding(token: string, id: string): Promise<BindingView> {
  return request(`${orderPath(id)}/binding`, { token });
}

/** `POST /legal-body-orders/:id/binding/refresh`: one check now. Reads no body. */
export function refreshBinding(token: string, id: string): Promise<BindingView> {
  return request(`${orderPath(id)}/binding/refresh`, { method: "POST", token });
}

/** `POST /legal-body-orders/:id/gas-seed`: a little native gas for the identity's owner. Reads no
 *  body. */
export function requestGasSeed(token: string, id: string): Promise<{ status: "sent"; txHash: Hex }> {
  return request(`${orderPath(id)}/gas-seed`, { method: "POST", token });
}

/** A public read: the answer as served, or why it could not be made. There is no third case, and
 *  no failure is ever reported as an answer. */
export type PublicRead<T> =
  | { kind: "answer"; body: T }
  | {
      kind: "could_not_check";
      reason: "rate_limited" | "unavailable" | "validation_error" | "network" | "timeout" | "malformed";
    };

const PUBLIC_REFUSALS: readonly PublicRefusal["error"][] = [
  "rate_limited",
  "unavailable",
  "validation_error",
];

function couldNotCheck<T>(
  reason: Extract<PublicRead<T>, { kind: "could_not_check" }>["reason"],
): PublicRead<T> {
  return { kind: "could_not_check", reason };
}

function isTimeout(e: unknown): boolean {
  return e instanceof ApiError && e.code === TIMEOUT_CODE;
}

/** The flat refusal's `error`, when it is one of the three the public routes answer. */
function publicRefusalReason(value: unknown): PublicRefusal["error"] | null {
  if (typeof value !== "object" || value === null) return null;
  const error = (value as { error?: unknown }).error;
  return PUBLIC_REFUSALS.find((r) => r === error) ?? null;
}

/** Enough of a record to read: an object that says whether there is a legal body. */
function isByAgentRecord(value: unknown): value is LegalBodyByAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { legalBody?: unknown }).legalBody === "boolean"
  );
}

/** `GET <PUBLIC_API_ORIGIN>/legal-bodies/by-agent/:agentId`, with no authorization header. */
export async function getLegalBodyByAgent(agentId: string): Promise<PublicRead<LegalBodyByAgent>> {
  const path = `/legal-bodies/by-agent/${encodeURIComponent(agentId)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${PUBLIC_API_ORIGIN}${path}`,
      { method: "GET" },
      clientBudgetMs("GET", path),
    );
  } catch (e) {
    return couldNotCheck(isTimeout(e) ? "timeout" : "network");
  }

  let json: unknown;
  try {
    json = await readJsonBounded<unknown>(res);
  } catch (e) {
    return couldNotCheck(isTimeout(e) ? "timeout" : "malformed");
  }

  if (res.status === 200 && isByAgentRecord(json)) return { kind: "answer", body: json };
  if (!res.ok) {
    const reason = publicRefusalReason(json);
    if (reason !== null) return couldNotCheck(reason);
  }
  return couldNotCheck("malformed");
}
