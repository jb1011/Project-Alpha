import type { Hono } from "hono";
import { getAddress } from "viem";
import type { GuardianPasskey } from "../../adapters/turnkey/provisioner";
import type { AuthVars } from "../../auth/middleware";
import { custodyUnavailableMessage } from "../../custody";
import {
  companyNamesRequiredMessage,
  createFormationParty,
  formationDoorRefusal,
  formationUnavailableMessage,
  partyFieldsOf,
  truncateTenant,
} from "../../formation";
import { createCompany, updateCompanyIntake, updateCompanyParty } from "../../formation/company";
import { FORMATION_PRODUCT, guardianOf, paymentView } from "../../formation/payment";
import { deriveFormationStatus, hasLivePayment } from "../../formation/status";
import { opsLog } from "../../observability/opsLog";
import { ROUTE_RECEIPT_TIMEOUT_MS } from "../../payments/formationSettle";
import { withKeyedLock } from "../../payments/keyedMutex";
import {
  AgentSpecSchema,
  CreateCompanyBodySchema,
  FormationPartySchema,
  UpdateCompanyIntakeBodySchema,
  firstIssueMessage,
} from "../../policy/agentSpec";
import {
  cancelFormationPayment,
  requoteFormationPayment,
  settleFormationPayment,
} from "../../workflow/formationPayment";
import type { ApiDeps } from "../app";
import { ApiError, requireOwnedCompany } from "../errors";
import { listCompanyViews, toCompanyDetailView, toEntityView, toEntityViews } from "../views";
import { assertGuardianAllowed } from "./worldId";

