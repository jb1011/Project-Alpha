/**
 * Resuming the legal-body flow from the server's state: what the local memory holds after a thread
 * is shown, which local choices count for which order, what a "start another" click overrides,
 * where a rail jump sends the derivation, the flow's clock, and the chooser's rows.
 */
import { describe, expect, test } from "vitest";
import type { Address, CompanyView, LegalBodyOrderView } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyThread } from "@/lib/legalBody/flow";
import { LEGAL_BODY_PHASES } from "@/lib/legalBody/phases";
import type { LegalBodyMemory } from "@/lib/legalBody/storage";
import {
  chooserRows,
  draftChoices,
  flowNowMs,
  identitySuggestionAfter,
  jumpMemoryPatch,
  memoryAfterThread,
  mergeLegalBodyMemory,
  patchEndsIntent,
  threadRefsOf,
  threadWithIntent,
} from "@/lib/legalBody/resume";

/** Anvil's first published test account, and the public testnet factory. */
const TENANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as Address;
const OTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as Address;
const CHAIN = 5042002;
const WHERE = { chainId: CHAIN, factory: FACTORY };

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const memory = (over: Partial<LegalBodyMemory> = {}): LegalBodyMemory => ({
  tenant: TENANT,
  companyId: null,
  orderId: null,
  ownerChoice: null,
  agentId: null,
  ...over,
});

const company = (companyId: string, over: Partial<CompanyView> = {}): CompanyView => ({
  companyId,
  environment: "sandbox",
  nameOptions: [],
  legalNameFiled: null,
  businessPurpose: "",
  industryLabel: "",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: NOW - 2 * HOUR,
  provider: "customer",
  declared: { companyName: "Example Test Holdings LLC", filingNumber: "TEST-0001", wordingVersion: "v1" },
  verification: { state: "verified", checkedAt: null, reasonCode: null },
  ...over,
});

const order = (id: string, companyId: string, over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id,
  publicId: `pub_${id}`,
  companyId,
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: TENANT,
  amendmentDelay: 172_800,
  agreement: null,
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: iso(NOW - HOUR),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

describe("threadRefsOf", () => {
  test("the ids a screen reads for each thread", () => {
    expect(threadRefsOf({ kind: "order", companyId: "c1", orderId: "o1" })).toEqual({ companyId: "c1", orderId: "o1" });
    expect(threadRefsOf({ kind: "done", companyId: "c1", orderId: "o1" })).toEqual({ companyId: "c1", orderId: "o1" });
    expect(threadRefsOf({ kind: "closed-order", companyId: "c1", orderId: "o1" })).toEqual({ companyId: "c1", orderId: "o1" });
    expect(threadRefsOf({ kind: "company", companyId: "c1" })).toEqual({ companyId: "c1", orderId: null });
    expect(threadRefsOf({ kind: "new-company" })).toEqual({ companyId: null, orderId: null });
    expect(threadRefsOf({ kind: "chooser", threads: [] })).toBeNull();
  });
});

describe("memoryAfterThread", () => {
  const after = (stored: LegalBodyMemory | null, thread: LegalBodyThread) =>
    memoryAfterThread({ tenant: TENANT, stored, thread });

  test("an order thread is remembered with its company", () => {
    expect(after(null, { kind: "order", companyId: "c1", orderId: "o1" })).toEqual(
      memory({ companyId: "c1", orderId: "o1" }),
    );
  });

  test("the same order keeps its draft choices", () => {
    const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "this-wallet", agentId: "42" });
    expect(after(stored, { kind: "order", companyId: "c1", orderId: "o1" })).toBeNull();
  });

  test("another order drops the choices made for the previous one", () => {
    const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "elsewhere", agentId: "42" });
    expect(after(stored, { kind: "order", companyId: "c1", orderId: "o2" })).toEqual(
      memory({ companyId: "c1", orderId: "o2" }),
    );
  });

  test("a closed order is shown once: its id is forgotten after it is rendered", () => {
    const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "this-wallet", agentId: "42" });
    expect(after(stored, { kind: "closed-order", companyId: "c1", orderId: "o1" })).toEqual(
      memory({ companyId: "c1" }),
    );
  });

  test("a company thread holds no order and no choice", () => {
    const stored = memory({ companyId: "c0", orderId: "o0", agentId: "7" });
    expect(after(stored, { kind: "company", companyId: "c1" })).toEqual(memory({ companyId: "c1" }));
  });

  test("a done page is remembered, so a reload shows it again", () => {
    expect(after(null, { kind: "done", companyId: "c1", orderId: "o1" })).toEqual(
      memory({ companyId: "c1", orderId: "o1" }),
    );
  });

  test("a new company forgets what is no longer a thread", () => {
    expect(after(memory({ companyId: "gone" }), { kind: "new-company" })).toEqual(memory());
  });

  test("nothing to write when nothing changes, or for a chooser", () => {
    expect(after(null, { kind: "new-company" })).toBeNull();
    expect(after(memory(), { kind: "new-company" })).toBeNull();
    expect(after(memory({ companyId: "c1" }), { kind: "chooser", threads: [] })).toBeNull();
  });
});

