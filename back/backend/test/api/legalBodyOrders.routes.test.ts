/**
 * The legal-body order doors on REST: order a body for a checked company, list the orders, read
 * one, read the agreement it will anchor, and abandon a draft. Mounted only where the deployment
 * wires them, under the session protection, each starting with the real-human check.
 *
 * Also the second half of a customer company's quote rule: it is quoted, and settled, only once
 * one of its legal bodies is linked.
 *
 * The database is real (in memory) and the chain is never called: every member of the chain port
 * throws. Every name, company and filing number is an invention, and every key is one of anvil's
 * published test accounts.
 */
import type Database from "better-sqlite3";
import { type Address, type Hex, keccak256, toBytes } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { bucketsByKey } from "../../src/api/routes/legalBodyOrders";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { agreementDocNames } from "../../src/legalBody/agreement";
import { type LegalBodyOrderDeps, toOrderView } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "../../src/legalBody/texts/operatingAgreement";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { formationPaymentDeps, requoteFormationPayment } from "../../src/workflow/formationPayment";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { MemoryDocumentStore } from "../helpers/formationFakes";
import { fakeChain, paymentCfg } from "../helpers/formationPayment";
import {
  BODY,
  H,
  JWT_SECRET,
  TransportFailure,
  answerOf,
  call,
  customerCompany,
  legalBodyOrderDeps,
  sessionOf,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. */
const owner = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;

/** An invented fee for a customer's company, in atomic USDC. */
const CUSTOMER_FEE = 7_000_000n;
/** What a customer's company is told while none of its legal bodies is linked. */
const NOT_LINKED = "this company has no linked legal body yet";

const ORDERS = "/legal-body-orders";
const orderPath = (id: string) => `${ORDERS}/${id}`;
const agreementPath = (id: string) => `${ORDERS}/${id}/agreement`;
const abandonPath = (id: string) => `${ORDERS}/${id}/abandon`;
const requotePath = (companyId: string) => `/companies/${companyId}/payment/requote`;
const settlePath = (companyId: string) => `/companies/${companyId}/payment/settle`;

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let store: SqliteWorldStore;
let legalBodies: SqliteLegalBodyRepository;
let docStore: MemoryDocumentStore;
let payments: SqliteFormationPaymentRepository;
let apiKeys: SqliteApiKeyStore;
/** The settlement's chain: it records every transaction it is asked to send. */
let chain: ReturnType<typeof fakeChain>;
/** Every console line written in the test: the ops lines among them. */
let lines: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  store = new SqliteWorldStore(db);
  legalBodies = new SqliteLegalBodyRepository(db);
  docStore = new MemoryDocumentStore();
  payments = new SqliteFormationPaymentRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  chain = fakeChain();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  recordHuman(store, owner.address, "3001", Date.now());
  recordHuman(store, stranger.address, "3002", Date.now());
  recordHuman(store, waived.address, "3003", Date.now(), "waiver");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors of a sandbox deployment (the agreement's wording is a draft, which only a sandbox
 *  serves), with room in every throttle. Every member of the chain port throws: these doors never
 *  read the chain. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(
    { db, companies, declarations, checks, store, repo: legalBodies, docStore },
    over,
  );
}

/**
 * The API over this test's database. The customer facts carry the linked-body read, as the
 * composition root wires them where the feature is on. The doors are mounted only when
 * `legalBodyOrders` is given; the payment doors only when `charging`.
 */
function makeApp(opts: { legalBodyOrders?: LegalBodyOrderDeps; charging?: boolean } = {}) {
  const requests = new SqliteFormationRepository(db);
  const parties = new SqliteFormationPartyRepository(db);
  const payment: FormationPaymentConfig = paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE });
  const pin = { provider: "example-formation-provider", environment: "sandbox" } as const;
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo,
    companies,
    docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations,
      checks,
      hasLinkedLegalBody: (companyId) => legalBodies.hasLinkedForCompany(companyId),
    },
    legalBodyOrders: opts.legalBodyOrders,
    formation: opts.charging
      ? {
          environment: "sandbox",
          required: true,
          sandboxSyntheticPii: false,
          maxPerTenant: 3,
          dailyCeiling: 10,
          maxAgentsPerCompany: 10,
          parties,
          requests,
          companies,
          pin,
          companyDeps: {
            companies,
            parties,
            requests,
            pin,
            sandboxSyntheticPii: false,
            maxPerTenant: 3,
            dailyCeiling: 10,
            payment,
          },
          payment,
          feeUsdc: 399,
          paymentExecutor: chain.executor,
        }
      : undefined,
    apiKeys,
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof makeApp>;

