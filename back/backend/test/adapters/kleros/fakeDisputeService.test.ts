/**
 * The fake Dispute Service: the scripted twin a rehearsal runs instead of Kleros.
 *
 * Its answers are written to a case row exactly as a real answer would be, and the settlement on
 * Arc testnet then acts on them, so what is pinned here is that every script answers in the
 * client's own shapes and outcome types: the period walk and the ruling of each script, the
 * refusals a rehearsal must catch (same tools and codes as the service's tables), the stable CID,
 * the record of calls, and that nothing ever reaches the network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateOutcome, DisputeRead } from "../../../src/adapters/kleros/disputeService";
import { KlerosRefusal, KlerosTransportError, sentOf } from "../../../src/adapters/kleros/errors";
import {
  FakeDisputeService,
  type FakeDisputeServiceOptions,
  type FakeScript,
} from "../../../src/adapters/kleros/fakeDisputeService";
import {
  HttpDisputeService,
  normaliseRulingValue,
  parseToolPayload,
} from "../../../src/adapters/kleros/httpDisputeService";

const T0 = 1_790_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLIENT = "0x1111111111111111111111111111111111111111" as Address;
const PROVIDER = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ALIASES = { client: CLIENT, provider: PROVIDER };
/** "%PDF-": five bytes. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const HASH = /^0x[0-9a-f]{64}$/;
const OPTIONS = [
  { value: "0x01", title: "Pay the provider" },
  { value: "0x02", title: "Refund the client" },
];
const REFUSE_LABEL = "Invalid / Refuse to Arbitrate";
const ALL_SCRIPTS: FakeScript[] = [
  "pay",
  "refund",
  "tie",
  "refuse",
  "stalled",
  "unknown-create",
  "unknown-submit",
  "write-in-progress-once",
  "insufficient-balance",
  "simulated",
];
const iso = (ms: number) => new Date(ms).toISOString();

type Harness = { service: FakeDisputeService; clock: { t: number } };

/** A fake on a clock the test moves. */
function harness(script: FakeScript, o: Partial<FakeDisputeServiceOptions> = {}): Harness {
  const clock = { t: T0 };
  const service = new FakeDisputeService({ script, now: () => clock.t, ...o });
  return { service, clock };
}

async function createMined(service: FakeDisputeService): Promise<string> {
  const created = await service.createDispute({ aliases: ALIASES });
  if (created.status !== "mined") throw new Error(`expected mined, got ${created.status}`);
  return created.coreDisputeId;
}

/** `n` reads of one case, the clock moving one minute before each: read i is at T0 + i min. */
async function reads(h: Harness, id: string, n: number): Promise<DisputeRead[]> {
  const out: DisputeRead[] = [];
  for (let i = 0; i < n; i++) {
    h.clock.t += MINUTE;
    out.push(await h.service.getDispute({ chain: "fake", coreDisputeId: id }));
  }
  return out;
}

/** What a call rejects with; the test fails when the call resolves. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected the call to reject, it resolved");
    },
    (err: unknown) => err,
  );
}

/** The refusal a call rejects with. */
async function refusal(p: Promise<unknown>): Promise<KlerosRefusal> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(KlerosRefusal);
  return e as KlerosRefusal;
}

/** No such case: the error the real client raises for an empty `items`, naming the chain. */
async function expectNoCase(p: Promise<unknown>, chain: string) {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(KlerosTransportError);
  expect((e as Error).message).toBe(`Kleros dispute_get: dispute not found on ${chain}`);
}

/** The real client on the testnet key, its fetch answering every call with `payload`. */
function realClientAnswering(payload: unknown): HttpDisputeService {
  const frame = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
  return new HttpDisputeService({
    apiUrl: "https://dispute-service.example.test/mcp",
    apiKey: "test-key-testnet",
    deployment: "testnet",
    fetch: async () =>
      new Response(`event: message\ndata: ${JSON.stringify(frame)}\n\n`, { status: 200 }),
    sleep: async () => {},
  });
}

async function expectRefusal(p: Promise<unknown>, tool: string, code: string) {
  const e = await refusal(p);
  expect(e.tool).toBe(tool);
  expect(e.code).toBe(code);
  return e;
}

/** The service's `unknown` text: a plain-English warning, then the JSON the client parses. */
function expectWarningThenJson(text: string, txHash: string | undefined) {
  const brace = text.indexOf("{");
  expect(brace).toBeGreaterThan(0);
  expect(text.slice(0, brace).trim()).toMatch(/^[A-Z][^{}]*\.$/);
  expect(() => JSON.parse(text)).toThrow();
  expect(parseToolPayload(text)).toEqual({ status: "unknown", txHash });
}