export function mountProtectedRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/onboard", async (c) => {
    const tenantId = c.get("tenantId");
    let body: {
      spec?: unknown;
      guardianPasskey?: unknown;
      idempotencyKey?: unknown;
      custody?: unknown;
      partyId?: unknown;
      companyId?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (!body.guardianPasskey || typeof body.guardianPasskey !== "object")
      throw new ApiError("validation_error", 400, "guardianPasskey is required");

    // Tier-0 custody choice: optional; absent -> the platform default (turnkey until P4). A
    // circle request on a deployment without Circle provisioning is refused HERE, before any
    // claim — the saga would only fail it asynchronously.
    if (body.custody !== undefined && body.custody !== "turnkey" && body.custody !== "circle")
      throw new ApiError("validation_error", 400, 'custody must be "turnkey" or "circle"');
    const custody = (body.custody ?? deps.walletProviderDefault) as "turnkey" | "circle";
    if (custody === "circle" && !deps.circleCustodyAvailable)
      throw new ApiError("validation_error", 400, custodyUnavailableMessage("circle"));
    if (custody === "turnkey" && !deps.turnkeyCustodyAvailable)
      throw new ApiError("validation_error", 400, custodyUnavailableMessage("turnkey"));

    // Formation gate (design §2/§5/§7): AFTER custody, BEFORE the World gate. The order is
    // mirrored exactly by the MCP onboard_agent tool, and the checks themselves live in ONE
    // function so the two surfaces cannot drift — see src/formation.ts. Everything it refuses is
    // refused BEFORE the claim: an entity must never be left live with a mandatory formation that
    // can never happen.
    //
    // `partyId` is still READ, and it is read in order to be REFUSED (A3). The A1 shim used to
    // turn one into a 1:1 company inside the claim; with the shim gone, silently ignoring the
    // field would accept an onboard from a caller who had just posted a real legal identity and
    // believed it was being filed. `formationDoorRefusal` answers it with the door that files.
    if (body.partyId !== undefined && typeof body.partyId !== "string")
      throw new ApiError("validation_error", 400, "partyId must be a string");
    if (body.companyId !== undefined && typeof body.companyId !== "string")
      throw new ApiError("validation_error", 400, "companyId must be a string");
    const partyId = body.partyId as string | undefined;
    const companyId = body.companyId as string | undefined;
    const formationRefusal = formationDoorRefusal(deps, { tenantId, partyId, companyId });
    if (formationRefusal) throw new ApiError("validation_error", 400, formationRefusal);

    // Proof-of-personhood gate: the guardian is the legally accountable natural person, so when
    // enforcement is on they must be a World-ID-verified unique human under the per-human cap.
    // No-op when World isn't configured / WORLD_REQUIRE_GUARDIAN is false.
    assertGuardianAllowed(deps.worldId, tenantId);

    // Server owns the guardian + manager: force guardian to the authenticated tenant and manager
    // to the platform manager address before validation (audit fix C — the caller can't discover
    // or misconfigure the on-chain manager, which must equal the wallet the saga signs txs as).
    const rawSpec = (body.spec ?? {}) as Record<string, unknown>;
    const roles = {
      ...((rawSpec.roles as object) ?? {}),
      guardian: tenantId,
      manager: deps.platformManagerAddress,
    };
    const spec = AgentSpecSchema.parse({ ...rawSpec, roles }); // throws ZodError → 400

    const userKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey
        ? body.idempotencyKey
        : spec.name;
    const { id, status } = deps.runner.start({
      spec,
      userKey,
      tenantId: getAddress(tenantId),
      guardianPasskey: body.guardianPasskey as GuardianPasskey,
      custody,
      companyId,
    });
    return c.json({ id, status }, 202);
  });

  /**
   * COMPANIES (design 2026-08-26 §7) — the legal body an agent is filed under.
   *
   * `POST /companies` is where the money is spent, so it carries the whole gate: the World-ID
   * personhood check, the per-tenant quota, the platform daily ceiling, the synthetic-PII
   * refusals and the party bind. All of it lives in `createCompany`, which MCP's `create_company`
   * and the A1 onboard shim call too — one function, so the three doors cannot disagree about
   * what a company costs.
   *
   * It takes the PRODUCTION intake (§5): three ranked name candidates, the company's own
   * business purpose, an industry from the shipped reference list — and, on a production
   * deployment only, the responsible party's SSN. Everything is validated inside
   * `createCompany`, so the two doors refuse the same things in the same words; this handler
   * only decides what is a well-formed HTTP body.
   *
   * **This is the ONLY door that takes an SSN** (§4.1), and it takes it on THIS request because
   * the AAD it is encrypted under is `party_id || company_id` — the company id does not exist
   * until the create mints it. Never echoed back, never logged, never in a view.
   */
  app.post("/companies", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    // TYPE checks only, from the ONE schema both company doors parse — the CONTENT rules (length,
    // charset, restricted words, duplicates, the industry list, the SSN format) all live in
    // `createCompany`, where MCP meets them too.
    const body = CreateCompanyBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError("validation_error", 400, firstIssueMessage(body.error));

    const result = createCompany(
      // The composition root's ONE dependency set; this door supplies only its transaction.
      { ...deps.formation.companyDeps, transaction: (fn) => deps.repo.transaction(fn) },
      tenantId,
      {
        partyId: body.data.partyId,
        names: body.data.names,
        businessPurpose: body.data.businessPurpose,
        industryLabel: body.data.industryLabel,
        ssn: body.data.ssn,
        synthetic: body.data.synthetic === true ? true : undefined,
      },
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);
    // The companyId and — when payment is on — the QUOTE (§6.1). Never the intake: echoing it
    // back would put the SSN in a response body, in any client that persists responses, and in
    // any proxy log along the way. A quote is the opposite kind of thing: an amount, a payee, a
    // nonce and an expiry, all of which the guardian is about to publish by signing them.
    return c.json(
      result.quote
        ? { companyId: result.companyId, payment: result.quote }
        : { companyId: result.companyId },
      201,
    );
  });

  /**
   * `GET /companies/:companyId/payment` — what this company owes, and what happened to it (§6.1).
   *
   * ONE route for both questions, because a guardian who reloads the page mid-payment has to be
   * able to ask either. It answers with the LIVE row if there is one and otherwise the most
   * recent terminal one, so "your payment settled" is expressible — a route that only answered
   * "what do you owe?" would tell somebody whose payment had just gone through that they had no
   * payment at all.
   *
   * The signable `typedData` rides along ONLY while the row is `quoted` AND still inside its
   * window. Not on `settling`: re-signing a payment whose broadcast is in flight is exactly the
   * double charge §6.4 exists to prevent, and a client that could see a quote would render the
   * button.
   *
   * 404 for a deployment that does not charge, deliberately — the same answer as for a company
   * that does not exist. There is no payment resource here, and inventing an empty one would have
   * every client render a payment section on a box that never takes money.
   */
  app.get("/companies/:companyId/payment", (c) => {
    const company = requireOwnedCompany(deps, c);
    const payment = deps.formation?.payment;
    if (!payment?.required) throw new ApiError("not_found", 404, "payment not found");
    const row = payment.payments.findCurrent(company.companyId, FORMATION_PRODUCT);
    if (!row) throw new ApiError("not_found", 404, "payment not found");
    const now = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
    return c.json(paymentView(row, guardianOf(company), payment, now));
  });

  /**
   * The three payment ACTIONS (design §6.3/§6.4), all on one company and all guardian-driven.
   *
   * They share a preamble — own the company, this box charges, an executor is wired — and are
   * serialised PER COMPANY by the same keyed lock the formation sweeper uses. The lock is what
   * makes "at most one broadcast per quote" true under a double-clicked button, on top of the
   * database CAS that makes it true under two processes.
   */
  const paymentRunner = (company: import("../../persistence/companyRepository").CompanyRecord) => {
    const payment = deps.formation?.payment;
    const executor = deps.formation?.paymentExecutor;
    if (!payment?.required || !executor) throw new ApiError("not_found", 404, "payment not found");
    return {
      companies: deps.companies!,
      // The entity store, so a duplicate charge reaches the AUDIT TRAIL of every agent attached
      // to the company and not only the ops log (gate A5).
      entities: deps.repo,
      payment,
      // …and the REQUEST PATH's receipt wait (finding B3): 12 seconds, because a `pending` answer
      // is complete — the client polls this company's payment every 4 seconds and the sweeper is
      // the backstop — and holding a connection open for a minute only makes it feel broken.
      executor: { ...executor, receiptTimeoutMs: ROUTE_RECEIPT_TIMEOUT_MS },
      transaction: <T>(fn: () => T) => deps.repo.transaction(fn),
      now: deps.now,
      company,
    };
  };

  /**
   * `POST /companies/:companyId/payment/settle` — the guardian's signature, and the only thing
   * that turns a `draft` company into a `ready` one on a deployment that charges.
   *
   * The body is the signature and the address that produced it. Everything else — the amount, the
   * payee, the nonce, the window — comes off the STORED ROW, deliberately: a body that could name
   * its own amount would be a body that could pay one dollar for a Wyoming LLC.
   */
  app.post("/companies/:companyId/payment/settle", async (c) => {
    const company = requireOwnedCompany(deps, c);
    const runner = paymentRunner(company);
    const body = await readJson(c);
    const { signature, from } = (body ?? {}) as { signature?: unknown; from?: unknown };
    if (typeof signature !== "string" || !signature.startsWith("0x"))
      throw new ApiError("validation_error", 400, "signature is required");
    if (typeof from !== "string") throw new ApiError("validation_error", 400, "from is required");
    const result = await withKeyedLock(`payment:${company.companyId}`, () =>
      settleFormationPayment(runner, company, {
        signature: signature as `0x${string}`,
        from: from as `0x${string}`,
      }),
    );
    if (!result.ok) throw new ApiError("validation_error", 400, result.reason);
    return c.json({ status: result.status, txHash: result.txHash });
  });

  /**
   * `POST /companies/:companyId/payment/cancel` — the fast path out of a stuck `settling` row.
   *
   * A SECOND signature, over a DIFFERENT message (`CancelAuthorization(authorizer, nonce)`),
   * because the platform cannot cancel unilaterally: the token verifies the authorizer. That is
   * the design and not a limitation — an authorization is the guardian's promise, and we only
   * carry the letter.
   */
  app.post("/companies/:companyId/payment/cancel", async (c) => {
    const company = requireOwnedCompany(deps, c);
    const runner = paymentRunner(company);
    const { signature } = ((await readJson(c)) ?? {}) as { signature?: unknown };
    if (typeof signature !== "string" || !signature.startsWith("0x"))
      throw new ApiError("validation_error", 400, "signature is required");
    const result = await withKeyedLock(`payment:${company.companyId}`, () =>
      cancelFormationPayment(runner, company, { signature: signature as `0x${string}` }),
    );
    if (!result.ok) throw new ApiError("validation_error", 400, result.reason);
    return c.json({ status: "expired", txHash: result.txHash });
  });

  /**
   * `POST /companies/:companyId/payment/requote` — a NEW row with a NEW nonce.
   *
   * Deliberately its own door (§6.4). "Expire, then re-quote" is two acts: the first is a claim
   * about the CHAIN (this authorization can never settle), the second a promise to the guardian
   * (this is what you owe now). Fusing them would let a UI re-quote its way out of a `settling`
   * row whose transfer was still in flight — the double charge in its most natural disguise — so
   * this door REFUSES while any row is live and says which kind of live it is.
   */
  app.post("/companies/:companyId/payment/requote", (c) => {
    const company = requireOwnedCompany(deps, c);
    const runner = paymentRunner(company);
    const result = requoteFormationPayment(runner, company);
    if (!result.ok) throw new ApiError("validation_error", 400, result.reason);
    return c.json(result.quote, 201);
  });

  /**
   * EDIT-AND-RETRY (design §4.7) — re-open a frozen intake, with a fresh SSN capture.
   *
   * REST only, and for the same reason `POST /companies` is: this is the door that may carry an
   * SSN, and an SSN never travels as an MCP tool argument. There is no MCP twin, deliberately.
   *
   * The freeze itself is a property of the ROW (`companies.updateIntake`'s WHERE clause), not of
   * this handler: three surfaces can reach a company, and a route-level check is a check one more
   * door can forget. This handler decides only what is a well-formed HTTP body.
   */
  app.patch("/companies/:companyId", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    const body = UpdateCompanyIntakeBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError("validation_error", 400, firstIssueMessage(body.error));

    const result = updateCompanyIntake(
      { ...deps.formation.companyDeps, transaction: (fn) => deps.repo.transaction(fn) },
      tenantId,
      c.req.param("companyId"),
      {
        names: body.data.names,
        businessPurpose: body.data.businessPurpose,
        industryLabel: body.data.industryLabel,
        ssn: body.data.ssn,
        // The §4.6a decision, and deliberately a strict `=== true`: "file without one" is a
        // choice a caller makes, never something a truthy value makes for them.
        proceedWithoutSsn: body.data.proceedWithoutSsn === true ? true : undefined,
      },
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);
    // The id and nothing else — the same rule the create follows, for the same reason.
    return c.json({ companyId: result.companyId });
  });

  /**
   * The tenant's companies, NEWEST FIRST.
   *
   * The ordering is an API-level contract shared with MCP `list_companies` and with the wizard's
   * reuse picker, whose default is the last-used company: two renderers sorting for themselves is
   * how a picker ends up disagreeing with the list behind it.
   *
   * NO PII, exactly as everywhere else: the responsible party is not projected here, and neither
   * is the filed party's name. The company's own name candidates are not personal data.
   */
  app.get("/companies", (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.companies) return c.json({ companies: [] });
    // ONE projection, shared with MCP `list_companies`, in four queries however long the page is.
    return c.json({
      companies: listCompanyViews({ ...deps, companies: deps.companies }, tenantId),
    });
  });

  /**
   * ONE COMPANY, in full (design §7) — what the Companies section's detail page reads.
   *
   * Registered wherever a company STORE is, exactly like `GET /companies` and for the same
   * reason: a box whose doola credentials have been pulled still holds real Wyoming LLCs, and a
   * tenant must be able to read the filings they already have. It is `deps.companies`, not
   * `deps.formation`, that gates it.
   *
   * `requireOwnedCompany` answers the same uniform 404 for unknown and not-yours that every other
   * ownership check in this file does.
   */
  app.get("/companies/:companyId", (c) => {
    const company = requireOwnedCompany(deps, c);
    // The SHARED deps object, narrowed only where the route already proved the store exists:
    // `requireOwnedCompany` answered a 404 without it.
    return c.json(toCompanyDetailView({ ...deps, companies: deps.companies! }, company));
  });

  /**
   * PII intake (design §3/§5). The ONE place a legal identity enters the system.
   *
   * It is a separate call, not a field on /onboard, because PII must never ride in `spec`
   * (spec_json is persisted and rendered) and must never travel as an MCP tool argument in the
   * same shape as the agent's public configuration. The caller gets back an opaque handle and
   * passes THAT to onboard.
   *
   * The response carries the partyId and nothing else — echoing the stored identity back would
   * put PII in a response body, a log, and any client that persists API responses.
   */
  app.post("/formation-party", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    let body: { synthetic?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }

    // The synthetic shortcut carries no PII at all, so it is never parsed as a party body.
    const parsed = body.synthetic === true ? undefined : FormationPartySchema.parse(body); // ZodError -> 400
    const result = createFormationParty(
      { parties: deps.formation.parties, sandboxSyntheticPii: deps.formation.sandboxSyntheticPii },
      tenantId,
      { synthetic: body.synthetic, parsed },
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);

    // The ONLY trail this leaves: which tenant created which handle. No name, no address, no
    // email — not here, not in any view, not in the manifest.
    opsLog("formation_party_created", {
      tenantId: truncateTenant(tenantId),
      partyId: result.partyId,
    });
    return c.json({ partyId: result.partyId }, 201);
  });

  /**
   * PATCH /companies/:companyId/party — the PARTY-EDIT DOOR (design §7, A3).
   *
   * The exit A2 wrote a park for and could not give: a company whose `createCustomer` doola
   * REJECTED parks under `awaitingPartyEdit`, and none of the four fields `PATCH /companies/:id`
   * rewrites is one `createCustomer` reads. This door rewrites the identity and re-arms exactly
   * one retry, in one transaction.
   *
   * ⚠ ADDRESSED BY COMPANY, not by party handle. The party is RESOLVED from the company's UNIQUE
   * `company_id`, so the door cannot reach another company's responsible person at all — where a
   * `partyId` address made that a rule to enforce rather than a sentence nobody can write. It
   * also removes the uuid the form had to ask a human to paste, which no surface in this system
   * serves back.
   *
   * It takes the SAME body as `POST /formation-party`, parsed by the SAME `.strict()` schema, so
   * a field the create refuses is not quietly accepted by the edit. It takes NO `ssn` — there is
   * no field for one — and the response is the handle and nothing else, for the reason the create
   * gives: echoing a stored identity back puts it in a response body and in every client that
   * caches one.
   */
  app.patch("/companies/:companyId/party", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    // ZodError -> 400, exactly as the create does. There is deliberately no `synthetic` shortcut:
    // the labeled sandbox fixture is ours, not a caller's, and re-typing it would be a caller
    // writing a fixture we generate.
    const body = FormationPartySchema.parse(await readJson(c));
    const result = updateCompanyParty(
      { ...deps.formation.companyDeps, transaction: (fn) => deps.repo.transaction(fn) },
      tenantId,
      c.req.param("companyId"),
      // The SAME wire→column mapping the create door and the MCP twin use.
      partyFieldsOf(body),
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);
    return c.json({ partyId: result.partyId });
  });

  // The batched projection: one formation-steps read and one documents read for the whole page,
  // instead of two per entity (M5).
  app.get("/entities", (c) =>
    c.json(toEntityViews(deps.repo.listByTenant(c.get("tenantId")), deps)),
  );

  app.get("/entities/:id", (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    return c.json(toEntityView(rec, deps));
  });

  app.post("/entities/:id/fund", async (c) => {
    let body: { amount?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.amount !== "string" && typeof body.amount !== "number")
      throw new ApiError("validation_error", 400, "amount (atomic USDC) is required");
    const { id, status } = deps.runner.fund({
      id: c.req.param("id"),
      tenantId: c.get("tenantId"),
      amount: BigInt(body.amount),
    });
    return c.json({ id, status }, 202);
  });

  app.post("/entities/:id/fund-pocket", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");

    let body: { amountUsdc?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.amountUsdc !== "string" || !/^-?\d+$/.test(body.amountUsdc))
      throw new ApiError("validation_error", 400, "amountUsdc (atomic USDC integer) is required");
    const amount = BigInt(body.amountUsdc);
    if (amount <= 0n) throw new ApiError("validation_error", 400, "amountUsdc must be positive");

    if (!deps.pocketFunding) throw new ApiError("unavailable", 503, "pocket funding unavailable");
    try {
      const txHashes = await deps.pocketFunding(rec, amount);
      return c.json({ txHashes });
    } catch (e) {
      throw new ApiError("pocket_funding_failed", 502, (e as Error).message);
    }
  });
} /** The body, or the door's own 400 — a malformed JSON body is not a schema violation, and saying
 *  so is more use to a caller than a list of missing fields. */
async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("validation_error", 400, "invalid JSON body");
  }
}