/** A checked customer company of `who`: its declaration, written straight to its table (the
 *  statement and its signature are placeholders), and one passed check. */
function checkedCompany(who: Address, status: "draft" | "ready" = "ready"): string {
  return customerCompany({ companies, declarations, checks }, who, { status });
}

/** An order placed through the door: its view. */
async function ordered(app: App, token: string, companyId: string) {
  const res = await answerOf(await call(app, "POST", ORDERS, token, { companyId }));
  expect(res.status).toBe(201);
  return res.body as ReturnType<typeof toOrderView>;
}

/** An order of `id` moved through the repository to `linked`, as the link door, the create and
 *  the binding check will move it. */
function link(id: string): void {
  expect(
    legalBodies.reserve(id, {
      agentId: "42",
      identityOwner: stranger.address,
      linkDigest: H("b"),
      linkDeadline: Math.floor(Date.now() / 1000) + 3600,
      linkSignature: "0x01",
      bodyAddress: BODY,
      observedAtBlock: 7,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
  expect(legalBodies.markDeployed(id, { txHash: H("c"), deployedAt: 1_800_000_000 })).toBe(true);
  expect(legalBodies.markLinked(id, 1_800_000_100)).toMatchObject({ outcome: "linked" });
}

/** Each door, with a body where it reads one. */
const doors = (id: string, companyId: string) =>
  [
    { method: "POST", path: ORDERS, body: { companyId } },
    { method: "GET", path: ORDERS },
    { method: "GET", path: orderPath(id) },
    { method: "GET", path: agreementPath(id) },
    { method: "POST", path: abandonPath(id), body: {} },
  ] as const;

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

// ── With the feature off ────────────────────────────────────────────────────────────────────

describe("with the feature off", () => {
  test("every door is a 404, with a session and without one", async () => {
    const app = makeApp();
    const token = await sessionOf(owner);
    for (const door of doors("lb_any", "co_any"))
      for (const t of [token, undefined]) {
        const res = await call(
          app,
          door.method,
          door.path,
          t,
          "body" in door ? door.body : undefined,
        );
        expect(res.status, `${door.method} ${door.path} ${t ? "with" : "without"} a session`).toBe(
          404,
        );
      }
  });
});

// ── The doors ───────────────────────────────────────────────────────────────────────────────

describe("the doors", () => {
  test("order: 201 with the view of a draft whose agreement is frozen, read from the stored row", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const companyId = checkedCompany(owner.address);
    const res = await answerOf(
      await call(app, "POST", ORDERS, await sessionOf(owner), { companyId }),
    );
    expect(res.status).toBe(201);
    const row = legalBodies.findById(res.body.id);
    expect(row).toBeDefined();
    if (!row) return;
    expect(res.body).toEqual(toOrderView(row));
    expect(res.body).toMatchObject({ companyId, state: "draft", guardian: owner.address });
    expect(res.body.agreement).toEqual({ hash: row.oaManifestHash, version: 1 });
  });

  test("list: the tenant's orders, newest first, and nothing of another tenant's", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const first = await ordered(app, token, checkedCompany(owner.address));
    const second = await ordered(app, token, checkedCompany(owner.address));
    await ordered(app, await sessionOf(stranger), checkedCompany(stranger.address));

    const res = await answerOf(await call(app, "GET", ORDERS, token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orders: [second.id, first.id].map((id) => {
        const row = legalBodies.findById(id);
        if (!row) throw new Error(`order ${id} is not stored`);
        return toOrderView(row);
      }),
    });
  });

  test("read: the order's view, as stored, with no chain call", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const view = await ordered(app, token, checkedCompany(owner.address));
    link(view.id);

    const res = await answerOf(await call(app, "GET", orderPath(view.id), token));
    expect(res.status).toBe(200);
    const row = legalBodies.findById(view.id);
    if (!row) throw new Error("the order is not stored");
    expect(res.body).toEqual(toOrderView(row));
    expect(res.body.state).toBe("linked");
  });

  test("agreement: the stored terms and manifest, which re-hash to the frozen hash and to the manifest's terms hash", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const view = await ordered(app, token, checkedCompany(owner.address));

    const res = await answerOf(await call(app, "GET", agreementPath(view.id), token));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["termsDoc", "manifest", "manifestHash", "textId", "textVersion", "textStatus"].sort(),
    );
    // What the caller checks: the manifest against the hash its link signs, the text against
    // the hash the manifest commits to.
    expect(res.body.manifestHash).toBe(view.agreement?.hash);
    expect(keccak256(toBytes(res.body.manifest))).toBe(res.body.manifestHash);
    expect(JSON.parse(res.body.manifest).terms.hash).toBe(keccak256(toBytes(res.body.termsDoc)));
    expect(res.body).toMatchObject({
      textId: LEGAL_BODY_OPERATING_AGREEMENT.id,
      textVersion: LEGAL_BODY_OPERATING_AGREEMENT.version,
      textStatus: LEGAL_BODY_OPERATING_AGREEMENT.status,
    });
    // The bytes on file, not a rendering of them.
    const names = agreementDocNames(view.id);
    expect(res.body.manifest).toBe(docStore.getBytes(names.manifest).toString("utf8"));
    expect(res.body.termsDoc).toBe(docStore.getBytes(names.terms).toString("utf8"));
  });

  test("agreement: a corrupted stored manifest answers 500 agreement_unreadable with the fixed sentence, and logs an error", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const view = await ordered(app, token, checkedCompany(owner.address));
    const names = agreementDocNames(view.id);
    const stored = docStore.getBytes(names.manifest);
    const corrupted = Buffer.from(stored);
    corrupted.writeUInt8(corrupted.readUInt8(10) ^ 0x01, 10);
    docStore.putBytes(names.manifest, corrupted);
    lines.length = 0;

    const res = await answerOf(await call(app, "GET", agreementPath(view.id), token));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "agreement_unreadable", message: LEGAL_BODY_SENTENCES.agreement_unreadable },
    });
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_agreement_unverifiable",
        level: "error",
        legalBodyId: view.id,
        reason: "manifest_rehash",
      }),
    ]);
  });

  test("abandon: a draft becomes abandoned, and a second abandon is a 409 that changes nothing", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const view = await ordered(app, token, checkedCompany(owner.address));

    const res = await answerOf(await call(app, "POST", abandonPath(view.id), token));
    expect(res.status).toBe(200);
    const row = legalBodies.findById(view.id);
    if (!row) throw new Error("the order is not stored");
    expect(res.body).toEqual(toOrderView(row));
    expect(res.body.state).toBe("abandoned");
    expect(legalBodies.listEvents(view.id).at(-1)).toMatchObject({
      kind: "abandoned",
      actor: "tenant",
    });

    const again = await answerOf(await call(app, "POST", abandonPath(view.id), token));
    expect(again).toMatchObject({
      status: 409,
      body: { error: { code: "order_closed", message: LEGAL_BODY_SENTENCES.order_closed } },
    });
  });
});

