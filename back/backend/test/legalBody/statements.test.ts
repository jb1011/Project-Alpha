/**
 * The statement service: from an agent id, or an address, to a legal-body row of this deployment,
 * one block's chain facts and the recorded facts, each row read once; then a signed statement and,
 * for each distinct set of claims, a row of the statement log.
 *
 * A fake chain over a real in-memory database, on a fixed clock. Every key is one of anvil's
 * published test accounts, every other address a placeholder, and every name, company and filing
 * number an invention.
 */
import { type Address, type LocalAccount, getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StatementChainPort } from "../../src/adapters/arc/legalBodyChain";
import { verifyPublicStatement } from "../../src/legalBody/publicStatement";
import {
  type StatementOutcome,
  isCanonicalAgentId,
  statementForAddress,
  statementForAgent,
} from "../../src/legalBody/statements";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { CHAIN_ID, FACTORY, recordHuman } from "../helpers/customerCompanyFixtures";
import { H, OTHER_FACTORY, REGISTRY, appendCheck } from "../helpers/legalBodyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FORMED_ON,
  FakeStatementChain,
  OA_HASH,
  OWNER,
  SNAPSHOT_HEAD,
  type StatementStores,
  TENANT,
  TEST_ATTESTOR,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

/** Placeholders: an agent wallet that is not the identity owner, another identity owner, and a
 *  body no row records. */
const WALLET = getAddress("0x00000000000000000000000000000000000a11e7");
const OTHER_OWNER = getAddress("0x00000000000000000000000000000000000a0002");
const STRAY_BODY = getAddress("0x00000000000000000000000000000000000ba5e1");

let s: StatementStores;
let chain: FakeStatementChain;
let printed: string[];