function txHashOf(o: { status: string; txHash?: string }): string | undefined {
  return o.txHash;
}

describe("the period walk and the ruling of each script", () => {
  it.each([
    ["pay", "1", false, "Pay the provider"],
    ["refund", "2", false, "Refund the client"],
    ["refuse", "0", false, REFUSE_LABEL],
  ] as const)(
    "%s: Evidence, Commit, Vote, then Appeal with ruling %j (tied %j) from read 4 on",
    async (script, ruling, tied, label) => {
      const h = harness(script);
      const id = await createMined(h.service);
      const submitted = await h.service.submitEvidence({
        coreDisputeId: id,
        name: "Job 7: what was delivered",
        description: "The provider delivered the report on time.",
      });
      expect(submitted).toEqual({ status: "mined", txHash: expect.stringMatching(HASH) });

      const r = await reads(h, id, 8);
      expect(r.map((x) => x.status)).toEqual([
        "Evidence",
        "Commit",
        "Vote",
        "Appeal",
        "Appeal",
        "Appeal",
        "Appeal",
        "Appeal",
      ]);
      // No majority yet before Appeal: ruling "0" with tied true, the docs' trap.
      for (const before of r.slice(0, 3)) {
        expect(before).toMatchObject({
          ruling: "0",
          tied: true,
          ruled: false,
          roundCount: 1,
          rulingLabel: REFUSE_LABEL,
          rulingOptions: OPTIONS,
          unresolvedFields: [],
        });
      }
      for (const appeal of r.slice(3)) {
        expect(appeal).toMatchObject({
          ruling,
          tied,
          ruled: false,
          roundCount: 1,
          rulingLabel: label,
          rulingOptions: OPTIONS,
          unresolvedFields: [],
        });
      }
    },
  );

  it.each([
    ["pay", "Pay the provider"],
    ["refund", "Refund the client"],
  ] as const)(
    "%s: the option values are spelled as hex, so a reader must normalise to match the ruling",
    async (script, title) => {
      const h = harness(script);
      const id = await createMined(h.service);
      const appeal = (await reads(h, id, 4))[3]!;
      expect(appeal.rulingOptions.some((o) => o.value === appeal.ruling)).toBe(false);
      const matched = appeal.rulingOptions.find(
        (o) => normaliseRulingValue(o.value) === normaliseRulingValue(appeal.ruling),
      );
      expect(matched?.title).toBe(title);
    },
  );

  it("tie: Appeal with ruling 0 tied from read 4, then Executed with 0 not tied and ruled from read 7 on", async () => {
    const h = harness("tie");
    const id = await createMined(h.service);
    const r = await reads(h, id, 10);
    expect(r.map((x) => x.status)).toEqual([
      "Evidence",
      "Commit",
      "Vote",
      "Appeal",
      "Appeal",
      "Appeal",
      "Executed",
      "Executed",
      "Executed",
      "Executed",
    ]);
    for (const appeal of r.slice(3, 6)) {
      expect(appeal).toMatchObject({ ruling: "0", tied: true, ruled: false, roundCount: 1 });
    }
    for (const executed of r.slice(6)) {
      expect(executed).toMatchObject({
        ruling: "0",
        tied: false,
        ruled: true,
        roundCount: 1,
        rulingLabel: REFUSE_LABEL,
        deadline: null,
      });
    }
  });

  it("stalled: reaches Vote and is still at Vote after 20 reads, its deadline an hour in the past", async () => {
    const h = harness("stalled");
    const id = await createMined(h.service);
    const r = await reads(h, id, 20);
    expect(r.slice(0, 2).map((x) => x.status)).toEqual(["Evidence", "Commit"]);
    r.slice(2).forEach((vote, i) => {
      const at = T0 + (i + 3) * MINUTE;
      expect(vote).toMatchObject({ status: "Vote", ruling: "0", tied: true, ruled: false });
      expect(vote.deadline).toBe(iso(at - HOUR));
    });
    expect(r.some((x) => x.status === "Appeal")).toBe(false);
  });

  it("unknown-create: answers unknown with a tx hash and the service's warning text, and creates nothing", async () => {
    const h = harness("unknown-create");
    const created = await h.service.createDispute({ aliases: ALIASES });
    expect(created).toEqual({
      status: "unknown",
      txHash: expect.stringMatching(HASH),
      text: expect.any(String),
    });
    if (created.status !== "unknown") throw new Error("unreachable");
    expectWarningThenJson(created.text, created.txHash);
    // Never mined, however often it is asked, and there is no case to read.
    expect((await h.service.createDispute({ aliases: ALIASES })).status).toBe("unknown");
    await expectNoCase(h.service.getDispute({ chain: "fake", coreDisputeId: "1000" }), "fake");
  });

  it("unknown-submit: the filing mines, the submission answers unknown, and the case still reaches a ruling", async () => {
    const h = harness("unknown-submit");
    const id = await createMined(h.service);
    const submitted = await h.service.submitEvidence({
      coreDisputeId: id,
      name: "Job 7",
      description: "The provider delivered.",
    });
    expect(submitted).toEqual({
      status: "unknown",
      txHash: expect.stringMatching(HASH),
      text: expect.any(String),
    });
    if (submitted.status !== "unknown") throw new Error("unreachable");
    expectWarningThenJson(submitted.text, submitted.txHash);
    const appeal = (await reads(h, id, 4))[3]!;
    expect(appeal).toMatchObject({ status: "Appeal", ruling: "1", tied: false });
  });

  it("write-in-progress-once: the first filing is refused with nothing sent, the next ones mine", async () => {
    const h = harness("write-in-progress-once");
    const e = await expectRefusal(
      h.service.createDispute({ aliases: ALIASES }),
      "dispute_create",
      "WRITE_IN_PROGRESS",
    );
    expect(sentOf("dispute_create", e.code)).toBe("no");
    expect(await h.service.createDispute({ aliases: ALIASES })).toMatchObject({
      status: "mined",
      coreDisputeId: "1000",
    });
    expect(await h.service.createDispute({ aliases: ALIASES })).toMatchObject({
      status: "mined",
      coreDisputeId: "1001",
    });
    const submitted = await h.service.submitEvidence({
      coreDisputeId: "1000",
      name: "Job 7",
      description: "The provider delivered.",
    });
    expect(submitted.status).toBe("mined");
    const appeal = (await reads(h, "1000", 4))[3]!;
    expect(appeal).toMatchObject({ status: "Appeal", ruling: "1", tied: false });
  });

  it("insufficient-balance: every filing is refused with nothing sent, and there is no case", async () => {
    const h = harness("insufficient-balance");
    for (let i = 0; i < 2; i++) {
      const e = await expectRefusal(
        h.service.createDispute({ aliases: ALIASES }),
        "dispute_create",
        "INSUFFICIENT_BALANCE",
      );
      expect(sentOf("dispute_create", e.code)).toBe("no");
    }
    await expectNoCase(h.service.getDispute({ chain: "fake", coreDisputeId: "1000" }), "fake");
  });

  it("simulated: answers the raw simulated status, and nothing exists to submit to or read", async () => {
    const h = harness("simulated");
    expect(await h.service.createDispute({ aliases: ALIASES })).toEqual({ status: "simulated" });
    await expectRefusal(
      h.service.submitEvidence({ coreDisputeId: "1000", name: "n", description: "d" }),
      "evidence_submit",
      "DISPUTE_NOT_FOUND",
    );
    await expectNoCase(h.service.getDispute({ chain: "fake", coreDisputeId: "1000" }), "fake");
  });

  it.each([
    [1, ["Appeal", "Appeal"]],
    [2, ["Evidence", "Appeal", "Appeal"]],
    [6, ["Evidence", "Commit", "Vote", "Vote", "Vote", "Appeal", "Appeal"]],
  ] as const)(
    "readsUntilAppeal %i: the extra pre-appeal reads stay at Vote",
    async (n, statuses) => {
      const h = harness("pay", { readsUntilAppeal: n });
      const id = await createMined(h.service);
      const r = await reads(h, id, statuses.length);
      expect(r.map((x) => x.status)).toEqual(statuses);
    },
  );

  it("tie with readsUntilAppeal 6: Appeal on reads 6 to 8, Executed from read 9", async () => {
    const h = harness("tie", { readsUntilAppeal: 6 });
    const id = await createMined(h.service);
    const r = await reads(h, id, 10);
    expect(r.map((x) => x.status)).toEqual([
      "Evidence",
      "Commit",
      "Vote",
      "Vote",
      "Vote",
      "Appeal",
      "Appeal",
      "Appeal",
      "Executed",
      "Executed",
    ]);
  });

  it("walks each case on its own count of reads", async () => {
    const h = harness("pay");
    const a = await createMined(h.service);
    const b = await createMined(h.service);
    expect((await reads(h, a, 4))[3]!.status).toBe("Appeal");
    expect((await reads(h, b, 1))[0]!.status).toBe("Evidence");
  });

  it("dates every read from its own now: deadlines, and lastPeriodChange at each change of period", async () => {
    const h = harness("tie");
    const id = await createMined(h.service);
    const r = await reads(h, id, 8);
    const at = (i: number) => T0 + (i + 1) * MINUTE;
    // Before Appeal: ten minutes ahead. At Appeal: 36 hours ahead. Executed: null.
    expect(r.map((x) => x.deadline)).toEqual([
      iso(at(0) + 10 * MINUTE),
      iso(at(1) + 10 * MINUTE),
      iso(at(2) + 10 * MINUTE),
      iso(at(3) + 36 * HOUR),
      iso(at(4) + 36 * HOUR),
      iso(at(5) + 36 * HOUR),
      null,
      null,
    ]);
    // Evidence opens when the dispute is created; every other period when a read first sees it.
    expect(r.map((x) => x.lastPeriodChange)).toEqual([
      iso(T0),
      iso(at(1)),
      iso(at(2)),
      iso(at(3)),
      iso(at(3)),
      iso(at(3)),
      iso(at(6)),
      iso(at(6)),
    ]);
  });

  it("keeps a raw item shaped like the service's dispute_get item, with the chain it was asked for", async () => {
    const h = harness("refund");
    const id = await createMined(h.service);
    await reads(h, id, 3);
    const read = await h.service.getDispute({
      chain: "arbitrum-sepolia-testnet",
      coreDisputeId: id,
    });
    const at = T0 + 3 * MINUTE;
    expect(read.raw).toEqual({
      id,
      status: "Appeal",
      ruling: "2",
      tied: false,
      ruled: false,
      ruledSemantics: "onchain",
      roundCount: 1,
      rulingLabel: "Refund the client",
      rulingOptions: OPTIONS,
      deadline: iso(at + 36 * HOUR),
      lastPeriodChange: iso(at),
      unresolvedFields: [],
      unresolvedReason: null,
      chain: "arbitrum-sepolia-testnet",
    });
  });

  it.each(["pay", "tie", "stalled"] as const)(
    "%s: every read is exactly what the real client makes of its raw item",
    async (script) => {
      const h = harness(script);
      const id = await createMined(h.service);
      const chain = "arbitrum-sepolia-testnet";
      for (let i = 0; i < 8; i++) {
        h.clock.t += MINUTE;
        const read = await h.service.getDispute({ chain, coreDisputeId: id });
        const real = realClientAnswering({ items: [read.raw], nextCursor: null, hasMore: false });
        expect(await real.getDispute({ chain, coreDisputeId: id })).toEqual(read);
      }
    },
  );
});