// ── Who may use the doors ───────────────────────────────────────────────────────────────────

describe("who may use the doors", () => {
  test("each door answers a caller with no session with 401", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    for (const door of doors("lb_any", "co_any")) {
      const res = await call(
        app,
        door.method,
        door.path,
        undefined,
        "body" in door ? door.body : undefined,
      );
      expect(res.status, `${door.method} ${door.path}`).toBe(401);
    }
  });

  test("another tenant, a verified human too, gets the uniform 404 on every door, and nothing moves", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const companyId = checkedCompany(owner.address);
    const view = await ordered(app, await sessionOf(owner), companyId);
    const before = legalBodies.findById(view.id);
    const theirs = await sessionOf(stranger);
    const notFound = {
      status: 404,
      body: { error: { code: "not_found", message: LEGAL_BODY_SENTENCES.not_found } },
    };

    for (const door of doors(view.id, companyId).filter(
      (d) => d.path !== ORDERS || d.method === "POST",
    )) {
      const res = await answerOf(
        await call(app, door.method, door.path, theirs, "body" in door ? door.body : undefined),
      );
      expect(res, `${door.method} ${door.path}`).toMatchObject(notFound);
    }
    // An unknown id gets the very same answer.
    for (const path of [orderPath("lb_unknown"), agreementPath("lb_unknown")])
      expect(await answerOf(await call(app, "GET", path, theirs)), path).toMatchObject(notFound);
    // The list door is the tenant's own, and holds none of the owner's orders.
    expect((await answerOf(await call(app, "GET", ORDERS, theirs))).body).toEqual({ orders: [] });

    expect(legalBodies.findById(view.id)).toEqual(before);
    expect(legalBodies.listByTenant(stranger.address)).toEqual([]);
  });

  test("a waiver tenant is refused on every door, the reads of its own order included", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    // Its company and order are written through the repositories: no door would make them.
    const companyId = checkedCompany(waived.address);
    const own = legalBodies.create({
      tenantId: waived.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const token = await sessionOf(waived);
    const rowsBefore = legalBodies.listByTenant(waived.address);

    for (const door of doors(own.legalBodyId, companyId)) {
      const res = await answerOf(
        await call(app, door.method, door.path, token, "body" in door ? door.body : undefined),
      );
      expect(res, `${door.method} ${door.path}`).toMatchObject({
        status: 403,
        body: { error: { code: "waiver_not_accepted" } },
      });
    }
    expect(legalBodies.listByTenant(waived.address)).toEqual(rowsBefore);
  });
});

