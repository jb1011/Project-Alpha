import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Hex } from "viem";
import type { AuthVars } from "../../auth/middleware";
import {
  type CustomerCompanyInput,
  type CustomerStatementInput,
  abandonCustomerCompany,
  createCustomerCompany,
  prepareCustomerStatement,
} from "../../legalBody/customerCompany";
import {
  type AcceptEvidenceResult,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_CONCURRENT,
  EVIDENCE_MAX_PRESENT_PER_COMPANY,
  EVIDENCE_MAX_ROWS_PER_COMPANY,
  type EvidenceKind,
  acceptEvidence,
} from "../../legalBody/evidence";
import { CUSTOMER_PROVIDER } from "../../legalBody/provider";
import { buildStatementMessage, statementTypedDataWire } from "../../legalBody/statement";
import { LegalTextNotApprovedError } from "../../legalBody/texts/index";
import type { CompanyRecord } from "../../persistence/companyRepository";
import { readCappedStream } from "../../util/readStreamCapped";
import type { ApiDeps } from "../app";
import { ApiError, readJson, requireOwnedCompany } from "../errors";

/**
 * THE DOORS FOR A CUSTOMER'S OWN COMPANY: an existing Wyoming LLC its guardian declares, with a
 * signed statement of authority, as the company behind a legal body.
 *
 *  - `POST /companies/customer/statement-message` answers the statement to sign, as typed data;
 *  - `POST /companies/customer` creates the company from the signed statement;
 *  - `POST /companies/:companyId/abandon` gives up an unchecked one;
 *  - `POST /companies/:companyId/evidence` takes a PDF for the operator to check the declaration
 *    against. The tenant lists and downloads it through the document routes.
 *
 * Every rule lives in the domain functions (`legalBody/customerCompany.ts`, `legalBody/evidence.ts`);
 * these handlers decide only what is a well-formed HTTP request. They are mounted under the
 * `/companies` session protection, and only where the deployment wires their dependencies: nowhere
 * without the legal-body factory, and on a production deployment only where it charges.
 *
 * Nothing here echoes a declarant's name or title. The one response that carries them is the typed
 * data the tenant itself asked for, which is the sentence its own wallet is about to show it.
 */

/** The largest body a JSON door reads, in bytes. A declaration is a few hundred. The evidence door
 *  reads a file, not JSON, under its own cap, EVIDENCE_MAX_BYTES. */
export const CUSTOMER_DOOR_MAX_BODY_BYTES = 8 * 1024;

const EVIDENCE_KINDS: readonly EvidenceKind[] = ["existence", "control"];
/** The sha256 parameter: 64 hexadecimal digits, with or without 0x, in either case. */
const SHA256_PARAM = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** A Content-Type's media type, without its parameters, in lower case: HTTP compares it so. */
function mediaTypeOf(header: string | undefined): string {
  return (header ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * The company an upload is for: the tenant's own (an unknown one and another tenant's are one 404),
 * declared by its customer (a formation company is a 409), and not abandoned (the same 404 as an
 * unknown company: an abandoned company takes nothing more, and says nothing about itself).
 */
function uploadableCompany(
  cc: NonNullable<ApiDeps["customerCompanies"]>,
  c: Parameters<typeof requireOwnedCompany>[1],
): CompanyRecord {
  const company = requireOwnedCompany(cc, c);
  if (company.provider !== CUSTOMER_PROVIDER)
    throw new ApiError("conflict", 409, "evidence is uploaded only for a declared company");
  if (company.status === "abandoned") throw new ApiError("not_found", 404, "company not found");
  return company;
}

/** The kind and the sha256 from the query, well-formed, or every bad one named without its value.
 *  The sha256 is answered in the spelling the index keeps: 0x and lower-case hex. */
function evidenceParams(query: (key: string) => string | undefined): {
  kind: EvidenceKind;
  sha256: Hex;
} {
  const kind = query("kind");
  const sha256 = query("sha256");
  const problems: { field: string; problem: string }[] = [];
  if (kind === undefined) problems.push({ field: "kind", problem: "is required" });
  else if (!EVIDENCE_KINDS.includes(kind as EvidenceKind))
    problems.push({ field: "kind", problem: "must be existence or control" });
  if (sha256 === undefined) problems.push({ field: "sha256", problem: "is required" });
  else if (!SHA256_PARAM.test(sha256))
    problems.push({ field: "sha256", problem: "must be the file's sha256: 64 hexadecimal digits" });
  if (problems.length > 0 || kind === undefined || sha256 === undefined)
    throw new ApiError(
      "validation_error",
      400,
      "the upload's kind or sha256 is not valid",
      problems,
    );
  return {
    kind: kind as EvidenceKind,
    sha256: `0x${sha256.replace(/^0x/, "").toLowerCase()}`,
  };
}

function payloadTooLarge(): ApiError {
  return new ApiError(
    "payload_too_large",
    413,
    `the file must be at most ${EVIDENCE_MAX_BYTES} bytes`,
  );
}

/** The refusal an upload the domain turned down is answered with. */
function uploadRefusal(problem: Extract<AcceptEvidenceResult, { ok: false }>["problem"]): ApiError {
  switch (problem) {
    case "empty":
      return new ApiError("validation_error", 400, "the uploaded file is not valid", [
        { field: "body", problem: "is empty" },
      ]);
    case "not_pdf":
      return new ApiError("validation_error", 400, "the uploaded file is not valid", [
        { field: "body", problem: "must be a PDF, which starts with %PDF-" },
      ]);
    case "too_large":
      return payloadTooLarge();
    case "content_mismatch":
      return new ApiError(
        "content_mismatch",
        400,
        "the file received does not have the sha256 given: it was changed on the way, or the hash is another file's; nothing was stored",
      );
    case "too_many":
      return new ApiError(
        "conflict",
        409,
        `this company holds as many uploads as it may: ${EVIDENCE_MAX_PRESENT_PER_COMPANY} kept, ${EVIDENCE_MAX_ROWS_PER_COMPANY} in all`,
      );
  }
}

/** A draft wording on a production deployment, answered as the refusal it is: the deployment
 *  cannot take a declaration until its wording is approved. */
async function servingApprovedWording<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof LegalTextNotApprovedError)
      throw new ApiError("legal_text_not_approved", 503, err.message);
    throw err;
  }
}