describe("createDispute", () => {
  it("numbers mined disputes from 1000 by default, the local id equal to the core id", async () => {
    const h = harness("pay");
    expect(await h.service.createDispute({ aliases: ALIASES })).toEqual({
      status: "mined",
      coreDisputeId: "1000",
      localDisputeId: "1000",
      txHash: expect.stringMatching(HASH),
    });
    expect(await h.service.createDispute({ aliases: ALIASES })).toMatchObject({
      coreDisputeId: "1001",
      localDisputeId: "1001",
    });
  });

  it("numbers from firstCoreId when given", async () => {
    const h = harness("refund", { firstCoreId: 42 });
    expect(await createMined(h.service)).toBe("42");
    expect(await createMined(h.service)).toBe("43");
  });

  it("answers deterministic 32-byte hashes, a fresh one per write", async () => {
    const run = async () => {
      const h = harness("pay");
      const created = await h.service.createDispute({ aliases: ALIASES });
      const s1 = await h.service.submitEvidence({
        coreDisputeId: "1000",
        name: "a",
        description: "b",
      });
      const s2 = await h.service.submitEvidence({
        coreDisputeId: "1000",
        name: "a",
        description: "b",
      });
      return [txHashOf(created), txHashOf(s1), txHashOf(s2)];
    };
    const first = await run();
    expect(await run()).toEqual(first);
    for (const hash of first) expect(hash).toMatch(HASH);
    expect(new Set(first).size).toBe(3);
  });

  it.each([
    ["no aliases at all", {}],
    ["aliases null", { aliases: null }],
    ["aliases an array", { aliases: [] }],
    ["aliases a string", { aliases: "client" }],
  ])("refuses %s with ALIASES_REQUIRED", async (_, args) => {
    const h = harness("pay");
    const e = await expectRefusal(
      h.service.createDispute(args as never),
      "dispute_create",
      "ALIASES_REQUIRED",
    );
    expect(sentOf("dispute_create", e.code)).toBe("no");
  });

  it.each(["buyer", "Client", "toString", "constructor"])(
    "refuses the slot %j with UNKNOWN_ALIAS_SLOT",
    async (slot) => {
      const h = harness("pay");
      const e = await expectRefusal(
        h.service.createDispute({ aliases: { client: CLIENT, [slot]: PROVIDER } }),
        "dispute_create",
        "UNKNOWN_ALIAS_SLOT",
      );
      expect(sentOf("dispute_create", e.code)).toBe("no");
    },
  );

  it("refuses the zero address with ZERO_ADDRESS_ALIAS", async () => {
    const h = harness("pay");
    const e = await expectRefusal(
      h.service.createDispute({ aliases: { client: CLIENT, provider: ZERO } }),
      "dispute_create",
      "ZERO_ADDRESS_ALIAS",
    );
    expect(sentOf("dispute_create", e.code)).toBe("no");
  });

  it("accepts no parties named, or one slot only", async () => {
    const h = harness("pay");
    expect((await h.service.createDispute({ aliases: {} })).status).toBe("mined");
    expect((await h.service.createDispute({ aliases: { provider: PROVIDER } })).status).toBe(
      "mined",
    );
  });

  it("takes its slots from aliasSlots when given", async () => {
    const h = harness("pay", { aliasSlots: ["buyer", "seller"] });
    expect((await h.service.createDispute({ aliases: { buyer: CLIENT } })).status).toBe("mined");
    await expectRefusal(
      h.service.createDispute({ aliases: { client: CLIENT } }),
      "dispute_create",
      "UNKNOWN_ALIAS_SLOT",
    );
  });

  it("checks the arguments before the script answers, and a refused filing takes no id", async () => {
    await expectRefusal(
      harness("insufficient-balance").service.createDispute({} as never),
      "dispute_create",
      "ALIASES_REQUIRED",
    );
    const h = harness("write-in-progress-once");
    await expectRefusal(
      h.service.createDispute({ aliases: { client: ZERO } }),
      "dispute_create",
      "ZERO_ADDRESS_ALIAS",
    );
    await expectRefusal(
      h.service.createDispute({ aliases: ALIASES }),
      "dispute_create",
      "WRITE_IN_PROGRESS",
    );
    expect(await createMined(h.service)).toBe("1000");
  });
});

