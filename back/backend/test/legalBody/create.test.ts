/**
 * The create: the one way a create transaction is submitted for a reserved order (recorded before
 * it is sent, with every cap counted again in the same synchronous step as the record), and what
 * the link door does once the identity is reserved: submit, wait briefly for the receipt, and
 * answer every outcome and every throw.
 *
 * The database is real (in memory). The chain is a fake whose answers each test steers; where the
 * order of effects matters, the create goes through a real LegalBodyChain over a fake relay seam.
 * Waits use an injected sleep: no test waits a real second. Every name, company and filing number
 * is an invention, and every key is one of anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { type Address, type Hex, type PublicClient, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PreparedRelayedCall, RelayedCall } from "../../src/adapters/arc/arcAdapter";
import {
  type CreateOutcome,
  LegalBodyChain,
  LegalBodyChainFaultError,
  type LegalBodyChainPort,
  LegalBodyFeeTooHighError,
  LegalBodyGasTooHighError,
  type RelaySeam,
} from "../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { ApiError } from "../../src/errors";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import {
  CreateCapError,
  MAX_CREATE_SUBMISSIONS_PER_ORDER,
  linkOfRow,
  submitCreateFor,
} from "../../src/legalBody/create";
import type { LegalBodyLink } from "../../src/legalBody/link";
import {
  DOOR_RECEIPT_INTERVAL_MS,
  DOOR_RECEIPT_READS,
  type LinkSubmitResult,
  createAfterReserve,
  submitLinkAndCreate,
} from "../../src/legalBody/linkDoor";
import { type LegalBodyOrderDeps, createOrder, toOrderView } from "../../src/legalBody/orders";
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
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  H,
  IDENTITY_OWNER,
  JWT_SECRET,
  LINK_HEAD,
  type LegalBodyStores,
  REGISTRY,
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

/** Two verified humans; the identity's owner signs every link. */
const tenant = ANVIL_ACCOUNT_2.address;
const otherTenant = ANVIL_ACCOUNT_3.address;
/** Placeholders: an identity's previous owner, the platform account that signs the create, and
 *  the controller it is relayed through. */
const PREVIOUS_OWNER = getAddress("0x00000000000000000000000000000000000001d0");
const EXECUTOR = getAddress("0x000000000000000000000000000000000000e0e0");
const CONTROLLER = getAddress("0x000000000000000000000000000000000000c0de");

/** What the signer hands back for a create: its hash, its bytes and its nonce. */
const SIGNED = { txHash: H("7"), rawTx: `0x02${"ee".repeat(120)}` as Hex, nonce: 7 };
/** The time of the block that created a body in these tests, in unix seconds. */
const DEPLOYED_AT = Number(LINK_HEAD.timestamp) + 2;
/** The deployment every order of these tests is made under. */
const DEPLOYMENT = { chainId: CHAIN_ID, factory: FACTORY };

let db: Database.Database;
let s: LegalBodyStores;
let chain: ReturnType<typeof fakeChain>;
let lines: string[];
/** The process clock the deps read, in unix milliseconds: the injected sleep moves it on. */
let clock: number;
let startedAt: number;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let filings = 0;
let bodies = 0;
let agents = 100;

/** The link door's chain reads, as the link tests fake them, and the create's two calls: by
 *  default the create is recorded and sent, and the node has no receipt for it yet. */
function fakeChain() {
  return {
    ...fakeLinkChainMembers(),
    submitCreate: vi.fn<LegalBodyChainPort["submitCreate"]>(async (p) =>
      p.record({ ...SIGNED }) ? { status: "sent", ...SIGNED } : { status: "not_recorded" },
    ),
    createOutcome: vi.fn<LegalBodyChainPort["createOutcome"]>(async () => ({ status: "absent" })),
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, tenant, "3001", Date.now());
  recordHuman(s.store, otherTenant, "3002", Date.now());
  chain = fakeChain();
  startedAt = Date.now();
  clock = startedAt;
  sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors' deps over the fake chain, the test's clock and its sleep, with room in every
 *  throttle. */
function deps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, {
    chain: asChainPort(chain),
    now: () => clock,
    sleep,
    ...over,
  });
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

