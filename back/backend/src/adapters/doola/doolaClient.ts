import { opsLog } from "../../observability/opsLog";
import { withDeadline } from "../../util/deadline";
import type {
  CreateCompanyInput,
  CreateCustomerInput,
  DoolaCompany,
  DoolaCompanyPage,
  DoolaComplianceEvent,
  DoolaCustomer,
  DoolaDocument,
  DoolaDocumentDownload,
  DoolaErrorEnvelope,
  DoolaPlaygroundResult,
  DoolaRequiredAction,
} from "./types";

/**
 * Thin typed client for doola's Partner API (design 2026-08-19 §2/§5/§9).
 *
 * Deliberate shape, and the reasons:
 *
 * - **Auth is the RAW key in `Authorization`** — no `Bearer` prefix. That is doola's documented
 *   contract, verified against the live sandbox; adding the prefix 401s every call.
 * - **`Idempotency-Key` goes on the two CREATE endpoints ONLY.** doola honors it nowhere else
 *   (fact-check 1). Sending it elsewhere is not merely useless, it is misleading: it would
 *   suggest a crash-safety guarantee that does not exist. The playground/resolution POSTs are
 *   naturally idempotent server-side instead.
 * - **Every call is deadline-bounded** (the shared `withDeadline`, `src/util/deadline.ts`): the formation
 *   sweeper and the onboarding saga both call this while holding an entity lock, and a hung
 *   socket with no RST would otherwise wedge the whole entity's mutex chain. The deadline covers
 *   the BODY READ as well as the fetch, and aborts the request when it fires.
 * - **Errors map to one typed class** carrying doola's `code` + `requestId`, so a validation
 *   failure (our bad input — never retry blind) is distinguishable from an internal error
 *   (retry with backoff) without string-sniffing at the call sites.
 *
 * The client is a NARROW INJECTABLE SURFACE (`DoolaApi`) for the same reason `CircleWalletsApi`
 * is: tests fake it honestly, production wraps the real host.
 */

/** doola error codes we branch on. Others pass through on `DoolaApiError.code`. */
export const DOOLA_ERROR_CODES = {
  validationFailed: "E_VALIDATION_FAILED",
  internal: "E_INTERNAL",
  idempotencyKeyReused: "E_IDEMPOTENCY_KEY_REUSED",
  notFound: "E_NOT_FOUND",
  unauthorized: "E_UNAUTHORIZED",
  /** OUR code, not doola's: a 2xx whose body is not a readable `{payload:…}` envelope. Never
   *  resolve `undefined` out of a successful-looking call — a caller that treats a missing
   *  company as a company is how a formation gets silently lost. */
  badResponse: "E_BAD_RESPONSE",
  /** OUR code: the response exceeded the read cap. See MAX_RESPONSE_BYTES. */
  responseTooLarge: "E_RESPONSE_TOO_LARGE",
} as const;

export class DoolaApiError extends Error {
  constructor(
    /** doola's machine code, e.g. E_VALIDATION_FAILED. "E_UNKNOWN" when the body carried none. */
    readonly code: string,
    readonly status: number,
    message: string,
    /** doola's correlation id — the FIRST thing their support asks for. */
    readonly requestId?: string,
    /** Field-level detail on a validation failure. Opaque: doola nests `{code, message}` per
     *  field, and a narrower type would be a claim about a partner surface we do not control. */
    readonly fields?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DoolaApiError";
  }

  /** Our input was wrong. Retrying the same body is guaranteed to fail again. */
  get isValidation(): boolean {
    return this.code === DOOLA_ERROR_CODES.validationFailed;
  }

  /** Their side broke. The sweeper retries these with backoff. */
  get isInternal(): boolean {
    return this.code === DOOLA_ERROR_CODES.internal;
  }

  /** The key was reused with a DIFFERENT body — a real bug, never a retry. */
  get isIdempotencyConflict(): boolean {
    return this.code === DOOLA_ERROR_CODES.idempotencyKeyReused;
  }
}

export class DoolaTimeoutError extends Error {
  constructor(
    readonly path: string,
    timeoutMs: number,
  ) {
    super(`doola ${path} did not respond within ${timeoutMs}ms`);
    this.name = "DoolaTimeoutError";
  }
}