describe("submitEvidence", () => {
  const base = { name: "Job 7: what was delivered", description: "The provider delivered." };

  it("refuses an id the fake never created with DISPUTE_NOT_FOUND", async () => {
    const h = harness("pay");
    await createMined(h.service);
    const e = await expectRefusal(
      h.service.submitEvidence({ ...base, coreDisputeId: "1001" }),
      "evidence_submit",
      "DISPUTE_NOT_FOUND",
    );
    expect(sentOf("evidence_submit", e.code)).toBe("no");
  });

  it.each([
    ["an empty name", { name: "" }, "NAME_INVALID"],
    ["a name of 1025 bytes", { name: "a".repeat(1025) }, "NAME_INVALID"],
    ["a name of 513 characters but 1026 UTF-8 bytes", { name: "é".repeat(513) }, "NAME_INVALID"],
    ["an empty description", { description: "" }, "DESCRIPTION_INVALID"],
    ["a description of 65537 bytes", { description: "a".repeat(65_537) }, "DESCRIPTION_INVALID"],
    ["a fileTypeExtension without fileUri", { fileTypeExtension: "pdf" }, "FILE_URI_INVALID"],
  ])("refuses %s with %s", async (_, patch, code) => {
    const h = harness("pay");
    const id = await createMined(h.service);
    const e = await expectRefusal(
      h.service.submitEvidence({ ...base, coreDisputeId: id, ...patch }),
      "evidence_submit",
      code,
    );
    expect(sentOf("evidence_submit", e.code)).toBe("no");
  });

  it("accepts a name of exactly 1024 UTF-8 bytes, a description of 65536, and a file with its extension", async () => {
    const h = harness("pay");
    const id = await createMined(h.service);
    const pinned = await h.service.pin({ bytes: PDF, extension: "pdf" });
    if (pinned.status !== "published") throw new Error("unreachable");
    const submitted = await h.service.submitEvidence({
      coreDisputeId: id,
      name: "é".repeat(512),
      description: "a".repeat(65_536),
      fileUri: pinned.fileUri,
      fileTypeExtension: "pdf",
    });
    expect(submitted.status).toBe("mined");
  });
});

