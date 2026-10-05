/**
 * The two link doors on REST: the message an identity's owner signs for an order, and the signed
 * link, accepted up to the reserve. Mounted with the other order doors, under the session
 * protection, each starting with the real-human check.
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers. Every
 * name, company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LegalBodyChainFaultError,
  LegalBodyGasTooHighError,
} from "../../src/adapters/arc/legalBodyChain";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { type LegalBodyOrderDeps, toOrderView } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  type FakeLinkChainMembers,
  H,
  IDENTITY_OWNER,
  JWT_SECRET,
  LINK_HEAD,
  type LegalBodyStores,
  TransportFailure,
  answerOf,
  asChainPort,
  call,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  sessionOf,
  signedLink,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. The guardian and a
 *  stranger are verified humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;
/** The identity's owner signs the links. */
const owner = IDENTITY_OWNER;

const messagePath = (id: string) => `/legal-body-orders/${id}/link-message`;
const linkPath = (id: string) => `/legal-body-orders/${id}/link`;

let db: Database.Database;
let s: LegalBodyStores;
let chain: FakeLinkChainMembers;
/** Every console line written in the test: the ops lines among them. */
let lines: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  chain = fakeLinkChainMembers();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  recordHuman(s.store, guardian.address, "3001", Date.now());
  recordHuman(s.store, stranger.address, "3002", Date.now());
  recordHuman(s.store, waived.address, "3003", Date.now(), "waiver");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors of a sandbox deployment over the fake chain, with room in every throttle. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: asChainPort(chain), ...over });
}

