import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuthVars } from "../../auth/middleware";
import {
  type CustomerCompanyInput,
  type CustomerStatementInput,
  abandonCustomerCompany,
  createCustomerCompany,
  prepareCustomerStatement,
} from "../../legalBody/customerCompany";
import { buildStatementMessage, statementTypedDataWire } from "../../legalBody/statement";
import { LegalTextNotApprovedError } from "../../legalBody/texts/index";
import type { ApiDeps } from "../app";
import { ApiError, readJson } from "../errors";

/**
 * THE DOORS FOR A CUSTOMER'S OWN COMPANY: an existing Wyoming LLC its guardian declares, with a
 * signed statement of authority, as the company behind a legal body.
 *
 *  - `POST /companies/customer/statement-message` answers the statement to sign, as typed data;
 *  - `POST /companies/customer` creates the company from the signed statement;
 *  - `POST /companies/:companyId/abandon` gives up an unchecked one.
 *
 * Every rule lives in the domain functions (`legalBody/customerCompany.ts`); these handlers decide
 * only what is a well-formed HTTP request. They are mounted under the `/companies` session
 * protection, and only where the deployment wires their dependencies: nowhere without the
 * legal-body factory, and on a production deployment only where it charges.
 *
 * Nothing here echoes a declarant's name or title. The one response that carries them is the typed
 * data the tenant itself asked for, which is the sentence its own wallet is about to show it.
 */

/** The largest body a door reads, in bytes. A declaration is a few hundred. */
export const CUSTOMER_DOOR_MAX_BODY_BYTES = 8 * 1024;

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
}