beforeEach(() => {
  s = openStatementStores();
  chain = new FakeStatementChain();
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

// biome-ignore lint/suspicious/noExplicitAny: an ops line, read field by field
type OpsLine = Record<string, any>;

/** The ops lines printed for `event`, each without its `opslog` and `at` fields. */
function opsLines(event: string): OpsLine[] {
  return printed.flatMap((line) => {
    try {
      const { opslog, at: _at, ...fields } = JSON.parse(line) as OpsLine;
      return opslog === event ? [fields] : [];
    } catch {
      return [];
    }
  });
}

const logRows = () => s.db.prepare("SELECT * FROM statement_log ORDER BY id").all();

type Signed = Extract<StatementOutcome, { kind: "statement" }>;

function expectStatement(out: StatementOutcome): Signed {
  if (out.kind !== "statement") throw new Error(`expected a statement, got ${JSON.stringify(out)}`);
  return out;
}

/** The test attestor, counting the statements it signs; with `fail`, every signature fails. */
function countingSigner(fail?: Error): { signer: LocalAccount; signed: () => number } {
  let count = 0;
  const signTypedData = (p: never) => {
    count += 1;
    return fail ? Promise.reject(fail) : TEST_ATTESTOR.signTypedData(p);
  };
  return {
    signer: {
      ...TEST_ATTESTOR,
      signTypedData: signTypedData as unknown as LocalAccount["signTypedData"],
    },
    signed: () => count,
  };
}

/** A ready customer company of the tenant, with a verified human and a check that passed. */
function checkedCompany(o: { status?: "draft" | "ready"; human?: boolean } = {}): string {
  const companyId = readyCompany(s, o);
  s.checks.append(passedCheck(companyId));
  return companyId;
}

/** A linked row of a checked company, for agent 42 unless told otherwise, linked on chain too. */
function linkedBody(o: { agentId?: string; status?: "draft" | "ready" } = {}): LegalBodyRecord {
  const row = bodyIn("linked", s, checkedCompany({ status: o.status }), { agentId: o.agentId });
  chain.link(row);
  return row;
}

const agent42 = (deps = statementDeps(s, chain)) => statementForAgent(deps, "42");

/** A refusal for integrity: no statement, one ops line naming the row and the problem, nothing
 *  signed and nothing logged. */
async function expectRefused(
  run: (signer: LocalAccount) => Promise<StatementOutcome>,
  legalBodyId: string,
  problem: string,
): Promise<void> {
  const { signer, signed } = countingSigner();
  await expect(run(signer)).resolves.toEqual({ kind: "none" });
  expect(opsLines("legal_body_statement_integrity")).toEqual([{ legalBodyId, problem }]);
  expect(signed()).toBe(0);
  expect(logRows()).toEqual([]);
  expect(opsLines("legal_body_statement")).toEqual([]);
}

describe("isCanonicalAgentId", () => {
  test("a decimal token id without leading zeros, at most 2^256 - 1", () => {
    for (const id of ["0", "7", "42", (2n ** 256n - 1n).toString()])
      expect(isCanonicalAgentId(id), id).toBe(true);
  });

  test("refuses any other spelling, and anything above 2^256 - 1", () => {
    for (const id of [
      "",
      "00",
      "042",
      "-1",
      "+1",
      " 42",
      "42 ",
      "4a",
      "0x2a",
      "1e3",
      "4.2",
      "٤٢",
      (2n ** 256n).toString(),
      `1${"0".repeat(78)}`,
    ])
      expect(isCanonicalAgentId(id), JSON.stringify(id)).toBe(false);
  });
});

describe("choosing the row", () => {
  test("linked and listed: the body the chain links is stated, active, signed by the attestor", async () => {
    const companyId = checkedCompany();
    const older = bodyIn("linked", s, companyId);
    const row = bodyIn("linked", s, companyId);
    // A replacement on its way, never linked: the listing puts it first.
    const replacement = bodyIn("deployed", s, companyId);
    chain.addBody(older);
    chain.addBody(replacement);
    chain.link(row);

    const out = expectStatement(await agent42());
    expect(out).toMatchObject({
      kind: "statement",
      agentId: "42",
      legalBodyId: row.legalBodyId,
      publicId: row.publicId,
      standing: "active",
    });
    expect(out.statement.message).toEqual({
      chainId: String(CHAIN_ID),
      identityRegistry: REGISTRY,
      factory: getAddress(FACTORY),
      legalBody: row.bodyAddress,
      agentId: "42",
      agentWallet: OWNER,
      identityOwnerAtCreation: OWNER,
      bindingState: "linked",
      identityOwnerIsContract: false,
      agentWalletIsContract: false,
      standing: "active",
      attestationState: "active",
      jurisdiction: "WY",
      entityType: "LLC",
      legalName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      source: "customer",
      environment: "sandbox",
      controlVerified: true,
      existenceCheckedAt: String(CLOCK_S - 3_600),
      filedAt: FORMED_ON,
      einIssued: false,
      filingStatus: "not_yet_due",
      lastFiledPeriod: "0",
      lastFiledAt: "",
      lastFiledConfirmedBy: "",
      nextDue: "2027-01-01",
      oaManifestHash: OA_HASH,
      oaManifestVersion: "1",
      guardianHumanVerified: true,
      observedAtBlock: String(SNAPSHOT_HEAD.number),
      issuedAt: String(CLOCK_S),
      expiresAt: String(CLOCK_S + 300),
    });
    expect(out.statement.attestor).toBe(TEST_ATTESTOR.address);
    await expect(
      verifyPublicStatement(out.statement, {
        attestor: TEST_ATTESTOR.address,
        expectedChainId: CHAIN_ID,
        nowSeconds: CLOCK_S,
      }),
    ).resolves.toBe(true);
    // One snapshot: the agent and every candidate's body, in the listing's order.
    expect(chain.snapshots).toEqual([
      [{ agentId: 42n, bodies: [replacement.bodyAddress, row.bodyAddress, older.bodyAddress] }],
    ]);
    expect(opsLines("legal_body_statement")).toEqual([
      { agentId: "42", standing: "active", bindingState: "linked" },
    ]);
  });

  test("a linked body beyond the four candidates: found by its address, and read again at one block of its own", async () => {
    const companyId = checkedCompany();
    // Five bodies linked in turn: the last is linked in the database, the first four broken.
    const rows = [1, 2, 3, 4, 5].map(() => bodyIn("linked", s, companyId));
    const [first] = rows as [LegalBodyRecord];
    for (const row of rows) chain.addBody(row);
    // The owner points back at the first body, and the database has not seen it yet.
    chain.link(first);
    chain.beforeSnapshot = (n) => {
      if (n === 2) chain.head = { number: 5_000n, timestamp: BigInt(CLOCK_S - 5) };
    };

    const out = expectStatement(await agent42());
    expect(out).toMatchObject({ legalBodyId: first.legalBodyId, standing: "active" });
    expect(out.statement.message).toMatchObject({
      legalBody: first.bodyAddress,
      bindingState: "linked",
      observedAtBlock: "5000",
    });
    expect(chain.snapshots).toEqual([
      [
        {
          agentId: 42n,
          bodies: rows
            .slice(1)
            .reverse()
            .map((r) => r.bodyAddress),
        },
      ],
      [{ agentId: 42n, bodies: [first.bodyAddress] }],
    ]);
    // Every chain fact of the statement is of the second block.
    expect(chain.codeReads).toEqual([{ address: OWNER, blockNumber: 5_000n }]);
  });

  test("a linked body with no public row of this deployment: none, and one ops line", async () => {
    const companyId = checkedCompany();
    const row = linkedBody();
    // A row of another factory holding the body, and a row of this factory still reserved.
    const elsewhere = bodyIn("linked", s, companyId, { factory: OTHER_FACTORY });
    const reservedId = s.repo.create({
      tenantId: TENANT,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    }).legalBodyId;
    s.repo.freezeAgreement(reservedId, { hash: OA_HASH, version: 1 });
    expect(
      s.repo.reserve(reservedId, {
        agentId: "42",
        identityOwner: OWNER,
        linkDigest: H("d"),
        linkDeadline: 1_900_000_000,
        linkSignature: "0x01",
        bodyAddress: STRAY_BODY,
        observedAtBlock: 1,
        firstCheckAt: CLOCK_MS,
      }),
    ).toBe("reserved");
    const noRow = getAddress("0x00000000000000000000000000000000000ba5e2");

    const { signer, signed } = countingSigner();
    for (const linked of [noRow, elsewhere.bodyAddress as Address, STRAY_BODY]) {
      chain.linked.set("42", linked);
      await expect(agent42(statementDeps(s, chain, { signer }))).resolves.toEqual({
        kind: "none",
      });
    }
    expect(opsLines("legal_body_statement_unlisted_body")).toEqual([
      { agentId: "42" },
      { agentId: "42" },
      { agentId: "42" },
    ]);
    // Each answer read one snapshot, of the one listed body, and nothing more.
    expect(chain.snapshots).toEqual(Array(3).fill([{ agentId: 42n, bodies: [row.bodyAddress] }]));
    expect(chain.codeReads).toEqual([]);
    expect(signed()).toBe(0);
    expect(logRows()).toEqual([]);
  });

  test("nothing linked on chain, and a row that was linked: stated as broken and inactive, without the names", async () => {
    const row = bodyIn("broken", s, checkedCompany());
    chain.addBody(row);
    chain.wallets.set("42", OWNER);

    const out = expectStatement(await agent42());
    expect(out).toMatchObject({ legalBodyId: row.legalBodyId, standing: "inactive" });
    expect(out.statement.message).toMatchObject({
      bindingState: "broken",
      standing: "inactive",
      attestationState: "active",
      legalName: "",
      filingNumber: "",
    });
  });

  test("nothing linked on chain: the most recent linked stretch is stated, whatever its state in the database", async () => {
    const companyId = checkedCompany();
    const older = bodyIn("superseded", s, companyId);
    const newer = bodyIn("broken", s, companyId);
    chain.addBody(older);
    chain.addBody(newer);
    expect(expectStatement(await agent42()).legalBodyId).toBe(newer.legalBodyId);

    // The database still records a body as linked that the chain no longer links.
    const linkedHere = bodyIn("linked", s, companyId);
    chain.addBody(linkedHere);
    const out = expectStatement(await agent42());
    expect(out.legalBodyId).toBe(linkedHere.legalBodyId);
    expect(out.statement.message).toMatchObject({ bindingState: "broken", standing: "inactive" });
  });

  test("only rows never linked, and nothing linked on chain: none; once the chain links one, it is stated", async () => {
    const companyId = checkedCompany();
    const setAside = bodyIn("superseded", s, companyId, { seenAt: null });
    const deployed = bodyIn("deployed", s, companyId);
    chain.addBody(setAside);
    chain.addBody(deployed);
    chain.wallets.set("42", OWNER);

    await expect(agent42()).resolves.toEqual({ kind: "none" });
    expect(chain.snapshots).toHaveLength(1);
    expect(chain.codeReads).toEqual([]);
    expect(logRows()).toEqual([]);

    chain.link(deployed);
    const out = expectStatement(await agent42());
    expect(out).toMatchObject({ legalBodyId: deployed.legalBodyId, standing: "active" });
    expect(out.statement.message.bindingState).toBe("linked");
  });

  test("no row: none, and no chain read", async () => {
    linkedBody({ agentId: "7" });
    await expect(agent42()).resolves.toEqual({ kind: "none" });
    expect(chain.snapshots).toEqual([]);
    expect(chain.codeReads).toEqual([]);
  });

  test("an agent id that is not canonical: none, and nothing is read", async () => {
    linkedBody();
    const listed = vi.spyOn(s.repo, "listPublicByAgent");
    for (const id of ["042", "", "4a", "-1", " 42", (2n ** 256n).toString()])
      await expect(statementForAgent(statementDeps(s, chain), id)).resolves.toEqual({
        kind: "none",
      });
    expect(listed).not.toHaveBeenCalled();
    expect(chain.snapshots).toEqual([]);
  });
});

describe("the facts", () => {
  test("a revoked event on the body: inactive and revoked, without the names", async () => {
    const row = linkedBody();
    s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    const out = expectStatement(await agent42());
    expect(out.statement.message).toMatchObject({
      bindingState: "linked",
      standing: "inactive",
      attestationState: "revoked",
      legalName: "",
      filingNumber: "",
    });
  });

  test("a company the operator revoked: inactive and revoked, without the names", async () => {
    const row = linkedBody();
    appendCheck(s.checks, row.companyId, "revoked");
    const out = expectStatement(await agent42());
    expect(out.statement.message).toMatchObject({
      standing: "inactive",
      attestationState: "revoked",
      legalName: "",
      filingNumber: "",
      controlVerified: false,
      existenceCheckedAt: "0",
    });
  });

  test("a reinstatement: pending, with no facts of a pass, until the operator checks the company again", async () => {
    const row = linkedBody();
    appendCheck(s.checks, row.companyId, "revoked");
    appendCheck(s.checks, row.companyId, "reinstated");
    const reinstated = expectStatement(await agent42());
    expect(reinstated.statement.message).toMatchObject({
      standing: "pending",
      attestationState: "pending",
      legalName: "",
      filingNumber: "",
      controlVerified: false,
      filedAt: "",
      filingStatus: "unverified",
    });

    s.checks.append(passedCheck(row.companyId));
    expect(expectStatement(await agent42()).standing).toBe("active");
  });

  test("activation once paid: linked and unpaid reads pending, paid reads active", async () => {
    const row = linkedBody({ status: "draft" });
    const unpaid = expectStatement(await agent42());
    expect(unpaid.statement.message).toMatchObject({
      bindingState: "linked",
      standing: "pending",
      attestationState: "pending",
      // The check passed and nothing is revoked: the names are stated already.
      legalName: "Example Holdings LLC",
    });

    // What the settlement of the payment does.
    expect(s.companies.setStatus(row.companyId, "draft", "ready")).toBe(true);
    const paid = expectStatement(await agent42());
    expect(paid.statement.message).toMatchObject({
      standing: "active",
      attestationState: "active",
    });
  });

  test("the filing facts are counted on Wyoming's date of the issue, not on UTC's", async () => {
    const companyId = readyCompany(s);
    s.checks.append(passedCheck(companyId, { formationDate: "2023-10-15" }));
    chain.link(bodyIn("linked", s, companyId));
    // 03:00 UTC on 1 December is 20:00 on 30 November in Wyoming: the 60th day after the report
    // due on 1 October, the last day of grace.
    const evening = Date.parse("2026-12-01T03:00:00.000Z");
    const inGrace = expectStatement(await agent42(statementDeps(s, chain, { now: () => evening })));
    expect(inGrace.statement.message).toMatchObject({
      standing: "active",
      filingStatus: "past_due_unverified",
      nextDue: "2027-10-01",
      issuedAt: String(evening / 1000),
    });
    // Midnight in Wyoming: the 61st day, beyond grace.
    const midnight = Date.parse("2026-12-01T07:00:00.000Z");
    const late = expectStatement(await agent42(statementDeps(s, chain, { now: () => midnight })));
    expect(late.statement.message).toMatchObject({
      standing: "unknown",
      filingStatus: "past_due_unverified",
    });
  });

  test("annual reports past due beyond grace: unknown; the report recorded at the next check makes it active", async () => {
    const companyId = readyCompany(s);
    s.checks.append(passedCheck(companyId, { formationDate: "2023-03-10" }));
    chain.link(bodyIn("linked", s, companyId));

    const late = expectStatement(await agent42());
    expect(late.statement.message).toMatchObject({
      standing: "unknown",
      filedAt: "2023-03-10",
      filingStatus: "past_due_unverified",
      lastFiledPeriod: "0",
      nextDue: "2027-03-01",
    });

    s.checks.append(
      passedCheck(companyId, {
        formationDate: "2023-03-10",
        lastReport: { period: 2026, filedOn: "2026-02-20" },
      }),
    );
    const filed = expectStatement(await agent42());
    expect(filed.statement.message).toMatchObject({
      standing: "active",
      filingStatus: "filed",
      lastFiledPeriod: "2026",
      lastFiledAt: "2026-02-20",
      lastFiledConfirmedBy: "operator",
    });
  });

  test("an operating agreement on chain other than the frozen one: unknown, stating the frozen one", async () => {
    const row = linkedBody();
    chain.addBody(row, { oaHash: H("c") });
    const out = expectStatement(await agent42());
    expect(out.statement.message).toMatchObject({
      bindingState: "linked",
      standing: "unknown",
      oaManifestHash: OA_HASH,
    });
  });

  test("a body winding down, which the factory no longer links: inactive", async () => {
    const row = linkedBody();
    chain.addBody(row, { status: "winding_down" });
    chain.linked.delete("42");
    const out = expectStatement(await agent42());
    expect(out.statement.message).toMatchObject({ bindingState: "broken", standing: "inactive" });
  });

  test("a guardian with no accepted verification: the flag is false, and the standing does not move", async () => {
    const companyId = checkedCompany({ human: false });
    chain.link(bodyIn("linked", s, companyId));
    const unverified = expectStatement(await agent42());
    expect(unverified.statement.message).toMatchObject({
      guardianHumanVerified: false,
      standing: "active",
    });

    const noWorld = expectStatement(await agent42(statementDeps(s, chain, { world: undefined })));
    expect(noWorld.statement.message.guardianHumanVerified).toBe(false);

    recordHuman(s.store, TENANT, "nullifier-waiver", CLOCK_MS - 1_000, "waiver");
    const waiver = expectStatement(await agent42());
    expect(waiver.statement.message.guardianHumanVerified).toBe(false);
  });

  test("each fact is read once per statement, and nothing else is read for them", async () => {
    linkedBody();
    const reads = {
      listPublicByAgent: vi.spyOn(s.repo, "listPublicByAgent"),
      findByBodyAddress: vi.spyOn(s.repo, "findByBodyAddress"),
      company: vi.spyOn(s.companies, "find"),
      check: vi.spyOn(s.checks, "latest"),
      checks: vi.spyOn(s.checks, "list"),
      events: vi.spyOn(s.repo, "listEvents"),
      isRevoked: vi.spyOn(s.repo, "isRevoked"),
      declaration: vi.spyOn(s.declarations, "find"),
      human: vi.spyOn(s.store, "findByTenant"),
    };
    expectStatement(await agent42());
    expect(
      Object.fromEntries(Object.entries(reads).map(([k, spy]) => [k, spy.mock.calls.length])),
    ).toEqual({
      listPublicByAgent: 1,
      findByBodyAddress: 0,
      company: 1,
      check: 1,
      checks: 0,
      events: 1,
      isRevoked: 0,
      declaration: 1,
      human: 1,
    });
  });
});

describe("the code kinds", () => {
  test("an agent with no wallet: one code read, the identity owner's, at the snapshot's block", async () => {
    linkedBody();
    chain.wallets.delete("42");
    chain.codes.set(OWNER.toLowerCase(), "contract");
    const out = expectStatement(await agent42());
    expect(chain.codeReads).toEqual([{ address: OWNER, blockNumber: SNAPSHOT_HEAD.number }]);
    expect(out.statement.message).toMatchObject({
      agentWallet: zeroAddress,
      identityOwnerIsContract: true,
      agentWalletIsContract: false,
    });
  });

  test("a wallet that is the identity owner: its code is read once and serves both flags", async () => {
    linkedBody();
    chain.codes.set(OWNER.toLowerCase(), "contract");
    const out = expectStatement(await agent42());
    expect(chain.codeReads).toHaveLength(1);
    expect(out.statement.message).toMatchObject({
      agentWallet: OWNER,
      identityOwnerIsContract: true,
      agentWalletIsContract: true,
    });
  });

  test("another wallet: its code is read too, at the same block; a delegated account is no contract", async () => {
    const row = linkedBody();
    chain.link(row, { wallet: WALLET });
    chain.codes.set(OWNER.toLowerCase(), "delegated");
    chain.codes.set(WALLET.toLowerCase(), "delegated");
    const delegated = expectStatement(await agent42());
    expect(chain.codeReads).toEqual([
      { address: OWNER, blockNumber: SNAPSHOT_HEAD.number },
      { address: WALLET, blockNumber: SNAPSHOT_HEAD.number },
    ]);
    expect(delegated.statement.message).toMatchObject({
      agentWallet: WALLET,
      identityOwnerIsContract: false,
      agentWalletIsContract: false,
    });

    chain.codes.set(WALLET.toLowerCase(), "contract");
    const contract = expectStatement(await agent42());
    expect(contract.statement.message).toMatchObject({
      identityOwnerIsContract: false,
      agentWalletIsContract: true,
    });
  });
});

describe("the log", () => {
  test("identical claims add no row; changed claims add one, with the evidence they rest on", async () => {
    const row = linkedBody();
    const first = expectStatement(await agent42());
    // Another block and another second, the same claims: no new row. The issue is a whole second,
    // the clock's rounded down.
    chain.head = { number: 4_300n, timestamp: BigInt(CLOCK_S) };
    const again = expectStatement(
      await agent42(statementDeps(s, chain, { now: () => CLOCK_MS + 5_999 })),
    );
    expect(again.statement.message).toMatchObject({
      observedAtBlock: "4300",
      issuedAt: String(CLOCK_S + 5),
      expiresAt: String(CLOCK_S + 305),
    });
    expect(again.statement.signature).not.toBe(first.statement.signature);
    expect(logRows()).toHaveLength(1);
    const check = s.checks.latest(row.companyId);
    expect(s.statements.latest(row.legalBodyId)).toMatchObject({
      chainId: CHAIN_ID,
      factory: getAddress(FACTORY),
      agentId: "42",
      agentWallet: OWNER,
      attestor: TEST_ATTESTOR.address,
      standing: "active",
      observedAtBlock: Number(SNAPSHOT_HEAD.number),
      issuedAt: CLOCK_S,
      evidence: {
        checkId: check?.checkId,
        revocationEventId: null,
        companyStatus: "ready",
        humanVerified: true,
      },
    });

    // A revocation changes the claims: a second row, naming the revocation it rests on.
    s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    expect(expectStatement(await agent42()).standing).toBe("inactive");
    const revocation = s.repo.listEvents(row.legalBodyId).find((e) => e.kind === "revoked");
    expect(logRows()).toHaveLength(2);
    expect(s.statements.latest(row.legalBodyId)).toMatchObject({
      standing: "inactive",
      evidence: {
        checkId: check?.checkId,
        revocationEventId: revocation?.id,
        companyStatus: "ready",
        humanVerified: true,
      },
    });
  });

  test("the evidence of a statement with no passed check, an unpaid company and no verified human", async () => {
    const companyId = readyCompany(s, { status: "draft", human: false });
    appendCheck(s.checks, companyId, "failed");
    const row = bodyIn("linked", s, companyId);
    chain.link(row);
    expect(expectStatement(await agent42()).standing).toBe("pending");
    expect(s.statements.latest(row.legalBodyId)?.evidence).toEqual({
      checkId: null,
      revocationEventId: null,
      companyStatus: "draft",
      humanVerified: false,
    });
  });

  test("a log write that fails: the statement still stands, and one ops line names the error only", async () => {
    linkedBody();
    const appendIfChanged = vi.spyOn(s.statements, "appendIfChanged").mockImplementation(() => {
      throw new RangeError(
        "SQLITE_BUSY: database is locked by 0x00000000000000000000000000000000000a0001",
      );
    });
    const out = expectStatement(await agent42());
    expect(appendIfChanged).toHaveBeenCalledTimes(1);
    expect(out.standing).toBe("active");
    expect(opsLines("legal_body_statement_log_failed")).toEqual([
      { legalBodyId: out.legalBodyId, errorName: "RangeError" },
    ]);
    expect(opsLines("legal_body_statement")).toHaveLength(1);
    expect(printed.join("\n")).not.toContain("database is locked");
  });
});

describe("when the chain or the signer fails", () => {
  const nodeError = () =>
    Object.assign(
      new Error("HTTP request failed. URL: https://rpc.example/v2/key-in-path Status: 429"),
      { name: "HttpRequestError" },
    );

  test("a snapshot that fails: unknown at the snapshot stage; nothing signed, nothing logged", async () => {
    linkedBody();
    const { signer, signed } = countingSigner();
    chain.beforeSnapshot = () => {
      throw nodeError();
    };
    await expect(agent42(statementDeps(s, chain, { signer }))).resolves.toEqual({
      kind: "unknown",
      agentId: "42",
      stage: "snapshot",
      errorName: "HttpRequestError",
    });
    expect(chain.codeReads).toEqual([]);
    expect(signed()).toBe(0);
    expect(logRows()).toEqual([]);
    expect(opsLines("legal_body_statement_unavailable")).toEqual([
      { stage: "snapshot", errorName: "HttpRequestError" },
    ]);
    expect(opsLines("legal_body_statement")).toEqual([]);
    expect(printed.join("\n")).not.toContain("rpc.example");
  });

  test("the second snapshot of a body beyond the candidates that fails: unknown at the snapshot stage", async () => {
    const companyId = checkedCompany();
    const rows = [1, 2, 3, 4, 5].map(() => bodyIn("linked", s, companyId));
    for (const row of rows) chain.addBody(row);
    chain.link(rows[0] as LegalBodyRecord);
    chain.beforeSnapshot = (n) => {
      if (n === 2) throw nodeError();
    };
    await expect(agent42()).resolves.toEqual({
      kind: "unknown",
      agentId: "42",
      stage: "snapshot",
      errorName: "HttpRequestError",
    });
    expect(chain.snapshots).toHaveLength(2);
    expect(logRows()).toEqual([]);
  });

  test("a snapshot that does not hold exactly what was asked: unknown, and nothing signed", async () => {
    const companyId = checkedCompany();
    const older = bodyIn("linked", s, companyId);
    chain.addBody(older);
    chain.link(bodyIn("linked", s, companyId));
    const { signer, signed } = countingSigner();
    type Agents = Awaited<ReturnType<StatementChainPort["readStatementSnapshot"]>>["agents"];
    const faults: Record<string, (agents: Agents) => Agents> = {
      "no agent": () => [],
      "one agent too many": (agents) => [...agents, ...agents],
      "another agent": (agents) => agents.map((a) => ({ ...a, agentId: 43n })),
      "the first body missing": (agents) =>
        agents.map((a) => ({ ...a, bodies: a.bodies.slice(1) })),
      "the last body missing": (agents) =>
        agents.map((a) => ({ ...a, bodies: a.bodies.slice(0, -1) })),
      "a body too many": (agents) =>
        agents.map((a) => ({ ...a, bodies: [...a.bodies, ...a.bodies.slice(0, 1)] })),
      "the bodies in another order": (agents) =>
        agents.map((a) => ({ ...a, bodies: [...a.bodies].reverse() })),
    };
    for (const [fault, alter] of Object.entries(faults)) {
      const faulty: StatementChainPort = {
        chainId: chain.chainId,
        factory: chain.factory,
        codeKind: (address, blockNumber) => chain.codeKind(address, blockNumber),
        readStatementSnapshot: async (requests) => {
          const snap = await chain.readStatementSnapshot(requests);
          return { ...snap, agents: alter(snap.agents) };
        },
      };
      await expect(agent42(statementDeps(s, faulty, { signer })), fault).resolves.toEqual({
        kind: "unknown",
        agentId: "42",
        stage: "snapshot",
        errorName: "IncompleteSnapshotError",
      });
    }
    expect(chain.codeReads).toEqual([]);
    expect(signed()).toBe(0);
    expect(logRows()).toEqual([]);
  });

  test("a code read that fails: unknown at the code stage; nothing signed, nothing logged", async () => {
    const row = linkedBody();
    chain.link(row, { wallet: WALLET });
    const { signer, signed } = countingSigner();
    chain.beforeCodeRead = (address) => {
      if (address === WALLET) throw new TypeError("fetch failed");
    };
    await expect(agent42(statementDeps(s, chain, { signer }))).resolves.toEqual({
      kind: "unknown",
      agentId: "42",
      stage: "code",
      errorName: "TypeError",
    });
    expect(signed()).toBe(0);
    expect(logRows()).toEqual([]);
    expect(opsLines("legal_body_statement_unavailable")).toEqual([
      { stage: "code", errorName: "TypeError" },
    ]);
  });

  test("a signer that fails: unknown at the sign stage, nothing logged", async () => {
    linkedBody();
    const { signer, signed } = countingSigner(new RangeError("the signer is unreachable"));
    await expect(agent42(statementDeps(s, chain, { signer }))).resolves.toEqual({
      kind: "unknown",
      agentId: "42",
      stage: "sign",
      errorName: "RangeError",
    });
    expect(signed()).toBe(1);
    expect(logRows()).toEqual([]);
    expect(opsLines("legal_body_statement")).toEqual([]);
    expect(opsLines("legal_body_statement_unavailable")).toEqual([
      { stage: "sign", errorName: "RangeError" },
    ]);
  });

  test("a database read that fails propagates, and nothing is signed", async () => {
    linkedBody();
    const { signer, signed } = countingSigner();
    const failing = (): never => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    };
    const reads = [
      () => vi.spyOn(s.repo, "listPublicByAgent").mockImplementation(failing),
      () => vi.spyOn(s.companies, "find").mockImplementation(failing),
      () => vi.spyOn(s.checks, "latest").mockImplementation(failing),
      () => vi.spyOn(s.repo, "listEvents").mockImplementation(failing),
      () => vi.spyOn(s.declarations, "find").mockImplementation(failing),
      // The World ID store: a failed read says nothing about the guardian, so it is never a
      // false flag.
      () => vi.spyOn(s.store, "findByTenant").mockImplementation(failing),
    ];
    for (const fail of reads) {
      const spy = fail();
      await expect(agent42(statementDeps(s, chain, { signer }))).rejects.toThrow("SQLITE_IOERR");
      spy.mockRestore();
    }
    expect(signed()).toBe(0);
    expect(logRows()).toEqual([]);
    expect(opsLines("legal_body_statement_unavailable")).toEqual([]);
  });

  test("the lookup of a body beyond the candidates that fails propagates too", async () => {
    linkedBody();
    chain.linked.set("42", STRAY_BODY);
    vi.spyOn(s.repo, "findByBodyAddress").mockImplementation(() => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    });
    await expect(agent42()).rejects.toThrow("SQLITE_IOERR");
  });
});

