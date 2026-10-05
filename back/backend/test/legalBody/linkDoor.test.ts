/**
 * The link door: the EIP-712 message an identity's owner signs for an order, and the signed link,
 * accepted up to the reserve. The link is checked by simulation, the other orders for the same
 * identity give way to the current owner's fresh signature, and the identity is reserved for this
 * order, in one transaction. What happens after the reserve is the caller's (`after.create`).
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers. Every
 * name, company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import { type Address, type Hex, getAddress, parseSignature } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LegalBodyChainFaultError,
  LegalBodyGasTooHighError,
} from "../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { bucketsByKey } from "../../src/api/routes/legalBodyOrders";
import { ApiError } from "../../src/errors";
import { agreementDocNames, buildAgreement, storeAgreement } from "../../src/legalBody/agreement";
import type { LinkRefusalCode } from "../../src/legalBody/checkLink";
import {
  type LegalBodyLink,
  MAX_SERVED_LINK_TTL_SECONDS,
  linkTypedDataWire,
  offChainLinkDigest,
} from "../../src/legalBody/link";
import {
  type LinkSubmitResult,
  MAX_LINK_SIGNATURE_BYTES,
  MIN_SERVED_LINK_TTL_SECONDS,
  linkMessage,
  submitLink,
} from "../../src/legalBody/linkDoor";
import {
  type LegalBodyOrderDeps,
  createOrder,
  orderLockKey,
  toOrderView,
} from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import type { LegalText } from "../../src/legalBody/texts/index";
import {
  type AgreementFields,
  LEGAL_BODY_OPERATING_AGREEMENT,
} from "../../src/legalBody/texts/operatingAgreement";
import { withKeyedLock } from "../../src/payments/keyedMutex";
import { migrate, openDatabase } from "../../src/persistence/db";
import { type LegalBodyRecord, isDraftExpired } from "../../src/persistence/legalBodyRepository";
import { parseSqliteUtc } from "../../src/util/sqliteTime";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  DAY_MS,
  type FakeLinkChainMembers,
  H,
  IDENTITY_OWNER,
  LINK_HEAD,
  type LegalBodyStores,
  OTHER_FACTORY,
  REGISTRY,
  TransportFailure,
  appendCheck,
  asChainPort,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  signedLink,
} from "../helpers/legalBodyFixtures";

/** Two verified humans; the identity's owner signs every link. */
const tenant = ANVIL_ACCOUNT_2.address;
const otherTenant = ANVIL_ACCOUNT_3.address;
const owner = IDENTITY_OWNER;
/** Placeholders: an identity's previous owner, and a tenant that verified with a waiver. */
const PREVIOUS_OWNER = getAddress("0x00000000000000000000000000000000000001d0");
const WAIVED = getAddress("0x000000000000000000000000000000000000fa1e");
/** The head of a second read, a block after the first. */
const LATER_HEAD = { number: LINK_HEAD.number + 1n, timestamp: LINK_HEAD.timestamp + 2n };
const HOUR_MS = 60 * 60 * 1000;

let s: LegalBodyStores;
let chain: FakeLinkChainMembers;
let lines: string[];
let filings = 0;
let bodies = 0;

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, tenant, "3001", Date.now());
  recordHuman(s.store, otherTenant, "3002", Date.now());
  recordHuman(s.store, WAIVED, "3003", Date.now(), "waiver");
  chain = fakeLinkChainMembers();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** The doors' deps over the fake chain, with room in every throttle. */