describe("pin", () => {
  it("publishes /ipfs/fake-<46 hex of sha256> and answers the same CID for the same bytes", async () => {
    const hex = createHash("sha256").update(PDF).digest("hex").slice(0, 46);
    const first = await harness("pay").service.pin({ bytes: PDF, extension: "pdf" });
    expect(first).toEqual({
      status: "published",
      cid: `fake-${hex}`,
      fileUri: `/ipfs/fake-${hex}`,
    });
    const again = await harness("refund").service.pin({
      bytes: new Uint8Array(PDF),
      extension: "pdf",
    });
    expect(again).toEqual(first);
    const other = await harness("pay").service.pin({
      bytes: new Uint8Array([1]),
      extension: "pdf",
    });
    expect(other).not.toEqual(first);
  });

  it.each([".pdf", "PDF", "", "abcdefghijk", "p-f", "pdf "])(
    "refuses the extension %j with EXTENSION_INVALID",
    async (extension) => {
      const e = await expectRefusal(
        harness("pay").service.pin({ bytes: PDF, extension }),
        "evidence_pin",
        "EXTENSION_INVALID",
      );
      expect(sentOf("evidence_pin", e.code)).toBe("no");
    },
  );

  it.each(["pdf", "a", "abcdefghij", "mp4"])("accepts the extension %j", async (extension) => {
    const pinned = await harness("pay").service.pin({ bytes: PDF, extension });
    expect(pinned.status).toBe("published");
  });

  it("refuses zero bytes with FILE_EMPTY", async () => {
    const e = await expectRefusal(
      harness("pay").service.pin({ bytes: new Uint8Array(), extension: "pdf" }),
      "evidence_pin",
      "FILE_EMPTY",
    );
    expect(sentOf("evidence_pin", e.code)).toBe("no");
  });
});