describe("a refusal for integrity", () => {
  test("the factory recorded another creator for the body: not_ours", async () => {
    const row = linkedBody();
    chain.addBody(row, { creator: OTHER_OWNER });
    await expectRefused(
      (signer) => agent42(statementDeps(s, chain, { signer })),
      row.legalBodyId,
      "not_ours",
    );
  });

  test("the factory recorded no creator for the body: not_ours, before any other read", async () => {
    const row = linkedBody();
    chain.addBody(row, { creator: undefined });
    const company = vi.spyOn(s.companies, "find");
    await expectRefused(
      (signer) => agent42(statementDeps(s, chain, { signer })),
      row.legalBodyId,
      "not_ours",
    );
    expect(chain.codeReads).toEqual([]);
    expect(company).not.toHaveBeenCalled();
  });

  test("the body names another agent: agent_mismatch", async () => {
    const row = linkedBody();
    chain.addBody(row, { metaAgentId: 43n });
    await expectRefused(
      (signer) => agent42(statementDeps(s, chain, { signer })),
      row.legalBodyId,
      "agent_mismatch",
    );
  });

  test("the row's company is missing: company_missing", async () => {
    const row = linkedBody();
    vi.spyOn(s.companies, "find").mockReturnValue(undefined);
    await expectRefused(
      (signer) => agent42(statementDeps(s, chain, { signer })),
      row.legalBodyId,
      "company_missing",
    );
  });

  test("the row's company is not a customer's own: unsupported_provider, with nothing else read", async () => {
    const row = linkedBody();
    const company = s.companies.find(row.companyId);
    if (company === undefined) throw new Error("no company");
    vi.spyOn(s.companies, "find").mockReturnValue({
      ...company,
      provider: "example-formation-provider",
    });
    const check = vi.spyOn(s.checks, "latest");
    await expectRefused(
      (signer) => agent42(statementDeps(s, chain, { signer })),
      row.legalBodyId,
      "unsupported_provider",
    );
    expect(check).not.toHaveBeenCalled();
  });

  test("a candidate without its body, agent or owner: row_incomplete, before any chain read", async () => {
    const row = linkedBody();
    for (const missing of [
      { bodyAddress: null },
      { agentId: null },
      { identityOwner: null },
      { oaManifestHash: null },
      { oaManifestVersion: null },
    ]) {
      printed.length = 0;
      const listed = vi
        .spyOn(s.repo, "listPublicByAgent")
        .mockReturnValue([{ ...row, ...missing }]);
      await expectRefused(
        (signer) => agent42(statementDeps(s, chain, { signer })),
        row.legalBodyId,
        "row_incomplete",
      );
      listed.mockRestore();
    }
    expect(chain.snapshots).toEqual([]);
  });

  test("a body beyond the candidates whose row is incomplete: row_incomplete, before its snapshot", async () => {
    const companyId = checkedCompany();
    const rows = [1, 2, 3, 4, 5].map(() => bodyIn("linked", s, companyId));
    for (const row of rows) chain.addBody(row);
    const first = rows[0] as LegalBodyRecord;
    chain.link(first);
    vi.spyOn(s.repo, "findByBodyAddress").mockReturnValue({ ...first, identityOwner: null });
    await expectRefused(
      (signer) => agent42(statementDeps(s, chain, { signer })),
      first.legalBodyId,
      "row_incomplete",
    );
    expect(chain.snapshots).toHaveLength(1);
  });
});

