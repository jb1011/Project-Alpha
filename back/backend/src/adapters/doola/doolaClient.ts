import { opsLog } from "../../observability/opsLog";
import type {
  CreateCompanyInput,
  CreateCustomerInput,
  DoolaCompany,
  DoolaComplianceEvent,
  DoolaCustomer,
  DoolaDocument,
  DoolaDocumentDownload,
  DoolaErrorEnvelope,
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
 * - **Every call is deadline-bounded** (`withCallDeadline`, the circleExec idea): the formation
 *   sweeper and the onboarding saga both call this while holding an entity lock, and a hung
 *   socket with no RST would otherwise wedge the whole entity's mutex chain.
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
} as const;

export class DoolaApiError extends Error {
  constructor(
    /** doola's machine code, e.g. E_VALIDATION_FAILED. "E_UNKNOWN" when the body carried none. */
    readonly code: string,
    readonly status: number,
    message: string,
    /** doola's correlation id — the FIRST thing their support asks for. */
    readonly requestId?: string,
    /** Field-level detail on a validation failure. */
    readonly fields?: Record<string, string | string[]>,
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
  listDocuments(companyId: string): Promise<DoolaDocument[]>;
  getDocumentDownloadUrl(companyId: string, documentId: string): Promise<DoolaDocumentDownload>;
  listRequiredActions(companyId: string): Promise<DoolaRequiredAction[]>;
  getComplianceCalendar(companyId: string): Promise<DoolaComplianceEvent[]>;
  /** SANDBOX ONLY: force the formation to complete. Refused against production by construction. */
  playgroundCompleteFormation(companyId: string): Promise<void>;
  /** SANDBOX ONLY: force EIN issuance. NOTE: `company_ein_issued` fires on FIRST issuance only —
   *  a repeat re-fires the document-letter event, not the EIN event. */
  playgroundCompleteEin(companyId: string): Promise<void>;
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

/** Bound ONE HTTP call by a real wall-clock deadline (the circleExec `withCallDeadline` idea):
 *  a dropped TCP connection with no RST never resolves, and these calls are made while holding a
 *  per-entity lock. A real timer deliberately — an instantly-resolving fake must not fake-time-out
 *  an instantly-resolving fake call. */
function withCallDeadline<T>(work: Promise<T>, ms: number, err: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(err()), Math.max(ms, 1));
    (t as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Map doola's envelope `{error:{code,message,fields,requestId}, payload}` onto DoolaApiError. */
function toApiError(status: number, path: string, body: unknown): DoolaApiError {
  const env = (body ?? {}) as DoolaErrorEnvelope;
  const code = env.error?.code ?? "E_UNKNOWN";
  const message = env.error?.message ?? `doola ${path} failed with HTTP ${status}`;
  return new DoolaApiError(code, status, message, env.error?.requestId, env.error?.fields);
}

/** Real client over `fetch`. Never logs the API key or any request body (bodies carry PII). */
export function buildDoolaApi(cfg: DoolaClientConfig): DoolaApi {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = cfg.baseUrl.replace(/\/+$/, "");

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
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

    const res = await withCallDeadline(
      fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      timeoutMs,
      () => new DoolaTimeoutError(path, timeoutMs),
    );

    // 204/empty bodies are legitimate (the playground POSTs). Parse defensively: an HTML error
    // page from a proxy must surface as "doola failed", never as a JSON.parse stack trace.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) throw toApiError(res.status, path, parsed);
    return parsed as T;
  }

  /** doola wraps successful reads in `{payload: …}`; tolerate a bare body too. */
  function payloadOf<T>(body: unknown): T {
    const b = body as { payload?: T } | undefined;
    return (b && typeof b === "object" && "payload" in b ? b.payload : b) as T;
  }

  function assertSandbox(method: string): void {
    if (cfg.environment !== "sandbox")
      throw new Error(
        `doola ${method} is a SANDBOX-ONLY playground call and this client is pinned to ${cfg.environment}`,
      );
  }

  return {
    async createCustomer(input, idempotencyKey) {
      return payloadOf<DoolaCustomer>(
        await call("POST", "/customers", { body: input, idempotencyKey }),
      );
    },
    async createCompany(input, idempotencyKey) {
      return payloadOf<DoolaCompany>(
        await call("POST", "/companies", { body: input, idempotencyKey }),
      );
    },
    async getCompany(companyId) {
      return payloadOf<DoolaCompany>(await call("GET", `/companies/${companyId}`));
    },
    async listDocuments(companyId) {
      return (
        payloadOf<DoolaDocument[]>(await call("GET", `/companies/${companyId}/documents`)) ?? []
      );
    },
    async getDocumentDownloadUrl(companyId, documentId) {
      return payloadOf<DoolaDocumentDownload>(
        await call("GET", `/companies/${companyId}/documents/${documentId}/download`),
      );
    },
    async listRequiredActions(companyId) {
      return (
        payloadOf<DoolaRequiredAction[]>(
          await call("GET", `/companies/${companyId}/required-actions`),
        ) ?? []
      );
    },
    async getComplianceCalendar(companyId) {
      return (
        payloadOf<DoolaComplianceEvent[]>(
          await call("GET", `/companies/${companyId}/compliance-calendar`),
        ) ?? []
      );
    },
    async playgroundCompleteFormation(companyId) {
      assertSandbox("playgroundCompleteFormation");
      await call("POST", `/playground/companies/${companyId}/complete-formation`);
    },
    async playgroundCompleteEin(companyId) {
      assertSandbox("playgroundCompleteEin");
      await call("POST", `/playground/companies/${companyId}/complete-ein`);
    },
  };
}