/** The API over this test's database; the order doors only when `legalBodyOrders` is given. */
function makeApp(legalBodyOrders?: LegalBodyOrderDeps) {
  const requests = new SqliteFormationRepository(db);
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: s.declarations,
      checks: s.checks,
      hasLinkedLegalBody: (companyId) => s.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders,
    apiKeys: new SqliteApiKeyStore(db),
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

let filings = 0;
/** A draft of `who` for a checked company of its own, as the order door makes one. */
async function ordered(app: ReturnType<typeof makeApp>, who = guardian): Promise<LegalBodyRecord> {
  const companyId = customerCompany(s, who.address, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const res = await answerOf(
    await call(app, "POST", "/legal-body-orders", await sessionOf(who), { companyId }),
  );
  expect(res.status).toBe(201);
  const row = s.repo.findById(res.body.id);
  if (!row) throw new Error("the order is not stored");
  return row;
}

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** Every row and every event, to show that a request wrote nothing. */
function snapshot() {
  return {
    rows: db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all(),
    events: db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
  };
}

/** The served typed data, signed as a wallet signs it: the three uint256 strings as bigints. */
async function signServed(td: {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, string>;
}): Promise<Hex> {
  return owner.signTypedData({
    // biome-ignore lint/suspicious/noExplicitAny: a served EIP-712 request, typed at the wire
    domain: td.domain as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    types: td.types as any,
    // biome-ignore lint/suspicious/noExplicitAny: as above
    primaryType: td.primaryType as any,
    message: {
      agentId: BigInt(td.message.agentId ?? ""),
      guardian: td.message.guardian,
      amendmentDelay: BigInt(td.message.amendmentDelay ?? ""),
      operatingAgreementHash: td.message.operatingAgreementHash,
      deadline: BigInt(td.message.deadline ?? ""),
      // biome-ignore lint/suspicious/noExplicitAny: as above
    } as any,
  }) as Promise<Hex>;
}

/** Moves a reserved order on through the repository, as the create and the binding check will. */
function deploy(id: string): void {
  expect(s.repo.markDeployed(id, { txHash: H("c"), deployedAt: Number(LINK_HEAD.timestamp) })).toBe(
    true,
  );
}

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

/** Both doors of one order, each named as its error line names it, with a well-formed body. */
async function doors(
  row: LegalBodyRecord,
): Promise<{ door: string; path: string; body: object }[]> {
  const signed = await signedLink(linkFor(row));
  return [
    { door: "link_message", path: messagePath(row.legalBodyId), body: { agentId: "42" } },
    { door: "link", path: linkPath(row.legalBodyId), body: signed },
  ];
}

// ── With the feature off ────────────────────────────────────────────────────────────────────

describe("with the feature off", () => {
  test("both doors are a 404, with a session and without one", async () => {
    const app = makeApp();
    const token = await sessionOf(guardian);
    for (const path of [messagePath("lb_any"), linkPath("lb_any")])
      for (const t of [token, undefined])
        expect((await call(app, "POST", path, t, {})).status, path).toBe(404);
  });
});

// ── The doors ───────────────────────────────────────────────────────────────────────────────

describe("the link doors", () => {
  test("link-message serves the typed data, the owner and the deadline and writes nothing; the owner signs it as served, and link answers 202 with the reserved order", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    const before = snapshot();

    const served = await answerOf(
      await call(app, "POST", messagePath(row.legalBodyId), token, { agentId: "42" }),
    );
    expect(served.status).toBe(200);
    expect(Object.keys(served.body).sort()).toEqual(["deadline", "identityOwner", "typedData"]);
    expect(served.body.identityOwner).toBe(owner.address);
    expect(served.body.deadline).toBe(Number(LINK_HEAD.timestamp) + 3_600);
    expect(served.body.typedData.message).toEqual({
      agentId: "42",
      guardian: guardian.address,
      amendmentDelay: "172800",
      operatingAgreementHash: row.oaManifestHash,
      deadline: String(Number(LINK_HEAD.timestamp) + 3_600),
    });
    expect(served.body.typedData.domain).toMatchObject({
      chainId: CHAIN_ID,
      verifyingContract: FACTORY,
    });
    expect(snapshot()).toEqual(before);

    const signature = await signServed(served.body.typedData);
    const linked = await answerOf(
      await call(app, "POST", linkPath(row.legalBodyId), token, {
        message: served.body.typedData.message,
        signature,
      }),
    );
    expect(linked.status).toBe(202);
    expect(linked.body).toEqual(toOrderView(rowOf(row.legalBodyId)));
    expect(linked.body.state).toBe("reserved");
    expect(rowOf(row.legalBodyId).linkSignature).toBe(signature.toLowerCase());
  });

  test("a repeated link on a reserved order is a 202, on a deployed or linked one a 200, each with the order and nothing changed", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    const signed = await signedLink(linkFor(row));
    expect((await call(app, "POST", linkPath(row.legalBodyId), token, signed)).status).toBe(202);

    const moves: [number, () => void][] = [
      [202, () => {}],
      [200, () => deploy(row.legalBodyId)],
      [
        200,
        () =>
          expect(
            s.repo.markLinked(row.legalBodyId, Number(LINK_HEAD.timestamp) + 10),
          ).toMatchObject({ outcome: "linked" }),
      ],
    ];
    for (const [status, move] of moves) {
      move();
      const before = snapshot();
      const again = await answerOf(
        await call(app, "POST", linkPath(row.legalBodyId), token, signed),
      );
      expect(again.status).toBe(status);
      expect(again.body).toEqual(toOrderView(rowOf(row.legalBodyId)));
      expect(snapshot()).toEqual(before);
    }
    expect(chain.estimateCreate).toHaveBeenCalledOnce();
  });

  test("a refusal of the link is a 422 with its code, its fixed sentence, its detail as strings and the order, and the draft is kept", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    chain.estimateCreate.mockRejectedValueOnce(new LegalBodyGasTooHighError(30_000_000n));
    const before = snapshot();

    const res = await answerOf(
      await call(app, "POST", linkPath(row.legalBodyId), token, await signedLink(linkFor(row))),
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      code: "gas_too_high",
      message: LEGAL_BODY_SENTENCES.gas_too_high,
      detail: {
        identityOwner: owner.address,
        bodyAddress: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        gasEstimate: "30000000",
      },
      order: toOrderView(row),
    });
    expect(snapshot()).toEqual(before);
  });

  test("an identity the registry does not know is a 422 identity_not_found on the message door", async () => {
    const app = makeApp(orderDeps());
    const row = await ordered(app);
    chain.identityOwner.mockResolvedValueOnce(undefined);
    const res = await answerOf(
      await call(app, "POST", messagePath(row.legalBodyId), await sessionOf(guardian), {
        agentId: "42",
      }),
    );
    expect(res).toMatchObject({
      status: 422,
      body: {
        error: { code: "identity_not_found", message: LEGAL_BODY_SENTENCES.identity_not_found },
      },
    });
  });
});

// ── When the chain cannot answer ────────────────────────────────────────────────────────────

describe("when the chain cannot answer", () => {
  test("a transport error carrying a URL, or a platform fault, is a 503 with no http in the body or the log, and the row is still a draft", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    const signed = await signedLink(linkFor(row));
    const failures: [string, string, object, () => void][] = [
      [
        "the message door's head",
        messagePath(row.legalBodyId),
        { agentId: "42" },
        () => chain.head.mockRejectedValueOnce(new TransportFailure()),
      ],
      [
        "the check's simulation",
        linkPath(row.legalBodyId),
        signed,
        () => chain.estimateCreate.mockRejectedValueOnce(new TransportFailure()),
      ],
      [
        "a platform fault",
        linkPath(row.legalBodyId),
        signed,
        () =>
          chain.estimateCreate.mockRejectedValueOnce(new LegalBodyChainFaultError("NotAuthorized")),
      ],
    ];
    for (const [what, path, body, fail] of failures) {
      fail();
      lines.length = 0;
      const before = snapshot();
      const res = await answerOf(await call(app, "POST", path, token, body));
      expect(res, what).toMatchObject({
        status: 503,
        body: {
          error: { code: "chain_unavailable", message: LEGAL_BODY_SENTENCES.chain_unavailable },
        },
      });
      expect(res.text, what).not.toContain("http");
      expect(lines.join("\n"), what).not.toContain("http");
      expect(opsLines(), what).toEqual([
        expect.objectContaining({
          opslog: "legal_body_chain_unavailable",
          orderId: row.legalBodyId,
        }),
      ]);
      expect(snapshot(), what).toEqual(before);
    }
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
  });
});