describe("by address", () => {
  test("an identity owner's address, confirmed by the agent's wallet at a fresh block", async () => {
    const row = linkedBody();
    const out = expectStatement(await statementForAddress(statementDeps(s, chain), OWNER));
    expect(out).toMatchObject({ agentId: "42", legalBodyId: row.legalBodyId, standing: "active" });
    // The candidates' wallets, then the agent's own snapshot.
    expect(chain.snapshots).toEqual([
      [{ agentId: 42n, bodies: [] }],
      [{ agentId: 42n, bodies: [row.bodyAddress] }],
    ]);
  });

  test("any letter case of the address answers alike", async () => {
    linkedBody();
    const out = expectStatement(
      await statementForAddress(statementDeps(s, chain), OWNER.toLowerCase() as Address),
    );
    expect(out.statement.message.agentWallet).toBe(OWNER);
  });

  test("a wallet found in the statement log, once a statement by agent recorded it, confirmed by the chain", async () => {
    const row = linkedBody();
    chain.link(row, { wallet: WALLET });
    const deps = statementDeps(s, chain);
    // Not an identity owner, and in no statement yet: no candidate, and no chain read.
    await expect(statementForAddress(deps, WALLET)).resolves.toEqual({ kind: "none" });
    expect(chain.snapshots).toEqual([]);

    expectStatement(await statementForAgent(deps, "42"));
    const out = expectStatement(await statementForAddress(deps, WALLET));
    expect(out).toMatchObject({ agentId: "42", legalBodyId: row.legalBodyId });
    expect(out.statement.message.agentWallet).toBe(WALLET);
  });

  test("a candidate whose wallet on chain is another address: none, after the one snapshot", async () => {
    const row = linkedBody();
    chain.link(row, { wallet: WALLET });
    await expect(statementForAddress(statementDeps(s, chain), OWNER)).resolves.toEqual({
      kind: "none",
    });
    expect(chain.snapshots).toHaveLength(1);
    expect(logRows()).toEqual([]);
  });

  test("a wallet that moved between the two blocks: that statement is not the address's answer", async () => {
    linkedBody();
    chain.beforeSnapshot = (n) => {
      if (n === 2) chain.wallets.set("42", WALLET);
    };
    await expect(statementForAddress(statementDeps(s, chain), OWNER)).resolves.toEqual({
      kind: "none",
    });
    expect(chain.snapshots).toHaveLength(2);
  });

  test("two confirmed agents: the active statement is preferred over the first one", async () => {
    // The owner's agents come newest first: agent 7 (pending), then agent 8 (active).
    linkedBody({ agentId: "8" });
    linkedBody({ agentId: "7", status: "draft" });
    const out = expectStatement(await statementForAddress(statementDeps(s, chain), OWNER));
    expect(out).toMatchObject({ agentId: "8", standing: "active" });
    expect(chain.snapshots.map((r) => r.map((a) => a.agentId))).toEqual([[7n, 8n], [7n], [8n]]);
  });

  test("two confirmed agents and none active: the first statement", async () => {
    linkedBody({ agentId: "8", status: "draft" });
    linkedBody({ agentId: "7", status: "draft" });
    const out = expectStatement(await statementForAddress(statementDeps(s, chain), OWNER));
    expect(out).toMatchObject({ agentId: "7", standing: "pending" });
  });

  test("two confirmed agents, the first active and the second unreadable: the active statement", async () => {
    linkedBody({ agentId: "7" });
    linkedBody({ agentId: "8" });
    chain.beforeSnapshot = (n) => {
      if (n === 3) throw new Error("the node is gone");
    };
    const out = expectStatement(await statementForAddress(statementDeps(s, chain), OWNER));
    expect(out).toMatchObject({ agentId: "8", standing: "active" });
    // The second agent's snapshot was read, and failed.
    expect(chain.snapshots).toHaveLength(3);
  });

  test("two confirmed agents, the first pending and the second unreadable: unknown", async () => {
    linkedBody({ agentId: "8" });
    linkedBody({ agentId: "7", status: "draft" });
    chain.beforeSnapshot = (n) => {
      if (n === 3) throw new TypeError("fetch failed");
    };
    await expect(statementForAddress(statementDeps(s, chain), OWNER)).resolves.toEqual({
      kind: "unknown",
      agentId: "8",
      stage: "snapshot",
      errorName: "TypeError",
    });
  });

  test("an unknown ends the loop: no agent after it is read", async () => {
    linkedBody({ agentId: "9" });
    linkedBody({ agentId: "8" });
    linkedBody({ agentId: "7", status: "draft" });
    chain.beforeSnapshot = (n) => {
      if (n === 3) throw new TypeError("fetch failed");
    };
    await expect(statementForAddress(statementDeps(s, chain), OWNER)).resolves.toMatchObject({
      kind: "unknown",
      agentId: "8",
    });
    expect(chain.snapshots).toHaveLength(3);
  });

  test("the candidates: the identity owner's agents first, then the wallet log's, each once, at most five", async () => {
    // Agents 1 to 3 owned by the address, its own wallet.
    for (const agentId of ["1", "2", "3"]) linkedBody({ agentId });
    // Agents 5 to 7 owned by another, with the address as their wallet.
    for (const agentId of ["5", "6", "7"]) {
      const row = bodyIn("linked", s, checkedCompany(), { agentId, owner: OTHER_OWNER });
      chain.link(row, { wallet: OWNER });
    }
    // Statements record the address as the wallet of agents 5, 6, 7, then 3: the wallet log
    // answers 3, 7, 6, 5, newest first.
    const deps = statementDeps(s, chain);
    for (const agentId of ["5", "6", "7", "3"])
      expectStatement(await statementForAgent(deps, agentId));
    chain.snapshots.length = 0;

    expectStatement(await statementForAddress(deps, OWNER));
    // The owner's agents newest first (3, 2, 1), then the wallet log's without agent 3 again (7,
    // 6), cut at five; then the first three of them, each in its own snapshot.
    expect(chain.snapshots.map((r) => r.map((a) => a.agentId))).toEqual([
      [3n, 2n, 1n, 7n, 6n],
      [3n],
      [2n],
      [1n],
    ]);
  });

  test("at most five candidates are read and three stated", async () => {
    for (const agentId of ["101", "102", "103", "104", "105", "106"])
      linkedBody({ agentId, status: "draft" });
    const { signer, signed } = countingSigner();
    const out = expectStatement(
      await statementForAddress(statementDeps(s, chain, { signer }), OWNER),
    );
    expect(out).toMatchObject({ agentId: "106", standing: "pending" });
    expect(chain.snapshots.map((r) => r.map((a) => a.agentId))).toEqual([
      [106n, 105n, 104n, 103n, 102n],
      [106n],
      [105n],
      [104n],
    ]);
    expect(signed()).toBe(3);
    expect(logRows()).toHaveLength(3);
  });

  test("the candidates' snapshot that fails: unknown, with no agent id", async () => {
    linkedBody();
    chain.beforeSnapshot = () => {
      throw Object.assign(new Error("HTTP request failed. Status: 503"), {
        name: "HttpRequestError",
      });
    };
    await expect(statementForAddress(statementDeps(s, chain), OWNER)).resolves.toEqual({
      kind: "unknown",
      agentId: null,
      stage: "snapshot",
      errorName: "HttpRequestError",
    });
    expect(opsLines("legal_body_statement_unavailable")).toEqual([
      { stage: "snapshot", errorName: "HttpRequestError" },
    ]);
  });

  test("an address with no candidate, or no address at all: none, with no chain read", async () => {
    linkedBody();
    for (const address of [OTHER_OWNER, zeroAddress])
      await expect(statementForAddress(statementDeps(s, chain), address)).resolves.toEqual({
        kind: "none",
      });
    expect(chain.snapshots).toEqual([]);

    // Not an address: not even the database is asked.
    const owned = vi.spyOn(s.repo, "listAgentIdsByIdentityOwner");
    const logged = vi.spyOn(s.statements, "agentIdsByWallet");
    for (const junk of ["not-an-address", "0x1234", ""])
      await expect(statementForAddress(statementDeps(s, chain), junk as Address)).resolves.toEqual({
        kind: "none",
      });
    expect(owned).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    expect(chain.snapshots).toEqual([]);
  });

  test("a database read that fails propagates", async () => {
    linkedBody();
    vi.spyOn(s.statements, "agentIdsByWallet").mockImplementation(() => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    });
    await expect(statementForAddress(statementDeps(s, chain), OWNER)).rejects.toThrow(
      "SQLITE_IOERR",
    );
  });
});