/** An order of `who` moved to `reserved` through the repository, as an earlier link reserved it,
 *  for an identity of its own. */
function reservedOrder(who: Address = tenant): LegalBodyRecord {
  const row = draft(who);
  expect(
    s.repo.reserve(row.legalBodyId, {
      agentId: String(++agents),
      identityOwner: PREVIOUS_OWNER,
      linkDigest: H("b"),
      linkDeadline: Number(LINK_HEAD.timestamp) + 3_600,
      linkSignature: "0x01",
      bodyAddress: freshBody(),
      observedAtBlock: 7,
      firstCheckAt: startedAt,
    }),
  ).toBe("reserved");
  return rowOf(row.legalBodyId);
}

/** Records `n` create submissions on a reserved order, as earlier sends recorded them. */
function recordSubmissions(id: string, n: number): void {
  for (let i = 0; i < n; i++)
    expect(
      s.repo.recordDeploySubmission(id, {
        txHash: H((i + 1).toString(16)),
        rawTx: "0x02",
        nonce: i,
      }),
    ).toBe(true);
}

/** Submits the order's link through the door's own path, signed by the identity's owner, for an
 *  identity no other test order holds unless a link is given. */
async function submitFor(
  row: LegalBodyRecord,
  p: { deps?: LegalBodyOrderDeps; link?: Partial<LegalBodyLink> } = {},
): Promise<LinkSubmitResult> {
  const signed = await signedLink({ ...linkFor(row, { agentId: BigInt(++agents) }), ...p.link });
  return submitLinkAndCreate(p.deps ?? deps(), row.tenantId, row.legalBodyId, signed);
}

/** The chain's answer for a create that made the body it was expected to make. */
function createdAs(txHash: Hex, bodyAddress: Address): CreateOutcome {
  return {
    status: "created",
    created: {
      legalBody: bodyAddress,
      agentId: 1n,
      identityOwner: IDENTITY_OWNER.address,
      guardian: tenant,
      linkDigest: H("d"),
      txHash,
      blockNumber: Number(LINK_HEAD.number) + 1,
      deployedAt: DEPLOYED_AT,
    },
  };
}

/** The factory's refusal of a create, as the relayed create's simulation reports it. */
const revert = (errorName: string | undefined) =>
  new ContractRevertError(`createLegalBody reverted: ${errorName ?? "unknown"}`, errorName);

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

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

/**
 * A real LegalBodyChain over a fake relay seam, as the chain port's create. Each seam call notes,
 * when it runs, the order's state and how many submissions it has recorded. `onSign` runs while
 * the executor's lock is held, after the up-front count and before the record.
 */
function realCreate(id: string, hooks: { onSign?: () => void } = {}) {
  const steps: string[] = [];
  const note = (step: string) =>
    steps.push(
      `${step}:${rowOf(id).bindingState}:${s.repo.listDeploySubmissions(id).length} recorded`,
    );
  const seam = {
    chainId: CHAIN_ID,
    platformAddress: EXECUTOR,
    platformNonce: vi.fn(async () => 0),
    platformPendingNonce: vi.fn(async () => 0),
    estimateRelayedCall: vi.fn(async (_call: RelayedCall) => {
      note("estimate");
      return 300_000n;
    }),
    prepareRelayedCall: vi.fn(async (relayed: RelayedCall, gas: bigint) => {
      note("prepare");
      return {
        call: relayed,
        gas,
        request: {
          type: "eip1559",
          to: CONTROLLER,
          data: "0x",
          gas,
          chainId: CHAIN_ID,
          maxFeePerGas: 200_000_000_000n,
          maxPriorityFeePerGas: 1n,
        },
      } as unknown as PreparedRelayedCall;
    }),
    signRelayedCall: vi.fn(async (_prepared: PreparedRelayedCall) => {
      note("sign");
      hooks.onSign?.();
      return { ...SIGNED };
    }),
    sendRawRelayedCall: vi.fn(async (_rawTx: Hex) => {
      note("send");
      return SIGNED.txHash;
    }),
  } satisfies RelaySeam;
  const real = new LegalBodyChain({
    // Nothing in the create's sending half reads from the public client.
    publicClient: {} as PublicClient,
    arc: seam,
    chainId: CHAIN_ID,
    factory: FACTORY,
    identityRegistry: REGISTRY,
  });
  chain.submitCreate.mockImplementation((p) => real.submitCreate(p));
  return { seam, steps };
}