// ── Who may use the doors ───────────────────────────────────────────────────────────────────

describe("who may use the link doors", () => {
  test("a caller with no session is a 401 on both doors", async () => {
    const app = makeApp(orderDeps());
    for (const path of [messagePath("lb_any"), linkPath("lb_any")])
      expect((await call(app, "POST", path, undefined, {})).status, path).toBe(401);
  });

  test("a waiver tenant is refused on both doors, its own order included", async () => {
    const app = makeApp(orderDeps());
    const companyId = customerCompany(s, waived.address, { filingNumber: "TEST-0900" });
    const own = s.repo.create({
      tenantId: waived.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const token = await sessionOf(waived);
    const before = snapshot();
    for (const path of [messagePath(own.legalBodyId), linkPath(own.legalBodyId)]) {
      const res = await answerOf(await call(app, "POST", path, token, { agentId: "42" }));
      expect(res, path).toMatchObject({
        status: 403,
        body: { error: { code: "waiver_not_accepted" } },
      });
    }
    expect(snapshot()).toEqual(before);
  });

  test("another tenant gets the uniform 404 on both doors, a deployed order included, never the order's view", async () => {
    const app = makeApp(orderDeps());
    const row = await ordered(app);
    const signed = await signedLink(linkFor(row));
    expect(
      (await call(app, "POST", linkPath(row.legalBodyId), await sessionOf(guardian), signed))
        .status,
    ).toBe(202);
    deploy(row.legalBodyId);
    const theirs = await sessionOf(stranger);
    const notFound = {
      status: 404,
      body: { error: { code: "not_found", message: LEGAL_BODY_SENTENCES.not_found } },
    };
    const before = snapshot();
    for (const id of [row.legalBodyId, "lb_unknown"]) {
      for (const [path, body] of [
        [messagePath(id), { agentId: "42" }],
        [linkPath(id), signed],
      ] as const) {
        const res = await answerOf(await call(app, "POST", path, theirs, body));
        expect(res, path).toMatchObject(notFound);
        expect(res.text, path).not.toContain(row.publicId);
      }
    }
    expect(snapshot()).toEqual(before);
  });
});

// ── What a request may carry ────────────────────────────────────────────────────────────────

describe("what a request may carry", () => {
  test("a signature of 2,049 bytes and a message with an extra field are 400s, and nothing is written", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    const signed = await signedLink(linkFor(row));
    const before = snapshot();

    const long = await answerOf(
      await call(app, "POST", linkPath(row.legalBodyId), token, {
        message: signed.message,
        signature: `0x${"ab".repeat(2_049)}`,
      }),
    );
    expect(long).toMatchObject({
      status: 400,
      body: {
        error: { code: "malformed_signature", message: LEGAL_BODY_SENTENCES.malformed_signature },
      },
    });
    const extra = await answerOf(
      await call(app, "POST", linkPath(row.legalBodyId), token, {
        message: { ...signed.message, extra: "1" },
        signature: signed.signature,
      }),
    );
    expect(extra).toMatchObject({
      status: 400,
      body: { error: { code: "malformed_link", message: LEGAL_BODY_SENTENCES.malformed_link } },
    });
    expect(snapshot()).toEqual(before);
    expect(chain.head).not.toHaveBeenCalled();
  });

  test("a body above 8 KiB is a 413 on both doors", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    const nine = JSON.stringify({ agentId: "42", padding: "x".repeat(9 * 1024) });
    for (const path of [messagePath(row.legalBodyId), linkPath(row.legalBodyId)])
      expect(await answerOf(await call(app, "POST", path, token, nine)), path).toMatchObject({
        status: 413,
        body: { error: { code: "payload_too_large" } },
      });
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
  });

  test("an error a door did not choose answers 500 internal_error with the fixed sentence, and its line names the door", async () => {
    const app = makeApp(orderDeps());
    const token = await sessionOf(guardian);
    const row = await ordered(app);
    const requests = await doors(row);
    // The real-human check, the first step of both doors, reads this store.
    vi.spyOn(s.store, "findByTenant").mockImplementation(() => {
      throw new TransportFailure();
    });
    for (const { door, path, body } of requests) {
      lines.length = 0;
      const res = await answerOf(await call(app, "POST", path, token, body));
      expect(res, door).toMatchObject({
        status: 500,
        body: { error: { code: "internal_error", message: LEGAL_BODY_SENTENCES.internal_error } },
      });
      expect(res.text, door).not.toContain("http");
      expect(opsLines(), door).toEqual([
        expect.objectContaining({
          opslog: "legal_body_door_failed",
          door,
          errorName: "HttpRequestError",
        }),
      ]);
    }
  });
});