function deps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: asChainPort(chain), ...over });
}

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of `who`, placed through the order door for a company of its own. */
function draft(who: Address = tenant): LegalBodyRecord {
  const companyId = customerCompany(s, who, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const view = createOrder(deps({ maxOpenPerTenant: 50, maxOrdersPerTenantPerDay: 50 }), who, {
    companyId,
  });
  return rowOf(view.id);
}

/** A placeholder body address no other row holds. */
function freshBody(): Address {
  return getAddress(`0x${"0".repeat(32)}b0d1${(++bodies).toString(16).padStart(4, "0")}`);
}

/** An order of `who` moved to `reserved` through the repository, as an earlier link reserved it. */
function reservedOrder(
  who: Address,
  p: { agentId: string; identityOwner: Address; bodyAddress?: Address },
): LegalBodyRecord {
  const row = draft(who);
  expect(
    s.repo.reserve(row.legalBodyId, {
      agentId: p.agentId,
      identityOwner: p.identityOwner,
      linkDigest: H("b"),
      linkDeadline: Number(LINK_HEAD.timestamp) + 3_600,
      linkSignature: "0x01",
      bodyAddress: p.bodyAddress ?? freshBody(),
      observedAtBlock: 7,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
  return rowOf(row.legalBodyId);
}

/** As `reservedOrder`, then created on chain. */
function deployedOrder(
  who: Address,
  p: { agentId: string; identityOwner: Address },
): LegalBodyRecord {
  const row = reservedOrder(who, p);
  expect(
    s.repo.markDeployed(row.legalBodyId, {
      txHash: H("c"),
      deployedAt: Number(LINK_HEAD.timestamp) - 100,
    }),
  ).toBe(true);
  return rowOf(row.legalBodyId);
}

/** What happens once the row is reserved: here, nothing but the answer `reserved`. */
function afterReserve() {
  return {
    create: vi.fn(
      async (row: LegalBodyRecord, _blockTime: number): Promise<LinkSubmitResult> => ({
        status: "reserved",
        order: toOrderView(row),
      }),
    ),
  };
}

/** Submits the order's link, signed by the identity's owner unless a signature is given. */
async function submitFor(
  row: LegalBodyRecord,
  p: {
    who?: Address;
    deps?: LegalBodyOrderDeps;
    link?: Partial<LegalBodyLink>;
    signature?: Hex;
    message?: unknown;
    after?: ReturnType<typeof afterReserve>;
  } = {},
): Promise<LinkSubmitResult> {
  const signed = await signedLink({ ...linkFor(row), ...p.link });
  return submitLink(
    p.deps ?? deps(),
    p.who ?? row.tenantId,
    row.legalBodyId,
    {
      message: "message" in p ? p.message : signed.message,
      signature: "signature" in p ? (p.signature as Hex) : signed.signature,
    },
    p.after ?? afterReserve(),
  );
}

/** Every row and every event, to show that a call wrote nothing. */
function snapshot() {
  return {
    rows: s.db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all(),
    events: s.db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
  };
}

async function refusedAsync(
  run: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<ApiError> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected the refusal ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect(err.code).toBe(code);
  expect(err.status).toBe(status);
  expect(err.message).toBe(LEGAL_BODY_SENTENCES[code]);
  return err;
}

/** How many times the fake chain was read. */
function chainReads(): number {
  return (
    [
      "head",
      "identityOwner",
      "hasCode",
      "linkDigest",
      "predictLegalBody",
      "bodyCreator",
      "estimateCreate",
    ] as const
  ).reduce((n, m) => n + chain[m].mock.calls.length, 0);
}

/** The body the fake chain predicts for this link. */
function predictedBody(link: LegalBodyLink): Address {
  return getAddress(
    `0x${offChainLinkDigest({ chainId: CHAIN_ID, factory: FACTORY, link }).slice(-40)}`,
  );
}

/** A draft whose agreement was built on `text`, stored and frozen, as an order made under it. */
function draftOnText(text: LegalText<AgreementFields>): LegalBodyRecord {
  const companyId = customerCompany(s, tenant, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const created = s.repo.create({
    tenantId: tenant,
    companyId,
    chainId: CHAIN_ID,
    factory: FACTORY,
    amendmentDelay: 172_800,
  });
  const built = buildAgreement(
    {
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      jurisdiction: "WY",
      guardian: tenant,
      amendmentDelaySeconds: 172_800,
      chainId: CHAIN_ID,
      factory: FACTORY,
      identityRegistry: REGISTRY,
    },
    text,
  );
  storeAgreement(s.docStore, created.legalBodyId, built);
  expect(
    s.repo.freezeAgreement(created.legalBodyId, { hash: built.manifestHash, version: 1 }),
  ).toBe(true);
  return rowOf(created.legalBodyId);
}

/** Flips one bit of the order's stored manifest. */
function corruptAgreement(id: string): void {
  const names = agreementDocNames(id);
  const bytes = Buffer.from(s.docStore.getBytes(names.manifest));
  bytes.writeUInt8(bytes.readUInt8(10) ^ 0x01, 10);
  s.docStore.putBytes(names.manifest, bytes);
}

/** The factory's refusal of a create, as the relayed create's simulation reports it. */
const revert = (errorName: string | undefined) =>
  new ContractRevertError(`createLegalBody reverted: ${errorName ?? "unknown"}`, errorName);

// ── linkMessage ─────────────────────────────────────────────────────────────────────────────

describe("linkMessage", () => {
  test("serves the order's link as typed data, with a deadline counted from the chain's time, and writes nothing", async () => {
    const row = draft();
    const before = snapshot();

    const served = await linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42" });
    const deadline = LINK_HEAD.timestamp + 3_600n;
    expect(served).toEqual({
      typedData: linkTypedDataWire({
        chainId: CHAIN_ID,
        factory: FACTORY,
        link: {
          agentId: 42n,
          guardian: tenant,
          amendmentDelay: 172_800n,
          operatingAgreementHash: row.oaManifestHash as Hex,
          deadline,
        },
      }),
      identityOwner: owner.address,
      deadline: Number(deadline),
    });
    expect(JSON.parse(JSON.stringify(served))).toEqual(served);
    // The owner is read at the head the deadline is counted from.
    expect(chain.identityOwner).toHaveBeenCalledWith(42n, LINK_HEAD.number);

    // A lifetime the caller chooses, at both ends of what is served.
    for (const ttl of [600, 85_800]) {
      const chosen = await linkMessage(deps(), tenant, row.legalBodyId, {
        agentId: "42",
        ttlSeconds: ttl,
      });
      expect(chosen.deadline).toBe(Number(LINK_HEAD.timestamp) + ttl);
      expect(chosen.typedData.message.deadline).toBe(String(Number(LINK_HEAD.timestamp) + ttl));
    }
    expect(MIN_SERVED_LINK_TTL_SECONDS).toBe(600n);
    expect(MAX_SERVED_LINK_TTL_SECONDS).toBe(85_800n);

    // The largest agentId a uint256 holds is served too.
    const max = (2n ** 256n - 1n).toString();
    const big = await linkMessage(deps(), tenant, row.legalBodyId, { agentId: max });
    expect(big.typedData.message.agentId).toBe(max);

    expect(snapshot()).toEqual(before);
  });

  test("a lifetime below 600 or above 85,800 seconds, or not a whole number, is refused before the chain is read", async () => {
    const row = draft();
    for (const ttl of [599, 85_801, 600.5, 0, -1, "3600", null, Number.NaN]) {
      await refusedAsync(
        () =>
          linkMessage(deps(), tenant, row.legalBodyId, {
            agentId: "42",
            ttlSeconds: ttl as number,
          }),
        "invalid_link_ttl",
        400,
      );
    }
    expect(chainReads()).toBe(0);
  });

  test("an agentId that is not a canonical decimal of at most 78 digits is refused before the chain is read", async () => {
    const row = draft();
    for (const agentId of [
      "042",
      "-1",
      "+1",
      "1e3",
      "",
      " 42",
      "0x2a",
      "1".repeat(79),
      (2n ** 256n).toString(),
      42,
      undefined,
    ]) {
      await refusedAsync(
        () => linkMessage(deps(), tenant, row.legalBodyId, { agentId: agentId as string }),
        "invalid_agent_id",
        400,
      );
    }
    expect(chainReads()).toBe(0);
  });

  test("an identity the registry does not know is a 422 identity_not_found", async () => {
    const row = draft();
    chain.identityOwner.mockResolvedValueOnce(undefined);
    await refusedAsync(
      () => linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42" }),
      "identity_not_found",
      422,
    );
  });

  test("an order whose stored agreement was corrupted is a 500 agreement_unreadable, before the chain is read", async () => {
    const row = draft();
    corruptAgreement(row.legalBodyId);
    await refusedAsync(
      () => linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42" }),
      "agreement_unreadable",
      500,
    );
    expect(chainReads()).toBe(0);
  });

  test("a chain that cannot answer is a 503 chain_unavailable", async () => {
    const row = draft();
    chain.head.mockRejectedValueOnce(new TransportFailure());
    await refusedAsync(
      () => linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42" }),
      "chain_unavailable",
      503,
    );
    chain.identityOwner.mockRejectedValueOnce(new TransportFailure());
    await refusedAsync(
      () => linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42" }),
      "chain_unavailable",
      503,
    );
    for (const line of lines) expect(line).not.toContain("http");
  });

  test("an order that is not a frozen draft is a 409 order_closed", async () => {
    const reserved = reservedOrder(tenant, { agentId: "7", identityOwner: owner.address });
    const abandoned = draft();
    expect(s.repo.abandon(abandoned.legalBodyId, "tenant_request", "tenant")).toBe(true);
    const unfrozen = s.repo.create({
      tenantId: tenant,
      companyId: abandoned.companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    for (const id of [reserved.legalBodyId, abandoned.legalBodyId, unfrozen.legalBodyId])
      await refusedAsync(
        () => linkMessage(deps(), tenant, id, { agentId: "42" }),
        "order_closed",
        409,
      );
    expect(chainReads()).toBe(0);
  });
});

// ── Rule 0 and rule 1, on both functions ────────────────────────────────────────────────────

/** Both functions on one order, each with a well-formed request. */
function bothDoors(d: LegalBodyOrderDeps, who: Address, row: { legalBodyId: string }) {
  return [
    {
      name: "linkMessage",
      run: () => linkMessage(d, who, row.legalBodyId, { agentId: "42" }),
    },
    {
      name: "submitLink",
      run: async () => {
        const full = s.repo.findById(row.legalBodyId);
        const signed = await signedLink(
          full?.oaManifestHash
            ? linkFor(full)
            : {
                agentId: 42n,
                guardian: who,
                amendmentDelay: 172_800n,
                operatingAgreementHash: H("a"),
                deadline: LINK_HEAD.timestamp + 3_600n,
              },
        );
        return submitLink(d, who, row.legalBodyId, signed, afterReserve());
      },
    },
  ];
}

describe("rule 0: a real human, then the doors' throttles", () => {
  test("a waiver tenant and a tenant that never verified are refused on both functions, its own order included", async () => {
    const companyId = customerCompany(s, WAIVED, { filingNumber: "TEST-0900" });
    const own = s.repo.create({
      tenantId: WAIVED,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const before = snapshot();
    for (const door of bothDoors(deps(), WAIVED, own))
      await refusedAsyncLoose(door.run, "waiver_not_accepted", 403, door.name);
    for (const door of bothDoors(deps(), owner.address, own))
      await refusedAsyncLoose(door.run, "guardian_not_verified", 403, door.name);
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);
  });

  test("an empty tenant bucket, or an empty doors' budget, is a 429 on both functions", async () => {
    const row = draft();
    const empty = { take: () => false };
    for (const d of [deps({ tenantBucket: () => empty }), deps({ doorBudget: empty })])
      for (const door of bothDoors(d, tenant, row))
        await refusedAsyncLoose(door.run, "rate_limited", 429, door.name);
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
    expect(chainReads()).toBe(0);
  });
});

/** As `refusedAsync`, for codes whose sentence is not the legal-body table's. */
async function refusedAsyncLoose(
  run: () => Promise<unknown>,
  code: string,
  status: number,
  what: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, what).toBeInstanceOf(ApiError);
  expect((caught as ApiError).code, what).toBe(code);
  expect((caught as ApiError).status, what).toBe(status);
}

describe("rule 1: a frozen draft of this deployment, under 24 hours old, not revoked, for an eligible company, on the current agreement", () => {
  test("a draft placed 25 hours ago is a 409 order_expired on both functions; at 23 hours it is still linkable", async () => {
    const row = draft();
    const later = deps({ now: () => Date.now() + 25 * HOUR_MS });
    for (const door of bothDoors(later, tenant, row))
      await refusedAsyncLoose(door.run, "order_expired", 409, door.name);
    expect(chainReads()).toBe(0);

    const sooner = deps({ now: () => Date.now() + 23 * HOUR_MS });
    expect((await linkMessage(sooner, tenant, row.legalBodyId, { agentId: "42" })).deadline).toBe(
      Number(LINK_HEAD.timestamp) + 3_600,
    );
    expect((await submitFor(row, { deps: sooner })).status).toBe("reserved");
  });

  test("a revoked order is a 409 order_revoked on both functions", async () => {
    const row = draft();
    s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    const before = snapshot();
    for (const door of bothDoors(deps(), tenant, row))
      await refusedAsyncLoose(door.run, "order_revoked", 409, door.name);
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);
  });

  test("a company whose check was revoked since the order is a 409 company_not_eligible on both functions", async () => {
    const row = draft();
    appendCheck(s.checks, row.companyId, "revoked");
    for (const door of bothDoors(deps(), tenant, row))
      await refusedAsyncLoose(door.run, "company_not_eligible", 409, door.name);
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
    expect(chainReads()).toBe(0);
  });

  test("an agreement frozen on a superseded text version, or on another text, is a 409 agreement_outdated on both functions", async () => {
    // The helper itself makes a linkable order on the current text.
    const current = draftOnText(LEGAL_BODY_OPERATING_AGREEMENT);
    expect(
      (await linkMessage(deps(), tenant, current.legalBodyId, { agentId: "42" })).deadline,
    ).toBe(Number(LINK_HEAD.timestamp) + 3_600);
    chain = fakeLinkChainMembers();

    const superseded = draftOnText({
      ...LEGAL_BODY_OPERATING_AGREEMENT,
      version: "2020-01-draft-0",
    });
    const another = draftOnText({ ...LEGAL_BODY_OPERATING_AGREEMENT, id: "another-agreement" });
    for (const row of [superseded, another])
      for (const door of bothDoors(deps(), tenant, row))
        await refusedAsyncLoose(door.run, "agreement_outdated", 409, door.name);
    expect(chainReads()).toBe(0);
  });

  test("a production deployment, which does not serve the draft wording, answers agreement_outdated on both functions", async () => {
    const row = draft();
    for (const door of bothDoors(deps({ environment: "production" }), tenant, row))
      await refusedAsyncLoose(door.run, "agreement_outdated", 409, door.name);
    expect(chainReads()).toBe(0);
  });

  test("a corrupted stored agreement is a 500 agreement_unreadable on both functions", async () => {
    const row = draft();
    corruptAgreement(row.legalBodyId);
    for (const door of bothDoors(deps(), tenant, row))
      await refusedAsyncLoose(door.run, "agreement_unreadable", 500, door.name);
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
    expect(chainReads()).toBe(0);
  });

  test("an order of another factory or chain is a 409 other_deployment on both functions", async () => {
    const mine = draft();
    for (const d of [
      deps({ deployment: { chainId: CHAIN_ID, factory: OTHER_FACTORY } }),
      deps({ deployment: { chainId: CHAIN_ID + 1, factory: FACTORY } }),
    ])
      for (const door of bothDoors(d, tenant, mine))
        await refusedAsyncLoose(door.run, "other_deployment", 409, door.name);
    expect(chainReads()).toBe(0);
  });

  test("another tenant's order and an unknown id are the same 404 on both functions", async () => {
    const row = draft();
    for (const door of [
      ...bothDoors(deps(), otherTenant, row),
      ...bothDoors(deps(), otherTenant, { legalBodyId: "lb_00000000-0000-4000-8000-000000000000" }),
    ])
      await refusedAsyncLoose(door.run, "not_found", 404, door.name);
    expect(chainReads()).toBe(0);
  });
});

// ── submitLink ──────────────────────────────────────────────────────────────────────────────

describe("submitLink: the accepted link", () => {
  test("an accepted link reserves the order with the canonical signature, the observed block and a schedule, then hands the reserved row to `after.create` once", async () => {
    const row = draft();
    const link = linkFor(row);
    const signed = await signedLink(link);
    // The same signature with a raw recovery bit in its last byte: the factory accepts only 27 or
    // 28, so the canonical form is what is stored.
    const { yParity } = parseSignature(signed.signature);
    const rawBit = `${signed.signature.slice(0, 130)}0${yParity}` as Hex;
    chain.head.mockResolvedValueOnce(LINK_HEAD).mockResolvedValueOnce(LATER_HEAD);
    const now = Date.now();
    const a = afterReserve();

    const result = await submitLink(
      deps({ now: () => now }),
      tenant,
      row.legalBodyId,
      { message: signed.message, signature: rawBit },
      a,
    );

    const reserved = rowOf(row.legalBodyId);
    expect(reserved).toMatchObject({
      bindingState: "reserved",
      agentId: "42",
      identityOwner: owner.address,
      linkDigest: offChainLinkDigest({ chainId: CHAIN_ID, factory: FACTORY, link }),
      linkDeadline: Number(link.deadline),
      linkSignature: signed.signature.toLowerCase(),
      bodyAddress: predictedBody(link),
      nextBindingCheckAt: now,
      bindingCheckIntervalMs: 30_000,
    });
    expect(s.repo.acceptedAtBlock(row.legalBodyId)).toBe(Number(LINK_HEAD.number));
    expect(chain.estimateCreate).toHaveBeenCalledWith(link, signed.signature);
    // The block time is the head read after the check.
    expect(a.create).toHaveBeenCalledOnce();
    expect(a.create).toHaveBeenCalledWith(reserved, Number(LATER_HEAD.timestamp));
    expect(result).toEqual({ status: "reserved", order: toOrderView(reserved) });
  });

  test("a repeated submit on a reserved, deployed or linked order answers that state and reserves nothing", async () => {
    const row = draft();
    const a = afterReserve();
    expect((await submitFor(row, { after: a })).status).toBe("reserved");
    const reads = chainReads();

    const states: [string, () => void][] = [
      ["reserved", () => {}],
      [
        "deployed",
        () =>
          expect(
            s.repo.markDeployed(row.legalBodyId, {
              txHash: H("c"),
              deployedAt: Number(LINK_HEAD.timestamp),
            }),
          ).toBe(true),
      ],
      [
        "linked",
        () =>
          expect(
            s.repo.markLinked(row.legalBodyId, Number(LINK_HEAD.timestamp) + 10),
          ).toMatchObject({ outcome: "linked" }),
      ],
    ];
    for (const [state, move] of states) {
      move();
      const before = snapshot();
      const again = await submitFor(row, {
        after: a,
        link: { deadline: LINK_HEAD.timestamp + 4_000n },
      });
      expect(again, state).toEqual({ status: state, order: toOrderView(rowOf(row.legalBodyId)) });
      expect(snapshot(), state).toEqual(before);
    }
    expect(a.create).toHaveBeenCalledOnce();
    expect(chainReads()).toBe(reads);
  });

  test("an order in any other state is a 409 order_closed", async () => {
    const lapsed = reservedOrder(tenant, { agentId: "7", identityOwner: owner.address });
    expect(
      s.repo.lapse(lapsed.legalBodyId, {
        reason: "deadline_passed",
        blockTime: Number(LINK_HEAD.timestamp),
      }),
    ).toBe(true);
    const abandoned = draft();
    expect(s.repo.abandon(abandoned.legalBodyId, "tenant_request", "tenant")).toBe(true);
    const superseded = deployedOrder(tenant, { agentId: "8", identityOwner: owner.address });
    expect(s.repo.supersede(superseded.legalBodyId, "lb_other")).toBe(true);
    for (const row of [lapsed, abandoned, superseded])
      await refusedAsync(() => submitFor(rowOf(row.legalBodyId)), "order_closed", 409);
    expect(chainReads()).toBe(0);
  });

  test("another tenant's submit on a deployed order is the uniform 404, not the order's view", async () => {
    const deployed = deployedOrder(tenant, { agentId: "42", identityOwner: owner.address });
    const notYours = await refusedAsync(
      () => submitFor(deployed, { who: otherTenant }),
      "not_found",
      404,
    );
    const unknown = await refusedAsync(
      () =>
        submitLink(
          deps(),
          otherTenant,
          "lb_00000000-0000-4000-8000-000000000000",
          { message: {}, signature: "0x" },
          afterReserve(),
        ),
      "not_found",
      404,
    );
    expect(notYours.details).toEqual(unknown.details);
    expect(JSON.stringify(notYours)).not.toContain(deployed.legalBodyId);
  });

  test("two submits for the same order at the same time: one runs, the other sees the state the first left", async () => {
    const row = draft();
    const signed = await signedLink(linkFor(row));
    const a = afterReserve();
    const d = deps();
    const [one, two] = await Promise.all([
      submitLink(d, tenant, row.legalBodyId, signed, a),
      submitLink(d, tenant, row.legalBodyId, signed, a),
    ]);
    const reserved = toOrderView(rowOf(row.legalBodyId));
    expect(one).toEqual({ status: "reserved", order: reserved });
    expect(two).toEqual({ status: "reserved", order: reserved });
    expect(chain.estimateCreate).toHaveBeenCalledOnce();
    expect(a.create).toHaveBeenCalledOnce();
    expect(
      s.repo.listEvents(row.legalBodyId).filter((e) => e.kind === "link_accepted"),
    ).toHaveLength(1);
  });

  test("the submit waits for the order's lock before it reads the chain", async () => {
    const row = draft();
    let release: () => void = () => {};
    const held = withKeyedLock(
      orderLockKey(row.legalBodyId),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = submitFor(row);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(chainReads()).toBe(0);
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
    release();
    await held;
    expect((await pending).status).toBe("reserved");
  });
});

describe("submitLink: refusals before the reserve keep the draft", () => {
  test("each refusal of the check is answered with its code, the order and a detail of hex and decimals; the draft is kept and nothing is reserved", async () => {
    const row = draft();
    const view = toOrderView(row);
    const base = linkFor(row);
    const known = { identityOwner: owner.address, bodyAddress: predictedBody(base) };
    const cases: {
      code: LinkRefusalCode;
      what: string;
      link?: Partial<LegalBodyLink>;
      signature?: () => Promise<Hex> | Hex;
      steer?: () => void;
      detail: Record<string, string>;
    }[] = [
      {
        code: "guardian_mismatch",
        what: "another guardian",
        link: { guardian: otherTenant },
        detail: {},
      },
      {
        code: "agreement_mismatch",
        what: "another agreement",
        link: { operatingAgreementHash: H("d") },
        detail: {},
      },
      {
        code: "delay_mismatch",
        what: "another delay",
        link: { amendmentDelay: 259_200n },
        detail: {},
      },
      {
        code: "deadline_out_of_window",
        what: "a deadline too close",
        link: { deadline: LINK_HEAD.timestamp + 100n },
        detail: {},
      },
      {
        code: "identity_not_found",
        what: "an unknown identity",
        steer: () => chain.identityOwner.mockResolvedValueOnce(undefined),
        detail: {},
      },
      {
        code: "already_created",
        what: "a body found at the predicted address",
        steer: () => chain.bodyCreator.mockResolvedValueOnce(PREVIOUS_OWNER),
        detail: { ...known, createdFor: PREVIOUS_OWNER },
      },
      {
        code: "already_created",
        what: "a body the simulation finds",
        steer: () => chain.estimateCreate.mockRejectedValueOnce(revert("LegalBodyExists")),
        detail: known,
      },
      {
        code: "bad_signature",
        what: "another key's signature",
        signature: async () => (await signedLink(base, ANVIL_ACCOUNT_3)).signature,
        steer: () => chain.estimateCreate.mockRejectedValueOnce(revert("BadSignature")),
        detail: known,
      },
      {
        code: "unsupported_signer",
        what: "a signature no key makes, from an owner with no code",
        signature: () => `0x${"5a".repeat(100)}` as Hex,
        steer: () => chain.estimateCreate.mockRejectedValueOnce(revert("BadSignature")),
        detail: known,
      },
      {
        code: "gas_too_high",
        what: "a create above the gas ceiling",
        steer: () =>
          chain.estimateCreate.mockRejectedValueOnce(new LegalBodyGasTooHighError(30_000_000n)),
        detail: { ...known, gasEstimate: "30000000" },
      },
      {
        code: "create_would_revert",
        what: "a factory error",
        steer: () => chain.estimateCreate.mockRejectedValueOnce(revert("BadGuardian")),
        detail: { ...known, errorName: "BadGuardian" },
      },
      {
        code: "create_would_revert",
        what: "an error name the factory does not declare",
        steer: () => chain.estimateCreate.mockRejectedValueOnce(revert("NotAFactoryError")),
        detail: known,
      },
      {
        code: "create_would_revert",
        what: "a revert with no name",
        steer: () => chain.estimateCreate.mockRejectedValueOnce(revert(undefined)),
        detail: known,
      },
    ];

    for (const c of cases) {
      chain = fakeLinkChainMembers();
      c.steer?.();
      const before = snapshot();
      const a = afterReserve();
      const result = await submitFor(row, {
        link: c.link,
        ...(c.signature ? { signature: await c.signature() } : {}),
        after: a,
      });
      expect(result, c.what).toEqual({
        status: "refused",
        code: c.code,
        order: view,
        detail: c.detail,
      });
      expect(JSON.parse(JSON.stringify(result)), c.what).toEqual(result);
      expect(LEGAL_BODY_SENTENCES[c.code], c.what).toMatch(/^[A-Z].*\.$/);
      expect(snapshot(), c.what).toEqual(before);
      expect(a.create, c.what).not.toHaveBeenCalled();
    }
  });

  test("a transport error, a platform fault or a digest mismatch in the check, and a head that cannot be read after it, are 503s that change nothing", async () => {
    const row = draft();
    const failures: [string, () => void][] = [
      [
        "a transport error",
        () => chain.estimateCreate.mockRejectedValueOnce(new TransportFailure()),
      ],
      [
        "a platform fault",
        () =>
          chain.estimateCreate.mockRejectedValueOnce(new LegalBodyChainFaultError("NotAuthorized")),
      ],
      ["a digest mismatch", () => chain.linkDigest.mockResolvedValueOnce(H("9"))],
      [
        "the head after the check",
        () =>
          chain.head.mockResolvedValueOnce(LINK_HEAD).mockRejectedValueOnce(new TransportFailure()),
      ],
    ];
    for (const [what, fail] of failures) {
      chain = fakeLinkChainMembers();
      fail();
      lines.length = 0;
      const before = snapshot();
      const a = afterReserve();
      const err = await refusedAsync(() => submitFor(row, { after: a }), "chain_unavailable", 503);
      expect(JSON.stringify({ message: err.message, details: err.details }), what).not.toContain(
        "http",
      );
      expect(snapshot(), what).toEqual(before);
      expect(a.create, what).not.toHaveBeenCalled();
      expect(lines.join("\n"), what).not.toContain("http");
    }
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
  });

  test("a signature above 2,048 bytes, or not whole bytes of hex, is a 400 malformed_signature; 2,048 bytes and an empty 0x are read", async () => {
    const row = draft();
    expect(MAX_LINK_SIGNATURE_BYTES).toBe(2_048);
    const before = snapshot();
    for (const signature of [`0x${"ab".repeat(2_049)}`, "0xabc", "abcd", "0xzz", 42, undefined])
      await refusedAsync(
        () => submitFor(row, { signature: signature as Hex }),
        "malformed_signature",
        400,
      );
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);

    for (const signature of [`0x${"ab".repeat(2_048)}`, "0x"] as Hex[]) {
      chain = fakeLinkChainMembers();
      chain.estimateCreate.mockRejectedValueOnce(revert("BadSignature"));
      const result = await submitFor(row, { signature });
      expect(result).toMatchObject({ status: "refused", code: "unsupported_signer" });
      expect(chain.estimateCreate).toHaveBeenCalledWith(linkFor(row), signature);
    }
  });

  test("a message with an extra field, a missing field or a number for a uint256 is a 400 malformed_link", async () => {
    const row = draft();
    const { message } = await signedLink(linkFor(row));
    const { deadline: _dropped, ...missing } = message;
    const before = snapshot();
    for (const bad of [
      { ...message, extra: "1" },
      missing,
      { ...message, agentId: 42 },
      "a sentence",
      null,
      [message],
    ])
      await refusedAsync(() => submitFor(row, { message: bad }), "malformed_link", 400);
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);
  });
});

describe("submitLink: the throttles", () => {
  test("the identity's bucket is keyed by chain, agent and tenant: an empty one is a 429, and a stranger who empties its own does not stop the owner's tenant", async () => {
    const asked: string[] = [];
    const buckets = bucketsByKey(3, 0);
    const d = deps({
      identityBucket: (key) => {
        asked.push(key);
        return buckets(key);
      },
    });

    // A stranger's own order, its links for agent 42 refused before the chain: each takes a token.
    const theirs = draft(otherTenant);
    for (let i = 0; i < 3; i++) {
      const refused = await submitFor(theirs, {
        deps: d,
        link: { guardian: tenant, deadline: LINK_HEAD.timestamp + 3_600n + BigInt(i) },
      });
      expect(refused).toMatchObject({ status: "refused", code: "guardian_mismatch" });
    }
    await refusedAsync(
      () => submitFor(theirs, { deps: d, link: { guardian: tenant } }),
      "rate_limited",
      429,
    );
    expect(asked).toEqual(Array(4).fill(`${CHAIN_ID}:42:${otherTenant}`));
    expect(rowOf(theirs.legalBodyId).bindingState).toBe("draft");

    // The owner's tenant links the same agent with its own bucket.
    const mine = draft(tenant);
    expect((await submitFor(mine, { deps: d })).status).toBe("reserved");
    expect(asked.at(-1)).toBe(`${CHAIN_ID}:42:${tenant}`);
  });
});

describe("submitLink: the create caps, before anything is reserved", () => {
  test("the sixth create of a tenant in 24 hours is a 429 legal_body_attempts, counting creates across its orders, reverted ones included; another tenant is not counted", async () => {
    // One order whose create was sent three times (two reverted and were sent again) before it
    // lapsed, and one whose create was sent twice: five creates in all.
    const first = reservedOrder(tenant, { agentId: "100", identityOwner: owner.address });
    for (let nonce = 1; nonce <= 3; nonce++)
      expect(
        s.repo.recordDeploySubmission(first.legalBodyId, {
          txHash: H(String(nonce)),
          rawTx: "0x02",
          nonce,
        }),
      ).toBe(true);
    expect(
      s.repo.lapse(first.legalBodyId, {
        reason: "deadline_passed",
        blockTime: Number(LINK_HEAD.timestamp),
      }),
    ).toBe(true);
    const second = reservedOrder(tenant, { agentId: "101", identityOwner: owner.address });
    for (let nonce = 4; nonce <= 5; nonce++)
      expect(
        s.repo.recordDeploySubmission(second.legalBodyId, {
          txHash: H(String(nonce)),
          rawTx: "0x02",
          nonce,
        }),
      ).toBe(true);

    const mine = draft();
    const before = snapshot();
    await refusedAsync(() => submitFor(mine), "legal_body_attempts", 429);
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);

    // Another tenant's creates are its own.
    const theirs = draft(otherTenant);
    expect((await submitFor(theirs)).status).toBe("reserved");
  });

  test("the deployment's cap is a 503 busy", async () => {
    const first = reservedOrder(tenant, { agentId: "100", identityOwner: owner.address });
    for (let nonce = 1; nonce <= 2; nonce++)
      expect(
        s.repo.recordDeploySubmission(first.legalBodyId, {
          txHash: H(String(nonce)),
          rawTx: "0x02",
          nonce,
        }),
      ).toBe(true);
    const theirs = draft(otherTenant);
    const before = snapshot();
    await refusedAsync(
      () => submitFor(theirs, { deps: deps({ maxCreatesPerDay: 2 }) }),
      "busy",
      503,
    );
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);
    expect((await submitFor(theirs, { deps: deps({ maxCreatesPerDay: 3 }) })).status).toBe(
      "reserved",
    );
  });
});

describe("submitLink: the give-way and the reserve, in one transaction", () => {
  test("a reserved order of the identity's previous owner is lapsed with owner_changed at the head read after the check, and this order reserves", async () => {
    const previous = reservedOrder(otherTenant, { agentId: "42", identityOwner: PREVIOUS_OWNER });
    const mine = draft();
    chain.head.mockResolvedValueOnce(LINK_HEAD).mockResolvedValueOnce(LATER_HEAD);
    const a = afterReserve();

    expect((await submitFor(mine, { after: a })).status).toBe("reserved");

    expect(rowOf(previous.legalBodyId).bindingState).toBe("lapsed");
    expect(s.repo.listEvents(previous.legalBodyId).at(-1)).toMatchObject({
      kind: "lapsed",
      actor: "system",
      detail: { reason: "owner_changed", blockTime: Number(LATER_HEAD.timestamp) },
    });
    expect(rowOf(mine.legalBodyId).bindingState).toBe("reserved");
    expect(a.create).toHaveBeenCalledWith(rowOf(mine.legalBodyId), Number(LATER_HEAD.timestamp));
  });

  test("a deployed order of ANOTHER tenant is superseded by this order, keeps its body, and this order reserves", async () => {
    const deployed = deployedOrder(otherTenant, { agentId: "42", identityOwner: owner.address });
    const mine = draft();

    expect((await submitFor(mine)).status).toBe("reserved");

    const superseded = rowOf(deployed.legalBodyId);
    expect(superseded).toMatchObject({
      bindingState: "superseded",
      bodyAddress: deployed.bodyAddress,
      createTxHash: deployed.createTxHash,
      deployedAt: deployed.deployedAt,
      agentId: "42",
    });
    expect(s.repo.listEvents(deployed.legalBodyId).at(-1)).toMatchObject({
      kind: "superseded",
      detail: { by: mine.legalBodyId },
    });
    expect(rowOf(mine.legalBodyId).bindingState).toBe("reserved");
  });

  test("a reserved order signed by the same owner blocks with agent_in_flight and no detail, and nothing moves", async () => {
    const inFlight = reservedOrder(otherTenant, { agentId: "42", identityOwner: owner.address });
    const mine = draft();
    const before = snapshot();
    const a = afterReserve();

    const result = await submitFor(mine, { after: a });

    expect(result).toEqual({
      status: "refused",
      code: "agent_in_flight",
      order: toOrderView(mine),
      detail: {},
    });
    expect(LEGAL_BODY_SENTENCES.agent_in_flight).toMatch(/^[A-Z].*\.$/);
    expect(snapshot()).toEqual(before);
    expect(rowOf(inFlight.legalBodyId).bindingState).toBe("reserved");
    expect(a.create).not.toHaveBeenCalled();
  });

  test("a reserve that fails after a give-way move (body_taken) is a 409 link_already_used and leaves the other row untouched", async () => {
    const deployed = deployedOrder(otherTenant, { agentId: "42", identityOwner: PREVIOUS_OWNER });
    const mine = draft();
    // Another order already recorded the body this order's link would create.
    reservedOrder(otherTenant, {
      agentId: "43",
      identityOwner: owner.address,
      bodyAddress: predictedBody(linkFor(mine)),
    });
    const before = snapshot();
    const a = afterReserve();

    await refusedAsync(() => submitFor(mine, { after: a }), "link_already_used", 409);

    expect(snapshot()).toEqual(before);
    expect(rowOf(deployed.legalBodyId).bindingState).toBe("deployed");
    expect(rowOf(mine.legalBodyId).bindingState).toBe("draft");
    expect(a.create).not.toHaveBeenCalled();
  });
});

// ── The draft's lifetime, as the repository counts it ───────────────────────────────────────

describe("isDraftExpired", () => {
  test("agrees with the expired-drafts listing on each side of 24 hours, and a row in another state is never an expired draft", () => {
    const row = draft();
    const createdMs = parseSqliteUtc(row.createdAt);
    expect(isDraftExpired(row, createdMs + DAY_MS)).toBe(false);
    expect(s.repo.listExpiredDrafts(createdMs + DAY_MS, 10)).toEqual([]);
    expect(isDraftExpired(row, createdMs + DAY_MS + 1_000)).toBe(true);
    expect(
      s.repo.listExpiredDrafts(createdMs + DAY_MS + 1_000, 10).map((r) => r.legalBodyId),
    ).toEqual([row.legalBodyId]);
    const reserved = reservedOrder(tenant, { agentId: "9", identityOwner: owner.address });
    expect(isDraftExpired(reserved, parseSqliteUtc(reserved.createdAt) + 2 * DAY_MS)).toBe(false);
  });
});

// ── The sentences ───────────────────────────────────────────────────────────────────────────

describe("the link door's codes", () => {
  test("every code the link door answers has one plain sentence", () => {
    const checkCodes: Record<LinkRefusalCode, true> = {
      malformed_link: true,
      guardian_mismatch: true,
      agreement_mismatch: true,
      delay_mismatch: true,
      deadline_out_of_window: true,
      identity_not_found: true,
      unsupported_signer: true,
      bad_signature: true,
      already_created: true,
      gas_too_high: true,
      create_would_revert: true,
    };
    for (const code of [
      ...Object.keys(checkCodes),
      "agent_in_flight",
      "order_expired",
      "order_revoked",
      "agreement_outdated",
      "invalid_agent_id",
      "invalid_link_ttl",
      "malformed_signature",
      "legal_body_attempts",
      "busy",
      "link_already_used",
    ]) {
      const sentence = LEGAL_BODY_SENTENCES[code];
      expect(sentence, code).toMatch(/^[A-Z].*\.$/);
      expect(sentence, code).not.toContain("http");
    }
  });
});