test("no ops line carries a name, a filing number, an address or an error's text", async () => {
  const row = linkedBody();
  chain.link(row, { wallet: WALLET });
  const deps = statementDeps(s, chain);
  await statementForAgent(deps, "42");
  await statementForAddress(deps, WALLET);
  // A body with no public row, a refusal, a failing log write, a failing chain.
  chain.linked.set("42", STRAY_BODY);
  await statementForAgent(deps, "42");
  chain.link(row, { wallet: WALLET, creator: OTHER_OWNER });
  await statementForAgent(deps, "42");
  chain.link(row, { wallet: WALLET });
  const append = vi.spyOn(s.statements, "appendIfChanged").mockImplementation(() => {
    throw new Error(`constraint failed for ${WALLET} and Example Holdings LLC`);
  });
  await statementForAgent(deps, "42");
  append.mockRestore();
  chain.beforeSnapshot = () => {
    throw new Error(`HTTP 429 from https://rpc.example/v2/key for ${row.bodyAddress}`);
  };
  await statementForAgent(deps, "42");
  await statementForAddress(deps, WALLET);

  // Every line printed is an ops line: a line of any other form fails the parse, and the test.
  const events = printed.map((line) => (JSON.parse(line) as OpsLine).opslog);
  expect(new Set(events)).toEqual(
    new Set([
      "legal_body_statement",
      "legal_body_statement_unlisted_body",
      "legal_body_statement_integrity",
      "legal_body_statement_log_failed",
      "legal_body_statement_unavailable",
    ]),
  );
  const all = printed.join("\n");
  expect(all).not.toMatch(/0x[0-9a-fA-F]{40}/);
  for (const secret of [
    "Example Holdings LLC",
    "TEST-0001",
    "Example Registered Agent",
    "rpc.example",
    "constraint failed",
  ])
    expect(all).not.toContain(secret);
});