/** The slice of doola we consume. Tests fake this; production builds it from config. */
export interface DoolaApi {
  /** Idempotency-Key honored. */
  createCustomer(input: CreateCustomerInput, idempotencyKey: string): Promise<DoolaCustomer>;
  /** Idempotency-Key honored. */
  createCompany(input: CreateCompanyInput, idempotencyKey: string): Promise<DoolaCompany>;
  getCompany(companyId: string): Promise<DoolaCompany>;
  /** Pre-create lookup fallback (completeness 9): "did a create we lost the answer to actually
   *  land?". Scoped to OUR customer id, which we mint one-per-entity, so anything it returns
   *  belongs to the entity that is asking. */
  listCompanies(customerId: string): Promise<DoolaCompany[]>;
  listDocuments(companyId: string): Promise<DoolaDocument[]>;
  getDocumentDownloadUrl(companyId: string, documentId: string): Promise<DoolaDocumentDownload>;
  listRequiredActions(companyId: string): Promise<DoolaRequiredAction[]>;
  getComplianceCalendar(companyId: string): Promise<DoolaComplianceEvent[]>;
  /** SANDBOX ONLY: force the formation to complete. Refused against production by construction.
   *  Resolves with the webhook events the call actually fired (`triggeredEvents`). */
  playgroundCompleteFormation(companyId: string): Promise<DoolaPlaygroundResult | undefined>;
  /** SANDBOX ONLY: force EIN issuance. NOTE: `company_ein_issued` fires on FIRST issuance only —
   *  a repeat re-fires the document-letter event, not the EIN event. */
  playgroundCompleteEin(companyId: string): Promise<DoolaPlaygroundResult | undefined>;
}