describe("getDispute", () => {
  it("throws the real client's no-such-case error for a read before any filing, naming the chain asked for", async () => {
    const h = harness("pay");
    await expectNoCase(h.service.getDispute({ chain: "fake", coreDisputeId: "1000" }), "fake");
    await expectNoCase(
      h.service.getDispute({ chain: "arbitrum-sepolia-testnet", coreDisputeId: "1000" }),
      "arbitrum-sepolia-testnet",
    );
    expect(h.service.calls.map((c) => c.tool)).toEqual(["dispute_get", "dispute_get"]);
  });

  it("throws the very error the real client throws for an empty read", async () => {
    const chain = "arbitrum-sepolia-testnet";
    const real = await rejection(
      realClientAnswering({ items: [], nextCursor: null, hasMore: false }).getDispute({
        chain,
        coreDisputeId: "1000",
      }),
    );
    const fake = await rejection(
      harness("pay").service.getDispute({ chain, coreDisputeId: "1000" }),
    );
    expect(real).toBeInstanceOf(KlerosTransportError);
    expect(fake).toBeInstanceOf(KlerosTransportError);
    expect((fake as Error).message).toBe((real as Error).message);
  });

  it("answers any chain (it is the fake)", async () => {
    const h = harness("pay");
    const id = await createMined(h.service);
    for (const chain of ["fake", "arbitrum-sepolia-testnet", "arbitrum-one"] as const) {
      const read = await h.service.getDispute({ chain, coreDisputeId: id });
      expect((read.raw as { chain: string }).chain).toBe(chain);
    }
  });
});

describe("getCourt", () => {
  it.each([
    [34, [600, 2700, 1800, 129600]],
    [8, [900, 2700, 1800, 2700]],
  ])(
    "court %i answers its clock as read on 19 October, hidden votes, on any chain",
    async (courtId, times) => {
      for (const chain of ["fake", "arbitrum-sepolia-testnet", "arbitrum-one"] as const) {
        const clock = await harness("pay").service.getCourt({ chain, courtId });
        expect(clock).toMatchObject({ courtId, timesPerPeriod: times, hiddenVotes: true });
      }
    },
  );

  it.each([0, 9, 99])("refuses court %i with COURT_NOT_FOUND", async (courtId) => {
    await expectRefusal(
      harness("pay").service.getCourt({ chain: "fake", courtId }),
      "court_get",
      "COURT_NOT_FOUND",
    );
  });

  it("merges the court override onto the clock asked for, and keeps the id asked", async () => {
    const hidden = harness("pay", { court: { hiddenVotes: false, courtId: 5 } });
    expect(await hidden.service.getCourt({ chain: "fake", courtId: 8 })).toMatchObject({
      courtId: 8,
      timesPerPeriod: [900, 2700, 1800, 2700],
      hiddenVotes: false,
    });
    const fast = harness("pay", { court: { timesPerPeriod: [60, 60, 60, 60] } });
    expect(await fast.service.getCourt({ chain: "fake", courtId: 34 })).toMatchObject({
      courtId: 34,
      timesPerPeriod: [60, 60, 60, 60],
      hiddenVotes: true,
    });
    await expectRefusal(
      fast.service.getCourt({ chain: "fake", courtId: 99 }),
      "court_get",
      "COURT_NOT_FOUND",
    );
  });
});