describe("draftChoices", () => {
  const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "this-wallet", agentId: "42" });

  test("the choices count for the order they were made for", () => {
    expect(draftChoices(stored, { kind: "order", companyId: "c1", orderId: "o1" })).toEqual({
      ownerChoice: "this-wallet",
      agentId: "42",
    });
  });

  test("never for another order: a new order starts at the agreement, not at the link", () => {
    expect(draftChoices(stored, { kind: "order", companyId: "c1", orderId: "o2" })).toEqual({
      ownerChoice: null,
      agentId: null,
    });
  });

  test("never outside an order thread, and never without a memory", () => {
    expect(draftChoices(stored, { kind: "company", companyId: "c1" })).toEqual({ ownerChoice: null, agentId: null });
    expect(draftChoices(stored, { kind: "done", companyId: "c1", orderId: "o1" })).toEqual({ ownerChoice: null, agentId: null });
    expect(draftChoices(null, { kind: "order", companyId: "c1", orderId: "o1" })).toEqual({ ownerChoice: null, agentId: null });
  });
});

describe("mergeLegalBodyMemory", () => {
  test("a patch over a base, for this tenant", () => {
    expect(mergeLegalBodyMemory(TENANT, memory({ companyId: "c1", orderId: "o1" }), { agentId: "42", ownerChoice: "elsewhere" })).toEqual(
      memory({ companyId: "c1", orderId: "o1", agentId: "42", ownerChoice: "elsewhere" }),
    );
  });

  test("no base: an empty memory for this tenant", () => {
    expect(mergeLegalBodyMemory(TENANT, null, { companyId: "c1" })).toEqual(memory({ companyId: "c1" }));
  });

  test("the base's tenant never wins over the session's", () => {
    const other = memory({ tenant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address, companyId: "c1" });
    expect(mergeLegalBodyMemory(TENANT, other, {}).tenant).toBe(TENANT);
  });
});

