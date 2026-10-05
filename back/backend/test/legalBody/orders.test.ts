/**
 * Ordering a legal body: a verified human orders one for a company it declared and the operator
 * checked, and the order is born a draft with its agreement stored and frozen, in one write. Also
 * the caps on open and daily orders, abandoning a draft, the order's view, the one boundary
 * between a door and the chain, and the doors' throttles.
 *
 * The database is real (in memory, or one file shared by two connections); the chain is never
 * called here. Every name, company and filing number is an invention, and every key is one of
 * anvil's published test accounts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import { apiOnError } from "../../src/api/errors";
import { ApiError } from "../../src/errors";
import { agreementDocNames, readVerifiedAgreement } from "../../src/legalBody/agreement";
import {
  type LegalBodyOrderDeps,
  abandonOrder,
  chainCall,
  companyEligible,
  createOrder,
  orderLockKey,
  requireOwnedOrder,
  takeDoorTokens,
  toOrderView,
} from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES, refusal } from "../../src/legalBody/sentences";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "../../src/legalBody/texts/operatingAgreement";
import { withKeyedLock } from "../../src/payments/keyedMutex";
import type { CompanyCheckResult } from "../../src/persistence/companyCheckRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  FORMATION_PROVIDER,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { MemoryDocumentStore } from "../helpers/formationFakes";
import {
  BODY,
  DAY_MS,
  H,
  type LegalBodyStores,
  OTHER_FACTORY,
  REGISTRY,
  TransportFailure,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** Two verified humans, and one that never verified. */
const tenant = ANVIL_ACCOUNT_2.address;
const otherTenant = ANVIL_ACCOUNT_3.address;
const unverified = ANVIL_ACCOUNT_4.address;
const NULLIFIERS: Record<string, string> = { [tenant]: "3001", [otherTenant]: "3002" };

type Stack = LegalBodyStores;
const openStack = (db: Database.Database, docStore?: MemoryDocumentStore): Stack =>
  openLegalBodyStores(db, docStore);

let s: Stack;
beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openStack(db);
  recordHuman(s.store, tenant, "3001", Date.now());
  recordHuman(s.store, otherTenant, "3002", Date.now());
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** The order deps of a sandbox deployment (the agreement's wording is a draft, which only a
 *  sandbox serves), with room in every throttle. The chain is never called here. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}, stack: Stack = s): LegalBodyOrderDeps {
  return legalBodyOrderDeps(stack, { chain: {} as LegalBodyChainPort, ...over });
}

/** A company of `owner`, with the checks given (one pass unless told otherwise), declared by the
 *  owner's own nullifier. */
function company(
  owner: Address,
  opts: {
    checks?: CompanyCheckResult[];
    companyName?: string;
    filingNumber?: string;
    provider?: string;
    status?: "draft" | "ready";
  } = {},
  stack: Stack = s,
): string {
  return customerCompany(stack, owner, { humanNullifier: NULLIFIERS[owner] ?? "3999", ...opts });
}

/** The refusal `run` threw, checked for its code, status and fixed sentence. */
function refused(run: () => unknown, code: string, status: number): ApiError {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  return expectRefusal(caught, code, status);
}

async function refusedAsync(run: () => Promise<unknown>, code: string, status: number) {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  return expectRefusal(caught, code, status);
}