describe("the fake names itself", () => {
  it("is the fake deployment", () => {
    expect(harness("pay").service.deployment).toBe("fake");
  });

  it.each([
    ["an unknown script", { script: "refnd" as FakeScript }],
    ["a fractional firstCoreId", { script: "pay" as const, firstCoreId: 1.5 }],
    ["a negative firstCoreId", { script: "pay" as const, firstCoreId: -1 }],
    ["readsUntilAppeal 0", { script: "pay" as const, readsUntilAppeal: 0 }],
    ["readsUntilAppeal NaN", { script: "pay" as const, readsUntilAppeal: Number.NaN }],
  ])("refuses %s rather than rehearse another outcome", (_, o) => {
    expect(() => new FakeDisputeService(o)).toThrow(/fake Dispute Service/);
  });

  it("lists the three write tools and the two reads", async () => {
    expect(await harness("pay").service.listTools()).toEqual([
      "dispute_create",
      "evidence_pin",
      "evidence_submit",
      "dispute_get",
      "court_get",
    ]);
  });

  it("answers fixed instructions that name the fake and say nothing is sent to Kleros", async () => {
    const text = await harness("pay").service.instructions();
    expect(text).toMatch(/\bfake\b/);
    expect(text).toMatch(/nothing is sent to Kleros/);
    expect(await harness("tie").service.instructions()).toBe(text);
  });
});

describe("calls", () => {
  it("records every call with the tool name, the arguments as received, and the time", async () => {
    const h = harness("pay");
    const tick = () => {
      h.clock.t += 1;
    };
    await h.service.listTools();
    tick();
    await h.service.instructions();
    tick();
    await h.service.getCourt({ chain: "fake", courtId: 8 });
    tick();
    await h.service.pin({ bytes: PDF, extension: "pdf" });
    tick();
    await h.service.createDispute({ aliases: ALIASES });
    tick();
    const submit = {
      coreDisputeId: "1000",
      name: "Job 7",
      description: "The provider delivered.",
      fileUri: "/ipfs/fake-abc",
      fileTypeExtension: "pdf",
    };
    await h.service.submitEvidence(submit);
    tick();
    await h.service.getDispute({ chain: "fake", coreDisputeId: "1000" });
    expect(h.service.calls).toEqual([
      { tool: "tools/list", args: {}, at: T0 },
      { tool: "initialize", args: {}, at: T0 + 1 },
      { tool: "court_get", args: { chain: "fake", courtId: 8 }, at: T0 + 2 },
      { tool: "evidence_pin", args: { extension: "pdf", byteLength: 5 }, at: T0 + 3 },
      { tool: "dispute_create", args: { aliases: ALIASES }, at: T0 + 4 },
      { tool: "evidence_submit", args: submit, at: T0 + 5 },
      { tool: "dispute_get", args: { chain: "fake", coreDisputeId: "1000" }, at: T0 + 6 },
    ]);
  });

  it("records refused calls too, and a pin by its extension and size, never its bytes", async () => {
    const h = harness("insufficient-balance");
    await refusal(h.service.pin({ bytes: new Uint8Array(), extension: "pdf" }));
    await refusal(h.service.createDispute({ aliases: ALIASES }));
    await refusal(h.service.createDispute({} as never));
    await refusal(h.service.getCourt({ chain: "fake", courtId: 99 }));
    await refusal(h.service.submitEvidence({ coreDisputeId: "5", name: "n", description: "d" }));
    await expectNoCase(h.service.getDispute({ chain: "fake", coreDisputeId: "5" }), "fake");
    expect(h.service.calls.map((c) => c.tool)).toEqual([
      "evidence_pin",
      "dispute_create",
      "dispute_create",
      "court_get",
      "evidence_submit",
      "dispute_get",
    ]);
    expect(h.service.calls[0]!.args).toEqual({ extension: "pdf", byteLength: 0 });
    expect(h.service.calls[2]!.args).toEqual({});
  });
});