describe("threadWithIntent", () => {
  const p = (companies: CompanyView[], orders: LegalBodyOrderView[]) => ({ companies, orders, nowMs: NOW, where: WHERE });
  const done: LegalBodyThread = { kind: "done", companyId: "c1", orderId: "linked" };
  const linked = order("linked", "c1", { state: "linked", agentId: "1" });

  test("no intent: the selection stands", () => {
    expect(threadWithIntent(done, null, p([company("c1")], [linked]))).toBe(done);
  });

  const anotherAgent = (known: string[]) => ({ kind: "another-agent" as const, companyId: "c1", known });

  test("another agent on the same company: that company, until its new order exists", () => {
    expect(threadWithIntent(done, anotherAgent(["linked"]), p([company("c1")], [linked]))).toEqual({
      kind: "company",
      companyId: "c1",
    });
  });

  test("an order already there at the click is not the new one, live or not", () => {
    const open = order("open", "c1");
    expect(threadWithIntent(done, anotherAgent(["linked", "open"]), p([company("c1")], [linked, open]))).toEqual({
      kind: "company",
      companyId: "c1",
    });
  });

  test("once the new order exists, it is the thread while it is live", () => {
    const fresh = order("fresh", "c1");
    expect(threadWithIntent(done, anotherAgent(["linked"]), p([company("c1")], [linked, fresh]))).toEqual({
      kind: "order",
      companyId: "c1",
      orderId: "fresh",
    });
  });

  test("once the new order is linked, the selection stands: the intent never holds a finished thread back", () => {
    const fresh = order("fresh", "c1", { state: "linked", agentId: "2" });
    const doneFresh: LegalBodyThread = { kind: "done", companyId: "c1", orderId: "fresh" };
    expect(threadWithIntent(doneFresh, anotherAgent(["linked"]), p([company("c1")], [linked, fresh]))).toBe(doneFresh);
  });

  test("the newest new order when there are several", () => {
    const older = order("older", "c1", { createdAt: iso(NOW - 3 * HOUR) });
    const newer = order("newer", "c1", { createdAt: iso(NOW - HOUR) });
    expect(threadWithIntent(done, anotherAgent([]), p([company("c1")], [older, newer]))).toEqual({
      kind: "order",
      companyId: "c1",
      orderId: "newer",
    });
  });

  test("a new order under another factory is not continued here", () => {
    const foreign = order("foreign", "c1", { factory: OTHER_FACTORY });
    expect(threadWithIntent(done, anotherAgent([]), p([company("c1")], [foreign]))).toBe(done);
  });

  test("a company that is not the tenant's: the selection stands", () => {
    expect(
      threadWithIntent(done, { kind: "another-agent", companyId: "nope", known: [] }, p([company("c1")], [linked])),
    ).toBe(done);
  });

  test("another company: a new declaration, until a company appears that was not there at the click", () => {
    const intent = { kind: "another-company" as const, known: ["c1"] };
    expect(threadWithIntent(done, intent, p([company("c1")], [linked]))).toEqual({ kind: "new-company" });
    expect(threadWithIntent(done, intent, p([company("c1"), company("c2")], [linked]))).toBe(done);
  });
});

describe("patchEndsIntent", () => {
  test("a click that names the thread ends a pending intent", () => {
    expect(patchEndsIntent({ companyId: "c2", orderId: null })).toBe(true);
    expect(patchEndsIntent({ orderId: "o2" })).toBe(true);
    expect(patchEndsIntent({ companyId: null })).toBe(true);
  });

  test("a choice inside the thread does not", () => {
    expect(patchEndsIntent({})).toBe(false);
    expect(patchEndsIntent({ ownerChoice: "this-wallet", agentId: "42" })).toBe(false);
    expect(patchEndsIntent({ agentId: null })).toBe(false);
  });
});

describe("jumpMemoryPatch", () => {
  test("back to the agreement forgets the owner choice and the identity", () => {
    expect(jumpMemoryPatch("agreement")).toEqual({ ownerChoice: null, agentId: null });
  });

  test("back to the identity forgets the identity only", () => {
    expect(jumpMemoryPatch("identity")).toEqual({ agentId: null });
  });

  test("every other phase is the server's to decide: nothing local changes", () => {
    for (const phase of ["signin", "human", "company", "link", "pointer", "payment", "done"] as const) {
      expect(jumpMemoryPatch(phase)).toBeNull();
    }
  });
});