export function mountCustomerCompanyRoutes(
  app: Hono<{ Variables: AuthVars }>,
  cc: NonNullable<ApiDeps["customerCompanies"]>,
): void {
  // On every door, the abandon door included: it reads no body, and still bounds what a caller may
  // send it. A declared length over the limit is refused before a byte is read.
  const limit = bodyLimit({
    maxSize: CUSTOMER_DOOR_MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        "payload_too_large",
        413,
        `the body must be at most ${CUSTOMER_DOOR_MAX_BODY_BYTES} bytes`,
      );
    },
  });

  /**
   * The statement to sign, as EIP-712 typed data in its JSON-safe form, with the version and the
   * status of its wording. The human, the wording, the synthetic rule and the field rules are all
   * checked BEFORE anything is rendered, so a caller any of them refuses is never shown a sentence.
   * It writes nothing: the statement only becomes a declaration once it comes back signed.
   */
  app.post("/companies/customer/statement-message", limit, async (c) => {
    const body = (await readJson(c)) as CustomerStatementInput;
    const { fields } = await servingApprovedWording(() =>
      prepareCustomerStatement(cc, c.get("tenantId"), body),
    );
    // The server's clock, the one the create judges the statement's freshness by.
    const issuedAt = BigInt(Math.floor((cc.now ?? Date.now)() / 1000));
    const message = buildStatementMessage(fields, cc.text, issuedAt);
    return c.json({
      typedData: statementTypedDataWire(cc.chainId, cc.factory, message),
      wordingVersion: message.wordingVersion,
      textStatus: cc.text.status,
    });
  });

  /**
   * The company, from the signed statement: 201 with its id. The same statement with the same
   * signature, already used by this tenant, answers the same id with a 200, so a client that
   * retries after a lost response neither creates a second company nor meets a cap its own first
   * request filled.
   */
  app.post("/companies/customer", limit, async (c) => {
    const body = (await readJson(c)) as CustomerCompanyInput;
    const { companyId, created } = await servingApprovedWording(() =>
      createCustomerCompany(cc, c.get("tenantId"), body),
    );
    return c.json({ companyId }, created ? 201 : 200);
  });

  /**
   * Abandon the tenant's own customer company while nobody has checked it, nothing has been paid
   * and no legal body stands open on it; its declarant's personal data is erased in the same
   * transaction. Unknown and not-yours are one 404; any other refusal is a 409.
   */
  app.post("/companies/:companyId/abandon", limit, (c) => {
    abandonCustomerCompany(cc, c.get("tenantId"), c.req.param("companyId"));
    return c.body(null, 204);
  });

  /**
   * The tenants with an upload being read. One upload per tenant, so the set's size is also the
   * number being read: in the process, since a process builds one app. Held from the last check
   * before the body is read to the answer.
   */
  const uploading = new Set<string>();

  /**
   * An evidence file: the raw PDF as the body, `kind` and `sha256` in the query. 201 with
   * `{ docId, sha256, size }`; the same body with a 200 for a file the company already holds.
   *
   * Before a byte is read, in this order: the session (the `/companies` protection), the company
   * (see `uploadableCompany`), the content type, the kind and the hash, and a declared length over
   * the cap; then one upload at a time per tenant, and EVIDENCE_MAX_CONCURRENT in the process. No
   * JSON body limit: the body is a file, read under its own cap, and cut off once it passes it.
   */
  app.post("/companies/:companyId/evidence", async (c) => {
    uploadableCompany(cc, c);
    if (mediaTypeOf(c.req.header("content-type")) !== "application/pdf")
      throw new ApiError(
        "unsupported_media_type",
        415,
        "the body must be the PDF itself, sent as application/pdf",
      );
    const { kind, sha256 } = evidenceParams((key) => c.req.query(key));
    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > EVIDENCE_MAX_BYTES) throw payloadTooLarge();

    const tenantId = c.get("tenantId");
    if (uploading.has(tenantId))
      throw new ApiError(
        "rate_limited",
        429,
        "this tenant is already uploading a file: send the next one when it is done",
      );
    if (uploading.size >= EVIDENCE_MAX_CONCURRENT)
      throw new ApiError(
        "unavailable",
        503,
        "too many files are being uploaded: try again shortly",
      );
    uploading.add(tenantId);
    try {
      const bytes = await readCappedStream(
        {
          body: c.req.raw.body,
          contentLength: c.req.header("content-length"),
          readAll: async () => Buffer.from(await c.req.arrayBuffer()),
        },
        EVIDENCE_MAX_BYTES,
        { declared: payloadTooLarge, streamed: payloadTooLarge },
      );
      // Again, now that the body is in: the company may have been abandoned while it arrived.
      // Nothing awaits from here to the write, so nothing else in this process runs in between.
      const company = uploadableCompany(cc, c);
      const result = acceptEvidence(cc, {
        companyId: company.companyId,
        kind,
        expectedSha256: sha256,
        bytes,
      });
      if (!result.ok) throw uploadRefusal(result.problem);
      return c.json(
        { docId: result.docId, sha256: result.sha256, size: result.size },
        result.duplicate ? 200 : 201,
      );
    } finally {
      uploading.delete(tenantId);
    }
  });
}