// ── The body limit ──────────────────────────────────────────────────────────────────────────

describe("each JSON door takes a body of at most 8 KiB", () => {
  test("a 9 KiB body is refused on the order and abandon doors, and writes nothing", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const companyId = checkedCompany(owner.address);
    const view = await ordered(app, token, companyId);
    const nine = JSON.stringify({ companyId, padding: "x".repeat(9 * 1024) });

    for (const path of [ORDERS, abandonPath(view.id)]) {
      const res = await answerOf(await call(app, "POST", path, token, nine));
      expect(res, path).toMatchObject({
        status: 413,
        body: {
          error: { code: "payload_too_large", message: LEGAL_BODY_SENTENCES.payload_too_large },
        },
      });
    }
    expect(legalBodies.listByTenant(owner.address).map((r) => r.bindingState)).toEqual(["draft"]);
  });
});

// ── What escapes a domain function ──────────────────────────────────────────────────────────

describe("an error a door did not choose", () => {
  test("a plain error answers 500 internal_error with the fixed sentence on every door, and one line names the door and the error", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const companyId = checkedCompany(owner.address);
    const view = await ordered(app, token, companyId);
    // The real-human check, the first step of every door, reads this store.
    vi.spyOn(store, "findByTenant").mockImplementation(() => {
      throw new Error("disk I/O error at /var/lib/example/legalbody.db");
    });

    for (const door of doors(view.id, companyId)) {
      lines.length = 0;
      const res = await answerOf(
        await call(app, door.method, door.path, token, "body" in door ? door.body : undefined),
      );
      expect(res, `${door.method} ${door.path}`).toMatchObject({
        status: 500,
        body: { error: { code: "internal_error", message: LEGAL_BODY_SENTENCES.internal_error } },
      });
      expect(res.text).not.toContain("/var");
      expect(opsLines()).toEqual([
        expect.objectContaining({
          opslog: "legal_body_door_failed",
          level: "error",
          errorName: "Error",
        }),
      ]);
      expect(lines.join("\n")).not.toContain("/var");
    }
  });

  test("an error carrying status 429 and a URL still answers 500, with no http in the body or the log", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const companyId = checkedCompany(owner.address);
    const view = await ordered(app, token, companyId);
    vi.spyOn(store, "findByTenant").mockImplementation(() => {
      throw new TransportFailure();
    });

    for (const door of doors(view.id, companyId)) {
      lines.length = 0;
      const res = await answerOf(
        await call(app, door.method, door.path, token, "body" in door ? door.body : undefined),
      );
      expect(res.status, `${door.method} ${door.path}`).toBe(500);
      expect(res.body.error.code).toBe("internal_error");
      expect(res.text).not.toContain("http");
      expect(opsLines()).toEqual([
        expect.objectContaining({
          opslog: "legal_body_door_failed",
          errorName: "HttpRequestError",
        }),
      ]);
      expect(lines.join("\n")).not.toContain("http");
    }
  });
});

// ── The quote rule ──────────────────────────────────────────────────────────────────────────

/** A served quote, as a caller receives it over the wire. */
interface ServedQuote {
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string>;
  };
}

/** The guardian's wallet signs the served typed data, converting only the three uint256 strings
 *  viem wants as bigints, as a browser client does. */