describe("identitySuggestionAfter: the identity the identity step offers again, held in memory only", () => {
  const FIRST = "900001";
  const SECOND = "900002";

  test("a jump back to the identity takes the identity the jump clears", () => {
    expect(identitySuggestionAfter({ kind: "jump", target: "identity", agentId: FIRST }, null)).toBe(FIRST);
  });

  test("a jump back to the agreement takes it too", () => {
    expect(identitySuggestionAfter({ kind: "jump", target: "agreement", agentId: FIRST }, null)).toBe(FIRST);
  });

  test("a jump with no identity left to clear keeps the one already offered", () => {
    // From the identity step back to the agreement: the memory's identity was cleared by the
    // first jump, and the suggestion must survive the second.
    expect(identitySuggestionAfter({ kind: "jump", target: "agreement", agentId: null }, FIRST)).toBe(FIRST);
    expect(identitySuggestionAfter({ kind: "jump", target: "identity", agentId: null }, null)).toBeNull();
  });

  test("a jump that clears no identity changes nothing", () => {
    for (const target of ["signin", "human", "company", "link", "pointer", "payment", "done"] as const) {
      expect(identitySuggestionAfter({ kind: "jump", target, agentId: SECOND }, FIRST)).toBe(FIRST);
      expect(identitySuggestionAfter({ kind: "jump", target, agentId: SECOND }, null)).toBeNull();
    }
  });

  test("the suggestion is taken exactly where the jump clears the identity", () => {
    for (const { id } of LEGAL_BODY_PHASES) {
      const clears = Object.prototype.hasOwnProperty.call(jumpMemoryPatch(id) ?? {}, "agentId");
      const taken = identitySuggestionAfter({ kind: "jump", target: id, agentId: FIRST }, null);
      expect(taken).toBe(clears ? FIRST : null);
    }
  });

  test("a registration offers the new identity, over any earlier one", () => {
    expect(identitySuggestionAfter({ kind: "registered", agentId: SECOND }, null)).toBe(SECOND);
    expect(identitySuggestionAfter({ kind: "registered", agentId: SECOND }, FIRST)).toBe(SECOND);
  });

  test("picking the identity offered keeps it; picking another clears it", () => {
    expect(identitySuggestionAfter({ kind: "picked", agentId: FIRST }, FIRST)).toBe(FIRST);
    expect(identitySuggestionAfter({ kind: "picked", agentId: SECOND }, FIRST)).toBeNull();
    expect(identitySuggestionAfter({ kind: "picked", agentId: SECOND }, null)).toBeNull();
  });

  test("an identity found taken is dropped when it is the one offered", () => {
    expect(identitySuggestionAfter({ kind: "dropped", agentId: FIRST }, FIRST)).toBeNull();
    expect(identitySuggestionAfter({ kind: "dropped", agentId: SECOND }, FIRST)).toBe(FIRST);
  });

  test("a new order or a new company starts with none", () => {
    expect(identitySuggestionAfter({ kind: "start_another" }, FIRST)).toBeNull();
    expect(identitySuggestionAfter({ kind: "start_another" }, null)).toBeNull();
  });

  test("a draft the link door refused: the new order for the same agent offers the draft's identity", () => {
    expect(identitySuggestionAfter({ kind: "new_order_for", agentId: FIRST }, null)).toBe(FIRST);
    expect(identitySuggestionAfter({ kind: "new_order_for", agentId: null }, null)).toBeNull();
  });

  test("the clear of the new order, then the re-offer, applied in order, leave the draft's identity", () => {
    const cleared = identitySuggestionAfter({ kind: "start_another" }, SECOND);
    expect(identitySuggestionAfter({ kind: "new_order_for", agentId: FIRST }, cleared)).toBe(FIRST);
  });
});

describe("flowNowMs", () => {
  test("the latest of the mount and every read", () => {
    expect(flowNowMs(NOW, [NOW - HOUR, NOW + 5_000, 0])).toBe(NOW + 5_000);
  });

  test("no read yet: the mount", () => {
    expect(flowNowMs(NOW, [0, 0])).toBe(NOW);
    expect(flowNowMs(NOW, [])).toBe(NOW);
  });
});

describe("chooserRows", () => {
  const C = LEGAL_BODY_COPY.chooser;

  test("one row per thread, named by the declaration, with its state in words", () => {
    const companies = [company("c1"), company("c2", { declared: { companyName: "Second Test LLC", filingNumber: "TEST-0002", wordingVersion: "v1" } })];
    const orders = [order("o1", "c1", { state: "deployed", agentId: "897126" })];
    const rows = chooserRows(
      [
        { kind: "order", companyId: "c1", orderId: "o1" },
        { kind: "company", companyId: "c2" },
      ],
      companies,
      orders,
    );
    expect(rows).toEqual([
      {
        key: "order:o1",
        ref: { kind: "order", companyId: "c1", orderId: "o1" },
        title: "Example Test Holdings LLC",
        detail: C.orderStates.deployed,
        identity: "Identity 897126",
      },
      {
        key: "company:c2",
        ref: { kind: "company", companyId: "c2" },
        title: "Second Test LLC",
        detail: C.companyRow,
        identity: null,
      },
    ]);
  });

  test("a draft with no identity yet, and a company whose declaration could not be read", () => {
    const rows = chooserRows(
      [
        { kind: "order", companyId: "c1", orderId: "o1" },
        { kind: "company", companyId: "c3" },
      ],
      [company("c1"), company("c3", { declared: null })],
      [order("o1", "c1", { companyName: null })],
    );
    expect(rows[0]).toMatchObject({ title: "Example Test Holdings LLC", detail: C.orderStates.draft, identity: null });
    expect(rows[1]).toMatchObject({ title: C.unnamed });
  });
});