describe("no network", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Where each script's case ends after ten reads (undefined: no case is ever created). */
  const END: Record<FakeScript, DisputeRead["status"] | undefined> = {
    pay: "Appeal",
    refund: "Appeal",
    tie: "Executed",
    refuse: "Appeal",
    stalled: "Vote",
    "unknown-create": undefined,
    "unknown-submit": "Appeal",
    "write-in-progress-once": "Appeal",
    "insufficient-balance": undefined,
    simulated: undefined,
  };

  it.each(ALL_SCRIPTS)("%s runs end to end with fetch stubbed to throw", async (script) => {
    const fetchStub = vi.fn(() => {
      throw new Error("the fake must not reach the network");
    });
    vi.stubGlobal("fetch", fetchStub);
    const h = harness(script);
    await h.service.listTools();
    await h.service.instructions();
    await h.service.getCourt({ chain: "fake", courtId: 8 });
    const pinned = await h.service.pin({ bytes: PDF, extension: "pdf" });
    if (pinned.status !== "published") throw new Error("unreachable");
    const file = async (): Promise<CreateOutcome | KlerosRefusal> =>
      h.service.createDispute({ aliases: ALIASES }).catch((e: unknown) => {
        if (e instanceof KlerosRefusal) return e;
        throw e;
      });
    let filed = await file();
    if (filed instanceof KlerosRefusal && filed.code === "WRITE_IN_PROGRESS") filed = await file();
    const evidence = {
      name: "Job 7",
      description: "The provider delivered.",
      fileUri: pinned.fileUri,
      fileTypeExtension: "pdf",
    };
    if (filed instanceof KlerosRefusal || filed.status !== "mined") {
      expect(END[script]).toBeUndefined();
      await refusal(h.service.submitEvidence({ ...evidence, coreDisputeId: "1000" }));
      await expectNoCase(h.service.getDispute({ chain: "fake", coreDisputeId: "1000" }), "fake");
    } else {
      await h.service.submitEvidence({ ...evidence, coreDisputeId: filed.coreDisputeId });
      const r = await reads(h, filed.coreDisputeId, 10);
      expect(r[9]!.status).toBe(END[script]);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  /**
   * Every module a source names, with whether the naming is a static `import type` statement
   * (erased at build time, so it loads nothing): `from "m"` (imports and re-exports alike), a
   * side-effect `import "m"`, and `import(...)` or `require(...)`, a non-literal argument shown
   * as `<expr>`. Only a statement that starts at a line and ends in `from "m"` can be type-only.
   */
  function modulesOf(source: string): { module: string; typeOnly: boolean }[] {
    const found: { module: string; typeOnly: boolean }[] = [];
    const statements = [
      ...source.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm),
    ];
    const ends = new Set(statements.map((m) => m.index! + m[0].length));
    for (const m of statements) {
      found.push({ module: m[1]!, typeOnly: /^[ \t]*import\s+type\b/.test(m[0]) });
    }
    for (const m of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
      if (!ends.has(m.index! + m[0].length)) found.push({ module: m[1]!, typeOnly: false });
    }
    for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
      found.push({ module: m[1]!, typeOnly: false });
    }
    for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
      const literal = /^["']([^"']+)["']$/.exec(m[1]!);
      found.push({ module: literal ? literal[1]! : `<${m[1]}>`, typeOnly: false });
    }
    return found;
  }

  /** What the fake may load: a hash and its own module's files. viem only for its types. */
  const MAY_LOAD = ["node:crypto", "./deployments", "./disputeService", "./errors"];
  function forbiddenIn(source: string): string[] {
    return modulesOf(source)
      .filter((n) => !MAY_LOAD.includes(n.module) && !(n.typeOnly && n.module === "viem"))
      .map((n) => n.module);
  }

  it("the module scan finds every way a source can name a module", () => {
    const sample = [
      'import "node:http";',
      'export * from "node:https";',
      'export { request } from "node:net";',
      'import { fetch as f } from "undici";',
      'import type {\n  X,\n} from "viem";',
      'const a = await import("node:dgram");',
      'const b = require("node:tls");',
      "const c = await import(name);",
    ].join("\n");
    expect(
      modulesOf(sample)
        .map((n) => n.module)
        .sort(),
    ).toEqual(
      [
        "<name>",
        "node:dgram",
        "node:http",
        "node:https",
        "node:net",
        "node:tls",
        "undici",
        "viem",
      ].sort(),
    );
    expect(modulesOf(sample).filter((n) => n.typeOnly)).toEqual([
      { module: "viem", typeOnly: true },
    ]);
  });

  it.each([
    ['const v = await import("viem");'],
    ['const v = require("viem");'],
    ['import "viem";'],
    ['import { http } from "viem";'],
    ['import { type Hex, http } from "viem";'],
    ['export { http } from "viem";'],
    ['export type { Hex } from "viem";'],
    ['const t = 1; import type { Hex } from "viem";'],
  ])("the scan refuses viem loaded any other way than a static import type: %s", (planted) => {
    expect(forbiddenIn(planted)).toEqual(["viem"]);
  });

  it.each([
    ['import type { Hex } from "viem";'],
    ['import type {\n  Address,\n  Hex,\n} from "viem";'],
    ['import { createHash } from "node:crypto";'],
    ['import type { KlerosReadChain } from "./deployments";'],
  ])("the scan allows %s", (sample) => {
    expect(forbiddenIn(sample)).toEqual([]);
  });

  it("imports nothing that can reach the network", () => {
    const source = readFileSync(
      new URL("../../../src/adapters/kleros/fakeDisputeService.ts", import.meta.url),
      "utf8",
    );
    expect(modulesOf(source).length).toBeGreaterThan(0);
    expect(forbiddenIn(source)).toEqual([]);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
