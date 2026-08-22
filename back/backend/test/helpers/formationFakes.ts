/**
 * Shared fakes for the formation loop (design §11).
 *
 * The doola client is faked at the `DoolaApi` seam — the same narrow interface production wraps —
 * so a test can make the PROVIDER say one thing while the webhook payload says another, which is
 * how the wake-up-only rule (audit H2) is actually proven rather than asserted.
 */
import type { DoolaApi } from "../../src/adapters/doola/doolaClient";
import type {
  DoolaCompany,
  DoolaDocument,
  DoolaRequiredAction,
} from "../../src/adapters/doola/types";
import type { HostLookup } from "../../src/payments/ssrfGuard";
import type { DocumentStore, PutResult } from "../../src/persistence/documentStore";
import type { EntityRecord } from "../../src/types";

export const ENTITY_KEY = "tenant-a:agent-1";
export const TENANT = "tenant-a";
export const COMPANY_ID = "cmp-1";

/** A pinned, doola-formed entity that has finished its on-chain onboarding. */
export function formedEntity(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    idempotencyKey: ENTITY_KEY,
    name: "Formation Agent",
    status: "funded",
    manager: "0x0000000000000000000000000000000000000001",
    guardian: "0x0000000000000000000000000000000000000002",
    operator: "0x0000000000000000000000000000000000000003",
    amendmentDelay: "86400",
    // The placeholder frozen on-chain at mint. `ein_real` is the legal fact; this never changes.
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    oaHash: "0xaaaa",
    metadataURI: "https://api.example.com/metadata/33333333-3333-3333-3333-333333333333",
    publicId: "33333333-3333-3333-3333-333333333333",
    docPath: null,
    treasuryConfig: null,
    agentId: "42",
    proxy: "0x0000000000000000000000000000000000000abc",
    treasury: "0x0000000000000000000000000000000000000def",
    createTxHash: "0xcreate",
    bindTxHash: "0xbind",
    fundTxHash: "0xfund",
    ownerTenantId: TENANT,
    formationProvider: "doola",
    formationEnvironment: "sandbox",
    oaManifestVersion: 1,
    oaManifestAnchoredHash: "0xaaaa",
    ...over,
  };
}

export interface FakeDoolaState {
  company: DoolaCompany;
  documents: DoolaDocument[];
  requiredActions: DoolaRequiredAction[];
  /** Bytes served for each document id by the fake download URL. */
  bytes: Record<string, Buffer>;
  /** Set to make the next call of the named method throw. */
  failNext?: Partial<Record<"getCompany" | "listDocuments" | "getDocumentDownloadUrl", boolean>>;
}

export interface FakeDoola {
  api: DoolaApi;
  state: FakeDoolaState;
  /** A `typeof fetch` that serves the fake download URLs as PDFs. */
  fetchImpl: typeof fetch;
  /** A DNS resolver for the fake hosts, so the suite never touches the network. The SSRF
   *  classification still runs against what this returns — only the lookup is substituted. */
  lookupImpl: HostLookup;
  calls: string[];
}

/** Answers every name with one ordinary globally-routable unicast address. NOT a documentation
 *  range: ipaddr.js classifies 192.0.2.0/24 and 203.0.113.0/24 as `reserved`, and the SSRF check
 *  correctly refuses those — the substitution is of the RESOLVER, not of the classification. */
export const publicHostLookup: HostLookup = async () => [{ address: "93.184.216.34" }];

const PDF = (id: string) => Buffer.from(`%PDF-1.7\n${id}\n`);

/**
 * A doola whose answers a test controls. Only the methods the processor uses are implemented; the
 * rest throw, so a call the design does not sanction fails loudly rather than silently.
 */
export function fakeDoola(over: Partial<FakeDoolaState> = {}): FakeDoola {
  const calls: string[] = [];
  const state: FakeDoolaState = {
    company: { doolaCompanyId: COMPANY_ID, formationSubmissionStatus: "SUBMITTED" },
    documents: [],
    requiredActions: [],
    bytes: {},
    ...over,
  };

  const maybeFail = (name: keyof NonNullable<FakeDoolaState["failNext"]>) => {
    if (state.failNext?.[name]) {
      state.failNext[name] = false;
      throw new Error(`doola ${name} is down`);
    }
  };

  const api = {
    async getCompany(id: string) {
      calls.push(`getCompany:${id}`);
      maybeFail("getCompany");
      return state.company;
    },
    async listDocuments(id: string) {
      calls.push(`listDocuments:${id}`);
      maybeFail("listDocuments");
      return state.documents;
    },
    async listRequiredActions(id: string) {
      calls.push(`listRequiredActions:${id}`);
      return state.requiredActions;
    },
    async getDocumentDownloadUrl(companyId: string, docId: string) {
      calls.push(`getDocumentDownloadUrl:${docId}`);
      maybeFail("getDocumentDownloadUrl");
      const doc = state.documents.find((d) => d.id === docId);
      return { ...(doc ?? { id: docId }), downloadUrl: `https://files.doola.test/${docId}` };
    },
    createCustomer: notImplemented("createCustomer"),
    createCompany: notImplemented("createCompany"),
    listCompanies: notImplemented("listCompanies"),
    getComplianceCalendar: notImplemented("getComplianceCalendar"),
    playgroundCompleteFormation: notImplemented("playgroundCompleteFormation"),
    playgroundCompleteEin: notImplemented("playgroundCompleteEin"),
  } as unknown as DoolaApi;

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(`fetch:${url}`);
    const id = url.split("/").pop() ?? "";
    const body = state.bytes[id] ?? PDF(id);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }) as unknown as typeof fetch;

  return { api, state, fetchImpl, lookupImpl: publicHostLookup, calls };
}

function notImplemented(name: string) {
  return async () => {
    throw new Error(`fakeDoola.${name} must not be called by this code path`);
  };
}

/** doola document fixtures, spelled the way the wire spells them (`documentType`, not `type`). */
export function doolaDoc(id: string, documentType: string): DoolaDocument {
  return { id, companyId: COMPANY_ID, name: `${documentType}.pdf`, documentType };
}

/** An in-memory DocumentStore: the atomic-write ceremony has its own tests; this one only needs
 *  to remember bytes so a download route and a hash comparison have something to read. */
export class MemoryDocumentStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();

  put(name: string, contents: string): PutResult {
    return this.putBytes(name, Buffer.from(contents, "utf8"));
  }
  get(id: string): string {
    return this.getBytes(id).toString("utf8");
  }
  putBytes(name: string, bytes: Buffer): PutResult {
    this.files.set(name, Buffer.from(bytes));
    return { id: name, path: `/memory/${name}`, uri: `file:///memory/${name}` };
  }
  getBytes(id: string): Buffer {
    const b = this.files.get(id);
    if (!b) throw new Error(`no such document: ${id}`);
    return b;
  }
  async getBytesAsync(id: string): Promise<Buffer> {
    return this.getBytes(id);
  }
}
