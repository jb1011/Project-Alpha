/**
 * Pilot case rows for the public case view: a fresh `created` row, and a full `settled` row in
 * each of the three modes, every column set. Every address is a placeholder, every hash a repeated
 * byte, every name an invention. The row's `error` and `localDisputeId` carry sentinels a test can
 * look for in what the route serves.
 */
import { getAddress } from "viem";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import { PUBLIC_STATEMENT_TTL_SECONDS } from "../../src/legalBody/publicStatement";
import type { Standing } from "../../src/legalBody/standing";
import type {
  KlerosChainOnRow,
  NewPilotCase,
  PilotCaseRecord,
  PilotMode,
} from "../../src/pilot/types";

export const BUYER = "0x00000000000000000000000000000000000000b1";
export const SELLER = "0x00000000000000000000000000000000000000b2";
export const REFEREE = "0x00000000000000000000000000000000000000b3";
export const JOB_CONTRACT = "0x00000000000000000000000000000000000000c1";
export const BUYER_AGENT = "11";
export const SELLER_AGENT = "12";
export const CHAIN_ID = 5042002;

/** A 32-byte hex value of one repeated byte. */
export const hash = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;

/** Never served: the row's own error text, quoting a URL with a key and a file. */
export const ERROR_SENTINEL =
  "rpc failed at https://rpc.example.test/?apiKey=SENTINELKEY reading /srv/novi/data/pilot.db";
/** Never served: the Dispute Service's local id. */
export const LOCAL_DISPUTE_ID = "918273645";

/** The Kleros deployment a full row of the mode was filed with. */
export const CHAIN_OF: Record<PilotMode, KlerosChainOnRow> = {
  rehearsal: "fake",
  testnet: "arbitrum-sepolia-testnet",
  live: "arbitrum-one",
};
export const COURT_OF: Record<PilotMode, number | null> = { rehearsal: null, testnet: 8, live: 34 };
/** The two public cases the Court interface patterns were checked on, and one for the fake. */
export const CORE_ID_OF: Record<PilotMode, string> = {
  rehearsal: "3",
  testnet: "186",
  live: "287",
};

const T0 = 1_790_000_000;

/** What `pilot:job` inserts: the row at `created`. */
export function newCase(over: Partial<NewPilotCase> = {}): NewPilotCase {
  return {
    caseId: "pc_0123456789ab",
    label: "TEST-1",
    mode: "rehearsal",
    chainId: CHAIN_ID,
    jobContract: JOB_CONTRACT,
    buyerAddress: BUYER,
    buyerAgentId: BUYER_AGENT,
    sellerAddress: SELLER,
    sellerAgentId: SELLER_AGENT,
    refereeAddress: REFEREE,
    budgetAtomic: "2000000",
    description: "Clean the supplier list and return it as a CSV file (test data).",
    expiredAt: 1_800_000_000,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
    ...over,
  };
}

/** The stored ids of a case's files in the document store (flat: the store makes no folders). */
export function storedIdsOf(caseId: string) {
  return {
    deliverable: `pilot-${caseId}-deliverable.csv`,
    evidence: `pilot-${caseId}-evidence.txt`,
    buyerRecord: `pilot-${caseId}-buyer-record.json`,
    sellerRecord: `pilot-${caseId}-seller-record.json`,
  };
}

/** Every column a case gains from `funded` to `settled`, for a row of `mode`. No identity field,
 *  no status, no timestamp: a repository patch takes this as it is. */
export function fullPatch(mode: PilotMode, caseId: string): Partial<PilotCaseRecord> {
  const ids = storedIdsOf(caseId);
  return {
    jobId: "42",
    deliverablePath: ids.deliverable,
    deliverableHash: hash("d1"),
    deliverableExtension: "csv",
    createTxHash: hash("a1"),
    fundTxHash: hash("a2"),
    submitTxHash: hash("a3"),
    createdBlockTime: T0,
    fundedBlockTime: T0 + 10,
    submittedBlockTime: T0 + 20,
    contestReason: "The file has 3 rows; the job asked for 30.",
    contestReply: "The source list had 3 rows.",
    contestedAt: T0 + 30,
    buyerRecordPath: ids.buyerRecord,
    sellerRecordPath: ids.sellerRecord,
    evidencePath: ids.evidence,
    evidenceSha256: hash("e1"),
    evidenceName: "Job TEST-1: the complete record (test data)",
    klerosChain: CHAIN_OF[mode],
    klerosCourtId: COURT_OF[mode],
    klerosPolicyUri: mode === "rehearsal" ? null : "ipfs://policy-placeholder",
    attachmentUri: "/ipfs/bafyexamplecid",
    attachmentCid: "bafyexamplecid",
    filingStartedAt: T0 + 40,
    coreDisputeId: CORE_ID_OF[mode],
    localDisputeId: LOCAL_DISPUTE_ID,
    createDisputeTx: hash("b1"),
    filedAt: T0 + 50,
    evidenceTx: hash("b2"),
    evidenceStatus: "mined",
    rulingStatus: "Executed",
    rulingValue: "1",
    rulingTied: 0,
    rulingRoundCount: 1,
    rulingLabel: "Pay the provider",
    rulingReadAt: T0 + 60,
    rulingDeadline: "2026-11-01T00:00:00Z",
    settleAction: "complete",
    settleReason: hash("c1"),
    settleTxHash: hash("a4"),
    settledAt: T0 + 70,
    escrowOutcome: "released",
    error: ERROR_SENTINEL,
  };
}