// ── The order of effects ────────────────────────────────────────────────────────────────────

describe("the order of effects, through a real LegalBodyChain", () => {
  test("the identity is reserved, then the signed create is recorded, then it is sent: nothing reaches the wire unrecorded", async () => {
    const row = draft();
    const { seam, steps } = realCreate(row.legalBodyId);
    chain.createOutcome.mockImplementation(async (txHash, expected) =>
      createdAs(txHash, expected.bodyAddress),
    );

    const result = await submitFor(row);

    expect(steps).toEqual([
      "estimate:reserved:0 recorded",
      "prepare:reserved:0 recorded",
      "sign:reserved:0 recorded",
      "send:reserved:1 recorded",
    ]);
    expect(seam.sendRawRelayedCall).toHaveBeenCalledOnce();
    expect(seam.sendRawRelayedCall).toHaveBeenCalledWith(SIGNED.rawTx);
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toEqual([
      expect.objectContaining({ txHash: SIGNED.txHash, rawTx: SIGNED.rawTx, nonce: SIGNED.nonce }),
    ]);
    const kinds = s.repo.listEvents(row.legalBodyId).map((e) => e.kind);
    expect(kinds.indexOf("link_accepted")).toBeGreaterThan(-1);
    expect(kinds.indexOf("link_accepted")).toBeLessThan(kinds.indexOf("deploy_submitted"));
    expect(kinds.indexOf("deploy_submitted")).toBeLessThan(kinds.indexOf("deployed"));
    expect(result).toEqual({ status: "deployed", order: toOrderView(rowOf(row.legalBodyId)) });
  });

  test("a cap reached after the up-front count is caught inside record: nothing is recorded, nothing is sent, and the order stays reserved", async () => {
    // Each cap leaves room for exactly one more create when the door counts it.
    const cases: [string, Address, () => Partial<LegalBodyOrderDeps>][] = [
      [
        "tenant",
        tenant,
        () => ({ maxCreatesPerTenantPerDay: s.repo.countCreatesByTenant(tenant, 0) + 1 }),
      ],
      [
        "deployment",
        otherTenant,
        () => ({ maxCreatesPerDay: s.repo.countCreatesSince(DEPLOYMENT, 0) + 1 }),
      ],
    ];
    for (const [cap, holder, room] of cases) {
      const over = room();
      const other = reservedOrder(holder);
      const row = draft();
      // Another create is recorded while this one is being signed, inside the executor's lock.
      const { seam, steps } = realCreate(row.legalBodyId, {
        onSign: () => recordSubmissions(other.legalBodyId, 1),
      });

      const result = await submitFor(row, { deps: deps(over) });

      expect(steps, cap).toEqual([
        "estimate:reserved:0 recorded",
        "prepare:reserved:0 recorded",
        "sign:reserved:0 recorded",
      ]);
      expect(seam.sendRawRelayedCall, cap).not.toHaveBeenCalled();
      expect(s.repo.listDeploySubmissions(row.legalBodyId), cap).toEqual([]);
      expect(result, cap).toEqual({
        status: "reserved",
        order: toOrderView(rowOf(row.legalBodyId)),
      });
      expect(chain.createOutcome, cap).not.toHaveBeenCalled();
    }
  });
});