function expectRefusal(caught: unknown, code: string, status: number): ApiError {
  expect(caught, `expected the refusal ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect(err.code).toBe(code);
  expect(err.status).toBe(status);
  return err;
}

const rowCount = (stack: Stack = s): number =>
  (stack.db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get() as { n: number }).n;
const eventCount = (stack: Stack = s): number =>
  (stack.db.prepare("SELECT COUNT(*) AS n FROM legal_body_events").get() as { n: number }).n;

/** The stored row of an order that must exist. */
function rowOf(id: string) {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A frozen draft moved to `reserved` through the repository, as the link door will move it. */
function reserve(id: string, deadline = Math.floor(Date.now() / 1000) + 3600): void {
  expect(
    s.repo.reserve(id, {
      agentId: "42",
      identityOwner: unverified,
      linkDigest: H("b"),
      linkDeadline: deadline,
      linkSignature: "0x01",
      bodyAddress: BODY,
      observedAtBlock: 7,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
}

// ── createOrder ─────────────────────────────────────────────────────────────────────────────

describe("createOrder", () => {
  test("a verified human orders a body for a checked customer company: a draft with its agreement frozen, in one write", () => {
    const companyId = company(tenant);
    const view = createOrder(orderDeps(), tenant, { companyId });

    const row = s.repo.findById(view.id);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.bindingState).toBe("draft");
    expect(row.tenantId).toBe(tenant);
    expect(row.guardian).toBe(tenant);
    expect(row.companyId).toBe(companyId);
    expect(row.chainId).toBe(CHAIN_ID);
    expect(row.factory).toBe(FACTORY);
    expect(row.amendmentDelay).toBe(172_800);
    expect(row.oaManifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.oaManifestVersion).toBe(1);
    expect(view).toEqual(toOrderView(row));
    expect(view.agreement).toEqual({ hash: row.oaManifestHash, version: 1 });

    // The move and the note: the system created and froze it, the tenant ordered it.
    expect(
      s.repo.listEvents(view.id).map((e) => ({ kind: e.kind, actor: e.actor, detail: e.detail })),
    ).toEqual([
      { kind: "created", actor: "system", detail: null },
      { kind: "agreement_frozen", actor: "system", detail: { version: 1 } },
      { kind: "note", actor: "tenant", detail: { act: "ordered" } },
    ]);

    // Two files, named by the order, that re-verify against the frozen hash.
    const names = agreementDocNames(view.id);
    expect([...s.docStore.files.keys()].sort()).toEqual([names.manifest, names.terms].sort());
    const verified = readVerifiedAgreement(s.docStore, view.id, row.oaManifestHash as Hex);
    expect(verified).toBeDefined();
    expect(verified?.terms).toEqual({
      textId: LEGAL_BODY_OPERATING_AGREEMENT.id,
      textVersion: LEGAL_BODY_OPERATING_AGREEMENT.version,
      textStatus: LEGAL_BODY_OPERATING_AGREEMENT.status,
    });
    // The checked name and filing number, the guardian, and the deployment.
    expect(verified?.termsDoc).toContain('"Example Holdings LLC"');
    expect(verified?.termsDoc).toContain('filing number "TEST-0001"');
    expect(verified?.termsDoc).toContain(`wallet ${tenant}`);
    const manifest = JSON.parse(verified?.manifest ?? "{}");
    expect(manifest.chain).toEqual({
      chainId: CHAIN_ID,
      factory: FACTORY,
      identityRegistry: REGISTRY,
    });
    expect(manifest.guardian).toBe(tenant);
    expect(manifest.amendmentDelay).toBe(172_800);
  });

  test("the agreement takes the deployment's amendment delay", () => {
    const view = createOrder(orderDeps({ amendmentDelaySeconds: 2_592_000 }), tenant, {
      companyId: company(tenant),
    });
    expect(view.amendmentDelay).toBe(2_592_000);
    const verified = readVerifiedAgreement(s.docStore, view.id, view.agreement?.hash as Hex);
    expect(JSON.parse(verified?.manifest ?? "{}").amendmentDelay).toBe(2_592_000);
  });

  test("each of the three checks refuses with its code, in order, and writes no row and no file", () => {
    const mine = company(tenant);
    const theirs = company(otherTenant, { filingNumber: "TEST-0002" });
    const unchecked = company(tenant, { checks: [], filingNumber: "TEST-0003" });
    const ofUnverified = company(unverified, { filingNumber: "TEST-0004" });
    const production = orderDeps({ environment: "production" });

    // 1. A real human: before the wording, on a production deployment too.
    refused(
      () => createOrder(orderDeps(), unverified, { companyId: ofUnverified }),
      "guardian_not_verified",
      403,
    );
    refused(
      () => createOrder(production, unverified, { companyId: ofUnverified }),
      "guardian_not_verified",
      403,
    );
    refused(
      () => createOrder(orderDeps({ world: undefined }), tenant, { companyId: mine }),
      "unavailable",
      503,
    );

    // 2. The wording: a production deployment does not serve a draft, before any company is read.
    for (const companyId of [mine, theirs, "co_unknown"]) {
      const err = refused(
        () => createOrder(production, tenant, { companyId }),
        "legal_text_not_approved",
        503,
      );
      expect(err.message).toBe(LEGAL_BODY_SENTENCES.legal_text_not_approved);
    }

    // 3. The tenant's company, with one answer for not-yours and unknown, then its eligibility.
    const notYours = refused(
      () => createOrder(orderDeps(), tenant, { companyId: theirs }),
      "not_found",
      404,
    );
    const unknown = refused(
      () => createOrder(orderDeps(), tenant, { companyId: "co_unknown" }),
      "not_found",
      404,
    );
    expect(notYours.message).toBe(unknown.message);
    expect(notYours.details).toEqual(unknown.details);
    const ineligible = refused(
      () => createOrder(orderDeps(), tenant, { companyId: unchecked }),
      "company_not_eligible",
      409,
    );
    expect(ineligible.message).toBe(LEGAL_BODY_SENTENCES.company_not_eligible);

    expect(rowCount()).toBe(0);
    expect(eventCount()).toBe(0);
    expect(s.docStore.files.size).toBe(0);
  });

  test("eligible: a customer company, not abandoned, whose latest check passed; anything else is refused", () => {
    const deps = orderDeps({ maxOpenPerTenant: 20, maxOrdersPerTenantPerDay: 20 });
    let n = 0;
    const filing = () => `TEST-${String(++n).padStart(4, "0")}`;

    const passed = company(tenant, { filingNumber: filing() });
    const passedOwingPayment = company(tenant, { filingNumber: filing(), status: "draft" });
    const recheckedAfterReinstatement = company(tenant, {
      filingNumber: filing(),
      checks: ["passed", "revoked", "reinstated", "passed"],
    });
    for (const companyId of [passed, passedOwingPayment, recheckedAfterReinstatement]) {
      expect(companyEligible(deps, companyId), companyId).toBe(true);
      expect(createOrder(deps, tenant, { companyId }).state).toBe("draft");
    }

    const abandoned = company(tenant, { filingNumber: filing() });
    expect(s.companies.setStatus(abandoned, "ready", "abandoned")).toBe(true);
    const refusedCases: Record<string, string> = {
      unchecked: company(tenant, { filingNumber: filing(), checks: [] }),
      failed: company(tenant, { filingNumber: filing(), checks: ["failed"] }),
      revoked: company(tenant, { filingNumber: filing(), checks: ["passed", "revoked"] }),
      reinstatedNotRechecked: company(tenant, {
        filingNumber: filing(),
        checks: ["passed", "revoked", "reinstated"],
      }),
      abandoned,
      // A company filed through formation is never eligible here, even with a passed check.
      formation: company(tenant, { filingNumber: filing(), provider: FORMATION_PROVIDER }),
    };
    const before = rowCount();
    for (const [name, companyId] of Object.entries(refusedCases)) {
      expect(companyEligible(deps, companyId), name).toBe(false);
      refused(() => createOrder(deps, tenant, { companyId }), "company_not_eligible", 409);
    }
    expect(companyEligible(deps, "co_unknown")).toBe(false);
    expect(rowCount()).toBe(before);
  });

  test("the open cap counts every open order of the tenant, whatever its company, and no other tenant's", async () => {
    const deps = orderDeps();
    const first = company(tenant);
    const second = company(tenant, { filingNumber: "TEST-0002" });
    const theirs = company(otherTenant, { filingNumber: "TEST-0003" });

    // The other tenant fills its own cap first: it does not count against this tenant.
    for (let i = 0; i < 3; i++) createOrder(deps, otherTenant, { companyId: theirs });
    refused(() => createOrder(deps, otherTenant, { companyId: theirs }), "legal_body_cap", 409);

    const a = createOrder(deps, tenant, { companyId: first });
    createOrder(deps, tenant, { companyId: first });
    createOrder(deps, tenant, { companyId: second });
    for (const companyId of [first, second]) {
      const err = refused(() => createOrder(deps, tenant, { companyId }), "legal_body_cap", 409);
      expect(err.message).toBe(LEGAL_BODY_SENTENCES.legal_body_cap);
    }
    expect(s.repo.listByTenant(tenant)).toHaveLength(3);

    // A reserved order is still open; an abandoned draft is not.
    reserve(a.id);
    refused(() => createOrder(deps, tenant, { companyId: first }), "legal_body_cap", 409);
    const [, b] = s.repo.listByTenant(tenant);
    await abandonOrder(deps, tenant, b?.legalBodyId ?? "");
    expect(createOrder(deps, tenant, { companyId: second }).state).toBe("draft");
  });

  test("the daily order cap refuses the eleventh order in 24 hours, abandoned ones included", async () => {
    const companyId = company(tenant);
    const deps = orderDeps();
    for (let i = 0; i < 10; i++) {
      const view = createOrder(deps, tenant, { companyId });
      await abandonOrder(deps, tenant, view.id);
    }
    const err = refused(() => createOrder(deps, tenant, { companyId }), "legal_body_orders", 429);
    expect(err.message).toBe(LEGAL_BODY_SENTENCES.legal_body_orders);
    expect(rowCount()).toBe(10);

    // The window is 24 hours: a day later the same tenant may order again.
    const later = orderDeps({ now: () => Date.now() + DAY_MS + 2_000 });
    expect(createOrder(later, tenant, { companyId }).state).toBe("draft");
  });

  test("two orders at once with one place left create exactly one, each on its own connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lb-orders-"));
    const path = join(dir, "legalbody.db");
    const firstDb = openDatabase(path);
    migrate(firstDb);
    const secondDb = openDatabase(path);
    try {
      const one = openStack(firstDb);
      const two = openStack(secondDb, one.docStore);
      recordHuman(one.store, tenant, "3001", Date.now());
      const companyId = company(tenant, {}, one);
      const first = orderDeps({}, one);
      const second = orderDeps({}, two);
      createOrder(first, tenant, { companyId });
      createOrder(first, tenant, { companyId });

      const results = await Promise.allSettled(
        [first, second].map(async (deps) => createOrder(deps, tenant, { companyId })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expectRefusal(rejected[0]?.reason, "legal_body_cap", 409);
      expect(rowCount(one)).toBe(3);
      expect(rowCount(two)).toBe(3);
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store failure inside the transaction leaves no row and no event", () => {
    class ManifestWriteFails extends MemoryDocumentStore {
      override putBytes(name: string, bytes: Buffer) {
        if (name.startsWith("legal-body-manifest-")) throw new Error("the disk is full");
        return super.putBytes(name, bytes);
      }
    }
    const docStore = new ManifestWriteFails();
    const companyId = company(tenant);
    expect(() => createOrder(orderDeps({ docStore }), tenant, { companyId })).toThrow(
      "the disk is full",
    );
    expect(rowCount()).toBe(0);
    expect(eventCount()).toBe(0);
    // The terms were written first: an orphan file, named by an id no row holds.
    const orphans = [...docStore.files.keys()];
    expect(orphans).toHaveLength(1);
    const id = /^legal-body-terms-(lb_[0-9a-f-]{36})-v1\.md$/.exec(orphans[0] ?? "")?.[1];
    expect(id).toBeDefined();
    expect(s.repo.findById(id ?? "")).toBeUndefined();
  });

  test("a freeze that does not take rolls the new row back", () => {
    const repo = Object.create(s.repo) as SqliteLegalBodyRepository;
    repo.freezeAgreement = () => false;
    const companyId = company(tenant);
    expect(() => createOrder(orderDeps({ repo }), tenant, { companyId })).toThrow();
    expect(rowCount()).toBe(0);
    expect(eventCount()).toBe(0);
    // At most two orphan files, named by an id no row holds.
    expect(s.docStore.files.size).toBe(2);
  });
});

// ── abandonOrder and requireOwnedOrder ──────────────────────────────────────────────────────

describe("abandonOrder", () => {
  test("a draft becomes abandoned, written by the tenant", async () => {
    const deps = orderDeps();
    const view = createOrder(deps, tenant, { companyId: company(tenant) });
    const after = await abandonOrder(deps, tenant, view.id);
    expect(after.state).toBe("abandoned");
    expect(after).toEqual(toOrderView(rowOf(view.id)));
    const last = s.repo.listEvents(view.id).at(-1);
    expect(last?.kind).toBe("abandoned");
    expect(last?.actor).toBe("tenant");

    // Nothing leaves `abandoned`.
    const again = await refusedAsync(
      () => abandonOrder(deps, tenant, view.id),
      "order_closed",
      409,
    );
    expect(again.message).toBe(LEGAL_BODY_SENTENCES.order_closed);
  });

  test("a reserved order is a 409 and stays reserved", async () => {
    const deps = orderDeps();
    const view = createOrder(deps, tenant, { companyId: company(tenant) });
    reserve(view.id);
    await refusedAsync(() => abandonOrder(deps, tenant, view.id), "order_closed", 409);
    expect(s.repo.findById(view.id)?.bindingState).toBe("reserved");
  });

  test("another tenant's order and an unknown id get the same 404, and nothing moves", async () => {
    const deps = orderDeps();
    const view = createOrder(deps, tenant, { companyId: company(tenant) });
    const notYours = await refusedAsync(
      () => abandonOrder(deps, otherTenant, view.id),
      "not_found",
      404,
    );
    const unknown = await refusedAsync(
      () => abandonOrder(deps, otherTenant, "lb_00000000-0000-4000-8000-000000000000"),
      "not_found",
      404,
    );
    expect(notYours.message).toBe(unknown.message);
    expect(s.repo.findById(view.id)?.bindingState).toBe("draft");

    expect(requireOwnedOrder(deps, tenant, view.id).legalBodyId).toBe(view.id);
    const read = refused(() => requireOwnedOrder(deps, otherTenant, view.id), "not_found", 404);
    expect(read.message).toBe(notYours.message);
  });

  test("an order of another deployment is served, and every action on it is a 409 other_deployment", async () => {
    const deps = orderDeps();
    const companyId = company(tenant);
    const otherFactory = s.repo.create({
      tenantId: tenant,
      companyId,
      chainId: CHAIN_ID,
      factory: OTHER_FACTORY,
      amendmentDelay: 172_800,
    });
    const otherChain = s.repo.create({
      tenantId: tenant,
      companyId,
      chainId: CHAIN_ID + 1,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    for (const row of [otherFactory, otherChain]) {
      const owned = requireOwnedOrder(deps, tenant, row.legalBodyId);
      expect(toOrderView(owned).state).toBe("draft");
      const err = await refusedAsync(
        () => abandonOrder(deps, tenant, row.legalBodyId),
        "other_deployment",
        409,
      );
      expect(err.message).toBe(LEGAL_BODY_SENTENCES.other_deployment);
      expect(s.repo.findById(row.legalBodyId)?.bindingState).toBe("draft");
    }
  });

  test("the abandon waits for the order's lock, and two at once abandon once", async () => {
    const deps = orderDeps();
    const view = createOrder(deps, tenant, { companyId: company(tenant) });
    expect(orderLockKey(view.id)).toBe(`legal-body:${view.id}`);

    let release: () => void = () => {};
    const held = withKeyedLock(
      orderLockKey(view.id),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const results = Promise.allSettled([
      abandonOrder(deps, tenant, view.id),
      abandonOrder(deps, tenant, view.id),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.repo.findById(view.id)?.bindingState).toBe("draft");

    release();
    await held;
    const [first, second] = await results;
    expect(first?.status).toBe("fulfilled");
    expect(second?.status).toBe("rejected");
    if (second?.status === "rejected") expectRefusal(second.reason, "order_closed", 409);
    expect(s.repo.listEvents(view.id).filter((e) => e.kind === "abandoned")).toHaveLength(1);
  });
});

// ── The view ────────────────────────────────────────────────────────────────────────────────

describe("toOrderView", () => {
  test("the view serialises with JSON.stringify, and carries ids, hex, decimals and numbers only", () => {
    const deps = orderDeps();
    const view = createOrder(deps, tenant, { companyId: company(tenant) });
    reserve(view.id, 1_900_000_000);
    expect(s.repo.markDeployed(view.id, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(true);
    const row = rowOf(view.id);
    const deployed = toOrderView(row);

    for (const v of [view, deployed]) expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(Object.keys(deployed).sort()).toEqual(
      [
        "id",
        "publicId",
        "companyId",
        "state",
        "chainId",
        "factory",
        "guardian",
        "amendmentDelay",
        "agreement",
        "agentId",
        "identityOwner",
        "bodyAddress",
        "linkDeadline",
        "createTxHash",
        "deployedAt",
        "pointerSeenAt",
        "createdAt",
      ].sort(),
    );
    expect(deployed).toMatchObject({
      id: view.id,
      state: "deployed",
      agentId: "42",
      identityOwner: unverified,
      bodyAddress: BODY,
      linkDeadline: 1_900_000_000,
      createTxHash: H("c"),
      deployedAt: 1_800_000_000,
      pointerSeenAt: null,
    });
    // A draft has no link yet.
    expect(view).toMatchObject({
      agentId: null,
      identityOwner: null,
      bodyAddress: null,
      linkDeadline: null,
      createTxHash: null,
      deployedAt: null,
    });
    // The creation time in UTC, marked as UTC, from the stored text.
    expect(deployed.createdAt).toBe(`${row.createdAt.replace(" ", "T")}Z`);
    expect(deployed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The link's signature and digest stay out of the view.
    expect(JSON.stringify(deployed)).not.toContain(H("b"));
  });
});

// ── chainCall ───────────────────────────────────────────────────────────────────────────────

describe("chainCall", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  });

  test("a value passes through, and so does an ApiError, unchanged and unlogged", async () => {
    expect(await chainCall("lb_1", "head", async () => 7)).toBe(7);
    const own = new ApiError("identity_not_found", 422, "an answer of the door's own");
    await expect(
      chainCall("lb_1", "identity_owner", async () => {
        throw own;
      }),
    ).rejects.toBe(own);
    expect(lines).toEqual([]);
  });

  test("an error with a status and a URL becomes 503 chain_unavailable, with no URL in the body or the log", async () => {
    let caught: unknown;
    try {
      await chainCall("lb_9", "identity_owner", async () => {
        throw new TransportFailure();
      });
    } catch (e) {
      caught = e;
    }
    const err = expectRefusal(caught, "chain_unavailable", 503);
    expect(err.message).toBe(LEGAL_BODY_SENTENCES.chain_unavailable);

    // Rendered by the app's own error handler, which shows the message of any error it is given.
    const app = new Hono();
    app.onError(apiOnError);
    app.get("/", () => {
      throw err;
    });
    const res = await app.request("/");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body).error.code).toBe("chain_unavailable");
    expect(body).not.toContain("http");

    // One line: the order, the stage and the error's name, never its message.
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "{}");
    expect(line).toMatchObject({
      orderId: "lb_9",
      stage: "identity_owner",
      errorName: "HttpRequestError",
    });
    expect(lines[0]).not.toContain("http");
    expect(lines[0]).not.toContain("key-in-path");
  });

  test("a synchronous throw and a thrown value that is not an error are 503s too", async () => {
    await expect(
      chainCall(undefined, "head", () => {
        throw new TypeError("fetch failed: https://rpc.example");
      }),
    ).rejects.toMatchObject({ code: "chain_unavailable", status: 503 });
    await expect(
      chainCall("lb_2", "head", () => Promise.reject("https://rpc.example said no")),
    ).rejects.toMatchObject({ code: "chain_unavailable", status: 503 });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      orderId: null,
      stage: "head",
      errorName: "TypeError",
    });
    for (const line of lines) expect(line).not.toContain("http");
  });
});

// ── takeDoorTokens ──────────────────────────────────────────────────────────────────────────

describe("takeDoorTokens", () => {
  /** A bucket with this many tokens, counting what is taken from it. */
  const bucket = (tokens: number) => ({
    taken: 0,
    take() {
      if (tokens <= this.taken) return false;
      this.taken += 1;
      return true;
    },
  });

  test("one token from the tenant's bucket, then one from the doors' budget", () => {
    const mine = bucket(1);
    const budget = bucket(5);
    const asked: string[] = [];
    const deps = orderDeps({
      doorBudget: budget,
      tenantBucket: (tenantId) => {
        asked.push(tenantId);
        return mine;
      },
    });
    takeDoorTokens(deps, tenant);
    expect([mine.taken, budget.taken]).toEqual([1, 1]);
    expect(asked).toEqual([tenant]);

    // The tenant's bucket is empty: a 429, and the doors' budget is not touched.
    const err = refused(() => takeDoorTokens(deps, tenant), "rate_limited", 429);
    expect(err.message).toBe(LEGAL_BODY_SENTENCES.rate_limited);
    expect(budget.taken).toBe(1);
  });

  test("an empty doors' budget is a 429 too", () => {
    const deps = orderDeps({ doorBudget: bucket(0), tenantBucket: () => bucket(5) });
    refused(() => takeDoorTokens(deps, tenant), "rate_limited", 429);
  });
});

// ── The sentences ───────────────────────────────────────────────────────────────────────────

describe("refusal", () => {
  test("builds the ApiError from the table, details included", () => {
    const err = refusal("legal_body_cap", 409, { limit: "3" });
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "legal_body_cap", status: 409, details: { limit: "3" } });
    expect(err.message).toBe(LEGAL_BODY_SENTENCES.legal_body_cap);
  });

  test("a code with no sentence is a bug, not a refusal", () => {
    expect(() => refusal("no_such_code", 409)).toThrow(/no_such_code/);
    expect(() => refusal("toString", 409)).toThrow(/toString/);
  });

  test("every code this module answers has one plain sentence", () => {
    for (const code of [
      "not_found",
      "legal_text_not_approved",
      "company_not_eligible",
      "legal_body_cap",
      "legal_body_orders",
      "order_closed",
      "other_deployment",
      "chain_unavailable",
      "rate_limited",
    ]) {
      const sentence = LEGAL_BODY_SENTENCES[code];
      expect(sentence, code).toMatch(/^[A-Z].*\.$/);
      expect(sentence, code).not.toContain("http");
    }
    expect(Object.isFrozen(LEGAL_BODY_SENTENCES)).toBe(true);
  });
});