/** Every column of a fresh row, as the repository would read it back. */
export function freshRecord(over: Partial<PilotCaseRecord> = {}): PilotCaseRecord {
  return {
    ...newCase(),
    status: "created",
    jobId: null,
    createTxHash: null,
    fundTxHash: null,
    submitTxHash: null,
    createdBlockTime: null,
    fundedBlockTime: null,
    submittedBlockTime: null,
    contestReason: null,
    contestReply: null,
    contestedAt: null,
    buyerRecordPath: null,
    sellerRecordPath: null,
    evidencePath: null,
    evidenceSha256: null,
    evidenceName: null,
    klerosChain: null,
    klerosCourtId: null,
    klerosPolicyUri: null,
    attachmentUri: null,
    attachmentCid: null,
    filingStartedAt: null,
    coreDisputeId: null,
    localDisputeId: null,
    createDisputeTx: null,
    filedAt: null,
    evidenceTx: null,
    evidenceStatus: null,
    rulingStatus: null,
    rulingValue: null,
    rulingTied: null,
    rulingRoundCount: null,
    rulingLabel: null,
    rulingReadAt: null,
    rulingDeadline: null,
    settleAction: null,
    settleReason: null,
    settleTxHash: null,
    settledAt: null,
    escrowOutcome: null,
    error: null,
    createdAt: "2026-10-28 09:00:00",
    updatedAt: "2026-10-28 09:00:00",
    ...over,
  };
}

/** A full `settled` row of `mode`, every column set. */
export function fullRecord(mode: PilotMode, over: Partial<PilotCaseRecord> = {}): PilotCaseRecord {
  const caseId = over.caseId ?? "pc_0123456789ab";
  return freshRecord({
    caseId,
    mode,
    ...fullPatch(mode, caseId),
    status: "settled",
    updatedAt: "2026-10-28 10:30:00",
    ...over,
  });
}

/** When the fixture statements were issued (unix seconds); they expire one TTL later. */
export const STATEMENT_ISSUED_AT = 1_790_000_000;

/** The answer by agent that carries a signed statement. */
export type SignedAnswer = Extract<ByAgentAnswer, { publicId: string }>;

/**
 * A lookup answer by agent with a statement, as the pilot stores it at filing. The message is a
 * well-formed statement (EIP-55 addresses, one TTL between issue and expiry), so a test can sign
 * it for real; the signature here is a placeholder.
 */
export function answerFor(
  agentId: string,
  legalName: string,
  standing: Standing = "active",
): SignedAnswer {
  return {
    agentId,
    legalBody: true,
    standing,
    publicId: `pub_${agentId}`,
    network: "testnet",
    links: {
      transparency: "https://www.example.test/transparency",
      statement: `https://api.example.test/legal-bodies/by-agent/${agentId}`,
    },
    checkedAt: "2026-10-28T09:30:00.000Z",
    statement: {
      domain: { name: "Novi legal body statement", version: "2", chainId: CHAIN_ID },
      primaryType: "LegalBodyStatement",
      message: {
        chainId: String(CHAIN_ID),
        identityRegistry: getAddress("0x00000000000000000000000000000000000000e1"),
        factory: getAddress("0x00000000000000000000000000000000000000e2"),
        legalBody: getAddress("0x00000000000000000000000000000000000000e3"),
        agentId,
        agentWallet: getAddress("0x00000000000000000000000000000000000000e4"),
        identityOwnerAtCreation: getAddress("0x00000000000000000000000000000000000000e5"),
        bindingState: "linked",
        identityOwnerIsContract: false,
        agentWalletIsContract: false,
        standing,
        attestationState: "active",
        jurisdiction: "WY",
        entityType: "LLC",
        legalName,
        filingNumber: "2026-000000001",
        source: "customer",
        environment: "sandbox",
        controlVerified: true,
        existenceCheckedAt: "1790000000",
        filedAt: "2026-10-01",
        einIssued: false,
        filingStatus: "not_yet_due",
        lastFiledPeriod: "0",
        lastFiledAt: "",
        lastFiledConfirmedBy: "",
        nextDue: "2027-10-01",
        oaManifestHash: hash("f1"),
        oaManifestVersion: "1",
        guardianHumanVerified: true,
        observedAtBlock: "1000",
        issuedAt: String(STATEMENT_ISSUED_AT),
        expiresAt: String(STATEMENT_ISSUED_AT + PUBLIC_STATEMENT_TTL_SECONDS),
      },
      attestor: getAddress("0x00000000000000000000000000000000000000e6"),
      signature: `0x${"ab".repeat(65)}`,
    },
  };
}

export const BUYER_NAME = "Example Buyer Agent DAO LLC";
export const SELLER_NAME = "Example Seller Agent DAO LLC";
export const EVIDENCE_TEXT =
  "TEST DATA. Job TEST-1 between two test agents on Arc testnet: the record a juror reads.";