// ── The wait for the receipt ────────────────────────────────────────────────────────────────

describe("the door's wait for the receipt", () => {
  test("a create mined on the second read is deployed, put on the binding schedule from now at one minute, after one sleep", async () => {
    const row = draft();
    chain.createOutcome
      .mockResolvedValueOnce({ status: "absent" })
      .mockImplementationOnce(async (txHash, expected) => createdAs(txHash, expected.bodyAddress));

    const result = await submitFor(row);

    const after = rowOf(row.legalBodyId);
    expect(after.bindingState).toBe("deployed");
    expect(after.createTxHash).toBe(SIGNED.txHash);
    expect(after.deployedAt).toBe(DEPLOYED_AT);
    expect(after.nextBindingCheckAt).toBe(startedAt + DOOR_RECEIPT_INTERVAL_MS);
    expect(after.bindingCheckIntervalMs).toBe(60_000);
    expect(result).toEqual({ status: "deployed", order: toOrderView(after) });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(DOOR_RECEIPT_INTERVAL_MS);
    expect(chain.createOutcome).toHaveBeenCalledTimes(2);
    expect(chain.createOutcome).toHaveBeenCalledWith(SIGNED.txHash, {
      bodyAddress: after.bodyAddress,
    });
  });

  test("a create still absent after five reads leaves the order reserved, on its schedule, with its one submission", async () => {
    const row = draft();

    const result = await submitFor(row);

    const after = rowOf(row.legalBodyId);
    expect(result).toEqual({ status: "reserved", order: toOrderView(after) });
    expect(after.bindingState).toBe("reserved");
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toHaveLength(1);
    expect(chain.createOutcome).toHaveBeenCalledTimes(DOOR_RECEIPT_READS);
    expect(sleep).toHaveBeenCalledTimes(DOOR_RECEIPT_READS - 1);
    for (const [ms] of sleep.mock.calls) expect(ms).toBe(DOOR_RECEIPT_INTERVAL_MS);
    // The reserve's schedule, untouched: only a move to deployed or lapsed ends it.
    expect(after.nextBindingCheckAt).toBe(startedAt);
    expect(after.bindingCheckIntervalMs).toBe(30_000);
    expect(DOOR_RECEIPT_READS).toBe(5);
    expect(DOOR_RECEIPT_INTERVAL_MS).toBe(1_000);
  });

  test("a reverted create ends the wait: the order stays reserved, for the sweeper to settle", async () => {
    const row = draft();
    chain.createOutcome.mockResolvedValueOnce({ status: "reverted" });

    const result = await submitFor(row);

    const after = rowOf(row.legalBodyId);
    expect(result).toEqual({ status: "reserved", order: toOrderView(after) });
    expect(after.nextBindingCheckAt).toBe(startedAt);
    expect(chain.createOutcome).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test("a receipt read that throws an error carrying a URL ends the wait with reserved, never a 503 and never its text", async () => {
    const row = draft();
    chain.createOutcome.mockRejectedValueOnce(new TransportFailure());

    const result = await submitFor(row);

    const after = rowOf(row.legalBodyId);
    expect(result).toEqual({ status: "reserved", order: toOrderView(after) });
    expect(JSON.stringify(result)).not.toContain("http");
    expect(lines.join("\n")).not.toContain("http");
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_chain_unavailable",
        orderId: row.legalBodyId,
        errorName: "HttpRequestError",
      }),
    ]);
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toHaveLength(1);
    expect(chain.createOutcome).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ── What the submission's throws and answers become ─────────────────────────────────────────

describe("a refusal of the create before anything was sent", () => {
  test("each refusal lapses the order with refused_before_send at the reserve's block time, and is answered with its code and the lapsed order", async () => {
    const cases: [string, Error, string, Record<string, string>][] = [
      ["BadSignature", revert("BadSignature"), "bad_signature", {}],
      ["LegalBodyExists", revert("LegalBodyExists"), "already_created", {}],
      ["BadDeadline", revert("BadDeadline"), "deadline_out_of_window", {}],
      [
        "another named revert",
        revert("BadGuardian"),
        "create_would_revert",
        { errorName: "BadGuardian" },
      ],
      ["the gas ceiling", new LegalBodyGasTooHighError(30_000_000n), "gas_too_high", {}],
    ];
    for (const [what, error, code, detail] of cases) {
      const row = draft();
      chain.submitCreate.mockRejectedValueOnce(error);

      const result = await submitFor(row);

      const after = rowOf(row.legalBodyId);
      expect(after.bindingState, what).toBe("lapsed");
      expect(result, what).toEqual({
        status: "refused",
        code,
        order: toOrderView(after),
        detail,
      });
      expect(result.order.state, what).toBe("lapsed");
      const lapsed = s.repo.listEvents(row.legalBodyId).filter((e) => e.kind === "lapsed");
      expect(lapsed, what).toEqual([
        expect.objectContaining({
          detail: { reason: "refused_before_send", blockTime: Number(LINK_HEAD.timestamp) },
        }),
      ]);
      expect(s.repo.listDeploySubmissions(row.legalBodyId), what).toEqual([]);
      expect(after.nextBindingCheckAt, what).toBeNull();
      expect(chain.createOutcome, what).not.toHaveBeenCalled();
    }
  });

  test("a not_recorded on an order another order lapsed meanwhile is refused with order_lapsed", async () => {
    const row = draft();
    chain.submitCreate.mockImplementationOnce(async (p) => {
      // Another order's give-way lapses this one between the reserve and the record.
      expect(
        s.repo.lapse(row.legalBodyId, { reason: "owner_changed", blockTime: 1_800_000_001 }),
      ).toBe(true);
      expect(p.record({ ...SIGNED })).toBe(false);
      return { status: "not_recorded" };
    });

    const result = await submitFor(row);

    expect(result).toEqual({
      status: "refused",
      code: "order_lapsed",
      order: toOrderView(rowOf(row.legalBodyId)),
      detail: {},
    });
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toEqual([]);
    expect(LEGAL_BODY_SENTENCES.order_lapsed).toMatch(/^[A-Z].*\.$/);
  });
});

describe("a fault after the reserve", () => {
  test("a platform fault, the fee cap, a transport error, a revert with no name and any other throw are 503s: the order stays reserved, on its schedule, with no submission", async () => {
    const cases: [string, Error][] = [
      ["a platform fault", new LegalBodyChainFaultError("NotAuthorized")],
      [
        "the fee cap",
        new LegalBodyFeeTooHighError(10n ** 18n, { gas: 500_000n, feePerGas: 2n * 10n ** 12n }),
      ],
      ["a transport error", new TransportFailure()],
      ["a revert with no name", revert(undefined)],
      ["a plain error", new Error("no executor")],
    ];
    for (const [what, error] of cases) {
      const row = draft();
      chain.submitCreate.mockRejectedValueOnce(error);
      lines.length = 0;

      const err = await refusedAsync(() => submitFor(row), "chain_unavailable", 503);

      expect(JSON.stringify(err), what).not.toContain("http");
      const after = rowOf(row.legalBodyId);
      expect(after.bindingState, what).toBe("reserved");
      expect(after.nextBindingCheckAt, what).toBe(startedAt);
      expect(after.bindingCheckIntervalMs, what).toBe(30_000);
      expect(s.repo.listDeploySubmissions(row.legalBodyId), what).toEqual([]);
      expect(lines.join("\n"), what).not.toContain("http");
      expect(opsLines(), what).toEqual([
        expect.objectContaining({
          opslog: "legal_body_chain_unavailable",
          orderId: row.legalBodyId,
          errorName: error.name,
        }),
      ]);
    }
    expect(chain.createOutcome).not.toHaveBeenCalled();
  });
});

// ── submitCreateFor ─────────────────────────────────────────────────────────────────────────

describe("submitCreateFor", () => {
  test("onlyAtNonce: a create signed at another nonce is neither recorded nor sent; at that nonce it is", async () => {
    const row = reservedOrder();
    const { seam, steps } = realCreate(row.legalBodyId);

    await expect(submitCreateFor(deps(), row, { onlyAtNonce: SIGNED.nonce + 1 })).resolves.toEqual({
      status: "not_recorded",
    });
    expect(seam.sendRawRelayedCall).not.toHaveBeenCalled();
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toEqual([]);
    expect(steps).toEqual([
      "estimate:reserved:0 recorded",
      "prepare:reserved:0 recorded",
      "sign:reserved:0 recorded",
    ]);

    await expect(submitCreateFor(deps(), row, { onlyAtNonce: SIGNED.nonce })).resolves.toEqual({
      status: "sent",
      ...SIGNED,
    });
    expect(seam.sendRawRelayedCall).toHaveBeenCalledOnce();
    expect(s.repo.listDeploySubmissions(row.legalBodyId)).toEqual([
      expect.objectContaining({ txHash: SIGNED.txHash, nonce: SIGNED.nonce }),
    ]);
  });

  test("submits the row's own link and signature", async () => {
    const row = reservedOrder();

    await submitCreateFor(deps(), row);

    expect(chain.submitCreate).toHaveBeenCalledOnce();
    const [p] = chain.submitCreate.mock.calls[0]!;
    expect(p.link).toEqual(linkOfRow(row));
    expect(p.signature).toBe(row.linkSignature);
  });

  test("each cap reached is a CreateCapError of its kind, before any chain call", async () => {
    expect(MAX_CREATE_SUBMISSIONS_PER_ORDER).toBe(3);

    // The tenant holds 3 creates in 24 hours, all on one order; the deployment 4, one of them
    // another tenant's.
    const full = reservedOrder();
    recordSubmissions(full.legalBodyId, MAX_CREATE_SUBMISSIONS_PER_ORDER);
    recordSubmissions(reservedOrder(otherTenant).legalBodyId, 1);
    const fresh = reservedOrder();

    const cases: [CreateCapError["kind"], LegalBodyRecord, Partial<LegalBodyOrderDeps>][] = [
      ["order", full, {}],
      ["tenant", fresh, { maxCreatesPerTenantPerDay: 3 }],
      ["deployment", fresh, { maxCreatesPerDay: 4 }],
    ];
    for (const [kind, row, over] of cases) {
      let caught: unknown;
      try {
        await submitCreateFor(deps(over), row);
      } catch (e) {
        caught = e;
      }
      expect(caught, kind).toBeInstanceOf(CreateCapError);
      expect((caught as CreateCapError).kind, kind).toBe(kind);
    }
    expect(chain.submitCreate).not.toHaveBeenCalled();
  });
});

describe("createAfterReserve: a cap reached at the create", () => {
  test("the tenant's cap is a 429 legal_body_attempts and the deployment's a 503 busy; the order stays reserved, and the chain is not called", async () => {
    const earlier = reservedOrder();
    recordSubmissions(earlier.legalBodyId, 1);
    const cases: [string, number, Partial<LegalBodyOrderDeps>][] = [
      ["legal_body_attempts", 429, { maxCreatesPerTenantPerDay: 1 }],
      ["busy", 503, { maxCreatesPerDay: 1 }],
    ];
    for (const [code, status, over] of cases) {
      const row = reservedOrder();
      await refusedAsync(
        () => createAfterReserve(deps(over), row, Number(LINK_HEAD.timestamp)),
        code,
        status,
      );
      const after = rowOf(row.legalBodyId);
      expect(after.bindingState, code).toBe("reserved");
      expect(after.nextBindingCheckAt, code).toBe(startedAt);
    }
    expect(chain.submitCreate).not.toHaveBeenCalled();
    expect(chain.createOutcome).not.toHaveBeenCalled();
  });
});

describe("linkOfRow", () => {
  test("rebuilds the link the identity's owner signed from the reserved row; a draft holds none", async () => {
    const row = draft();
    const link = linkFor(row, { agentId: 4_242n });
    await submitLinkAndCreate(deps(), tenant, row.legalBodyId, await signedLink(link));

    expect(linkOfRow(rowOf(row.legalBodyId))).toEqual(link);
    expect(() => linkOfRow(draft())).toThrow();
  });
});

// ── On REST ─────────────────────────────────────────────────────────────────────────────────

/** The API over this test's database, with the order doors on the given deps. */
function makeApp(legalBodyOrders: LegalBodyOrderDeps) {
  const requests = new SqliteFormationRepository(db);
  const apiDeps: Partial<ApiDeps> = {
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
  return buildApiApp(apiDeps as ApiDeps);
}

describe("the link door on REST, with the create", () => {
  const linkPath = (id: string) => `/legal-body-orders/${id}/link`;

  test("a create mined on the first read is a 200 with the deployed order", async () => {
    const app = makeApp(deps());
    const row = draft();
    chain.createOutcome.mockImplementationOnce(async (txHash, expected) =>
      createdAs(txHash, expected.bodyAddress),
    );

    const res = await answerOf(
      await call(
        app,
        "POST",
        linkPath(row.legalBodyId),
        await sessionOf(ANVIL_ACCOUNT_2),
        await signedLink(linkFor(row)),
      ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(toOrderView(rowOf(row.legalBodyId)));
    expect(res.body.state).toBe("deployed");
  });

  test("a receipt read that fails with a URL is a 202 with the reserved order, and neither the answer nor the log carries http", async () => {
    const app = makeApp(deps());
    const row = draft();
    chain.createOutcome.mockRejectedValueOnce(new TransportFailure());

    const res = await answerOf(
      await call(
        app,
        "POST",
        linkPath(row.legalBodyId),
        await sessionOf(ANVIL_ACCOUNT_2),
        await signedLink(linkFor(row)),
      ),
    );

    expect(res.status).toBe(202);
    expect(res.body).toEqual(toOrderView(rowOf(row.legalBodyId)));
    expect(res.body.state).toBe("reserved");
    expect(res.text).not.toContain("http");
    expect(lines.join("\n")).not.toContain("http");
  });

  test("a create refused after the reserve is a 422 whose message adds the lapsed order's sentence, with the lapsed order", async () => {
    const app = makeApp(deps());
    const row = draft();
    chain.submitCreate.mockRejectedValueOnce(revert("BadSignature"));

    const res = await answerOf(
      await call(
        app,
        "POST",
        linkPath(row.legalBodyId),
        await sessionOf(ANVIL_ACCOUNT_2),
        await signedLink(linkFor(row)),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      code: "bad_signature",
      message: `${LEGAL_BODY_SENTENCES.bad_signature} ${LEGAL_BODY_SENTENCES.order_lapsed}`,
      detail: {},
      order: toOrderView(rowOf(row.legalBodyId)),
    });
    expect(res.body.order.state).toBe("lapsed");
  });

  test("a fault after the reserve is a 503 chain_unavailable with no http, and the order stays reserved", async () => {
    const app = makeApp(deps());
    const row = draft();
    chain.submitCreate.mockRejectedValueOnce(new TransportFailure());

    const res = await answerOf(
      await call(
        app,
        "POST",
        linkPath(row.legalBodyId),
        await sessionOf(ANVIL_ACCOUNT_2),
        await signedLink(linkFor(row)),
      ),
    );

    expect(res).toMatchObject({
      status: 503,
      body: {
        error: { code: "chain_unavailable", message: LEGAL_BODY_SENTENCES.chain_unavailable },
      },
    });
    expect(res.text).not.toContain("http");
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
  });
});