export interface DoolaClientConfig {
  apiKey: string;
  baseUrl: string;
  environment: "sandbox" | "production";
  /** Per-call deadline. Default 30s — long enough for a formation POST, short enough that a
   *  hung socket cannot outlive an onboarding request. */
  timeoutMs?: number;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Every partner endpoint lives under this prefix — verified against doola's published OpenAPI
 * document and the live sandbox (`GET https://api.test.doola.com/companies` answers
 * `NoHandlerFoundException`, i.e. a 404, not an empty list).
 *
 * It belongs to the CLIENT, not to `DOOLA_BASE_URLS`, because it is part of the API's shape
 * rather than part of where the API is hosted: an operator pointing `DOOLA_BASE_URL` at a mock
 * or a replay proxy is redirecting the HOST, and should not have to know — or be able to get
 * wrong — the route prefix underneath it.
 */
const API_PREFIX = "/v1/partner";

/**
 * Hard ceiling on ONE response body. doola's largest legitimate JSON payload is a document list;
 * the PDFs themselves are fetched from a signed URL, not from here. Without a cap, a wedged or
 * hostile upstream can stream unbounded bytes into this process's heap while the sweeper holds an
 * entity lock — a memory-exhaustion path with no timeout to save it, because the socket is
 * healthy and data keeps arriving.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function tooLargeError(status: number, path: string, bytes: number): DoolaApiError {
  return new DoolaApiError(
    DOOLA_ERROR_CODES.responseTooLarge,
    status,
    `doola ${path} returned a response of at least ${bytes} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap`,
  );
}

/**
 * Read a response body under the size cap.
 *
 * BOTH halves are needed. `Content-Length` catches the honest large response before a single
 * chunk is buffered — but a chunked (`Transfer-Encoding: chunked`) response declares no length at
 * all, and a lying one declares a small one, so the running counter over the body stream is what
 * actually enforces the bound. Passing the cap cancels the stream, which tears the socket down
 * instead of politely draining megabytes we have already decided to reject.
 */
async function readCappedBody(res: Response, path: string): Promise<string> {
  const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw tooLargeError(res.status, path, declared);

  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  // A 204/empty response has no body stream at all; so do the hand-rolled fakes some callers
  // pass in. Fall back to text() — there is nothing to meter.
  if (!body || typeof body.getReader !== "function") return await res.text();

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {
        // the throw below is the real signal; a failed cancel must not mask it
      });
      throw tooLargeError(res.status, path, total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** doola's correlation id — the FIRST thing their support asks for — wherever it rides. */
function requestIdOf(parsed: unknown, headerValue: string | undefined): string | undefined {
  const env = (parsed ?? {}) as DoolaErrorEnvelope & { requestId?: string };
  return env.error?.requestId ?? env.requestId ?? headerValue;
}

/** Map doola's envelope `{error:{code,message,fields,requestId}, payload}` onto DoolaApiError. */
function toApiError(
  status: number,
  path: string,
  body: unknown,
  requestId?: string,
): DoolaApiError {
  const env = (body ?? {}) as DoolaErrorEnvelope;
  const code = env.error?.code ?? "E_UNKNOWN";
  const message = env.error?.message ?? `doola ${path} failed with HTTP ${status}`;
  return new DoolaApiError(code, status, message, requestId, env.error?.fields);
}

/** Real client over `fetch`. Never logs the API key or any request body (bodies carry PII). */
export function buildDoolaApi(cfg: DoolaClientConfig): DoolaApi {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = cfg.baseUrl.replace(/\/+$/, "");

  /** One HTTP round trip: headers, deadline, size cap, envelope parse, error mapping. Returns
   *  the RAW parsed body — `callPayload` is what enforces the success envelope. */
  async function call(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<{ status: number; parsed: unknown; requestId?: string }> {
    const headers: Record<string, string> = {
      // RAW key, NO "Bearer " prefix — doola's contract. Prefixing it 401s every call.
      Authorization: cfg.apiKey,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    // ONLY the two create endpoints honor this; the callers below are the only ones that pass it.
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    // opsLog parity with the Circle adapter: journald must be able to say what talked to doola
    // when a bill or a rate limit shows up. Path + method only — no key, no body, no PII.
    try {
      opsLog("doola_call", { method, path, environment: cfg.environment });
    } catch {
      // observe, never gate
    }

    // The deadline covers the fetch AND the body read: a response whose headers arrive and whose
    // body then stalls forever is the same wedge as a socket that never answers, and only the
    // second half of it lives after `fetch` resolves.
    const { status, text, headerRequestId } = await withDeadline(
      timeoutMs,
      async (signal) => {
        const res = await fetchImpl(`${base}${path}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal,
        });
        return {
          status: res.status,
          headerRequestId: res.headers?.get?.("x-request-id") ?? undefined,
          text: await readCappedBody(res, path),
        };
      },
      () => new DoolaTimeoutError(path, timeoutMs),
    );

    // 204/empty bodies are legitimate (the playground POSTs). Parse defensively: an HTML error
    // page from a proxy must surface as "doola failed", never as a JSON.parse stack trace.
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const requestId = requestIdOf(parsed, headerRequestId);

    if (status < 200 || status >= 300) throw toApiError(status, path, parsed, requestId);
    return { status, parsed, requestId };
  }

  /**
   * A read that MUST come back with doola's `{payload: …}` envelope.
   *
   * The old shape resolved `undefined` whenever a 2xx carried an empty body, an HTML page from a
   * proxy, or a body with no `payload` key — so a stripped 200 from a CDN read exactly like "the
   * company does not exist", and the caller stored a hole. A successful-looking call that cannot
   * produce the thing it was asked for is an ERROR, and it is named as one. `payload: null` is
   * still legitimate (an empty list) — only a MISSING envelope is refused.
   */
  async function callPayload<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const { status, parsed, requestId } = await call(method, path, opts);
    if (typeof parsed !== "object" || parsed === null || !("payload" in parsed))
      throw new DoolaApiError(
        DOOLA_ERROR_CODES.badResponse,
        status,
        `doola ${path} returned HTTP ${status} with no JSON {payload} envelope`,
        requestId,
      );
    return (parsed as { payload: T }).payload;
  }

  function assertSandbox(method: string): void {
    if (cfg.environment !== "sandbox")
      throw new Error(
        `doola ${method} is a SANDBOX-ONLY playground call and this client is pinned to ${cfg.environment}`,
      );
  }

  return {
    async createCustomer(input, idempotencyKey) {
      return await callPayload<DoolaCustomer>("POST", `${API_PREFIX}/customers`, {
        body: input,
        idempotencyKey,
      });
    },
    async createCompany(input, idempotencyKey) {
      return await callPayload<DoolaCompany>("POST", `${API_PREFIX}/companies`, {
        body: input,
        idempotencyKey,
      });
    },
    async getCompany(companyId) {
      return await callPayload<DoolaCompany>("GET", `${API_PREFIX}/companies/${companyId}`);
    },
    async listCompanies(customerId) {
      // A PAGED envelope, not a bare array: `payload.content`. We ask for the maximum page size
      // and read the first page only — one entity mints one customer, so "more than 100
      // companies under this customer" is not a state this integration can produce.
      const page = await callPayload<DoolaCompanyPage | null>(
        "GET",
        `${API_PREFIX}/companies?customerId=${encodeURIComponent(customerId)}&size=100`,
      );
      return page?.content ?? [];
    },
    async listDocuments(companyId) {
      // `payload: null` is a legitimate empty list; a MISSING envelope already threw above.
      return (
        (await callPayload<DoolaDocument[] | null>(
          "GET",
          `${API_PREFIX}/companies/${companyId}/documents`,
        )) ?? []
      );
    },
    async getDocumentDownloadUrl(companyId, documentId) {
      return await callPayload<DoolaDocumentDownload>(
        "GET",
        `${API_PREFIX}/companies/${companyId}/documents/${documentId}`,
      );
    },
    async listRequiredActions(companyId) {
      return (
        (await callPayload<DoolaRequiredAction[] | null>(
          "GET",
          `${API_PREFIX}/companies/${companyId}/required-actions`,
        )) ?? []
      );
    },
    async getComplianceCalendar(companyId) {
      const cal = await callPayload<{ events?: DoolaComplianceEvent[] | null } | null>(
        "GET",
        `${API_PREFIX}/companies/${companyId}/compliance/calendar`,
      );
      return cal?.events ?? [];
    },
    async playgroundCompleteFormation(companyId) {
      assertSandbox("playgroundCompleteFormation");
      const { parsed } = await call(
        "POST",
        `${API_PREFIX}/playground/companies/${companyId}/formation/complete`,
      );
      return (parsed as { payload?: DoolaPlaygroundResult } | undefined)?.payload;
    },
    async playgroundCompleteEin(companyId) {
      assertSandbox("playgroundCompleteEin");
      const { parsed } = await call(
        "POST",
        `${API_PREFIX}/playground/companies/${companyId}/eincreation/complete`,
      );
      return (parsed as { payload?: DoolaPlaygroundResult } | undefined)?.payload;
    },
  };
}