async function signServed(td: ServedQuote["typedData"]): Promise<Hex> {
  return owner.signTypedData({
    // biome-ignore lint/suspicious/noExplicitAny: a served EIP-712 request, typed at the wire
    domain: td.domain as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    types: td.types as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    primaryType: td.primaryType as any,
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value!),
      validAfter: BigInt(td.message.validAfter!),
      validBefore: BigInt(td.message.validBefore!),
      nonce: td.message.nonce,
      // biome-ignore lint/suspicious/noExplicitAny: as above
    } as any,
  }) as Promise<Hex>;
}

describe("a customer company is quoted and settled only once one of its legal bodies is linked", () => {
  test("its quote is refused until its order is linked, then allowed; a settlement after the link broke is refused, and sends nothing", async () => {
    const app = makeApp({ legalBodyOrders: orderDeps(), charging: true });
    const token = await sessionOf(owner);
    // A company that owes its payment, as the declaration door writes it where the deployment
    // charges, and has passed its check.
    const companyId = checkedCompany(owner.address, "draft");
    const view = await ordered(app, token, companyId);

    const refused = await answerOf(await call(app, "POST", requotePath(companyId), token));
    expect(refused).toMatchObject({
      status: 400,
      body: { error: { code: "validation_error", message: NOT_LINKED } },
    });
    expect(payments.findCurrent(companyId, "formation")).toBeUndefined();

    link(view.id);
    const quoted = await answerOf(await call(app, "POST", requotePath(companyId), token));
    expect(quoted.status).toBe(201);
    expect(quoted.body.amountUsdc).toBe(CUSTOMER_FEE.toString());
    const signature = await signServed((quoted.body as ServedQuote).typedData);

    // The settlement asks again, at the moment it is submitted.
    expect(legalBodies.markBroken(view.id, { reason: "replaced" })).toBe(true);
    const settle = await answerOf(
      await call(app, "POST", settlePath(companyId), token, { signature, from: owner.address }),
    );
    expect(settle).toMatchObject({
      status: 400,
      body: { error: { code: "validation_error", message: NOT_LINKED } },
    });
    expect(chain.sent).toHaveLength(0);
    expect(payments.findCurrent(companyId, "formation")?.status).toBe("quoted");
    expect(companies.find(companyId)?.status).toBe("draft");
  });

  test("formationPaymentDeps passes the linked-body read on; without it a customer company is never quoted", () => {
    const companyId = checkedCompany(owner.address, "draft");
    const view = legalBodies.create({
      tenantId: owner.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    expect(legalBodies.freezeAgreement(view.legalBodyId, { hash: H("a"), version: 1 })).toBe(true);
    link(view.legalBodyId);
    const hasLinkedLegalBody = (id: string) => legalBodies.hasLinkedForCompany(id);
    const base = {
      companies,
      repo,
      formation: {
        payment: paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE }),
        paymentExecutor: chain.executor,
      },
    };

    const wired = formationPaymentDeps({ ...base, customerFacts: { checks, hasLinkedLegalBody } });
    expect(wired?.hasLinkedLegalBody).toBe(hasLinkedLegalBody);
    const unwired = formationPaymentDeps({ ...base, customerFacts: { checks } });
    expect(unwired?.hasLinkedLegalBody).toBeUndefined();

    const company = companies.find(companyId);
    if (!company || !unwired || !wired) throw new Error("the fixture is incomplete");
    expect(requoteFormationPayment(unwired, company)).toEqual({ ok: false, reason: NOT_LINKED });
    expect(payments.findCurrent(companyId, "formation")).toBeUndefined();
    expect(requoteFormationPayment(wired, company)).toMatchObject({ ok: true });
  });
});

// ── The doors' bucket maps ──────────────────────────────────────────────────────────────────

describe("bucketsByKey", () => {
  test("each key has its own bucket, kept between calls", () => {
    const buckets = bucketsByKey(2, 0);
    expect(buckets("a").take()).toBe(true);
    expect(buckets("a").take()).toBe(true);
    expect(buckets("a").take()).toBe(false);
    expect(buckets("b").take()).toBe(true);
  });

  test("it holds at most its bound of keys, and forgets the least recently used first", () => {
    const buckets = bucketsByKey(1, 0, 2);
    expect(buckets("a").take()).toBe(true);
    expect(buckets("b").take()).toBe(true);
    // "a" used again: "b" is now the least recently used, and the third key pushes it out.
    expect(buckets("a").take()).toBe(false);
    expect(buckets("c").take()).toBe(true);
    expect(buckets("a").take()).toBe(false);
    // Forgotten: it starts again with a full bucket.
    expect(buckets("b").take()).toBe(true);
  });
});
