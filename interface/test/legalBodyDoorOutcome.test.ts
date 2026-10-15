/**
 * What the screen does next after each door's answer, as tables. A refusal's sentence is always
 * the one the door served, never a local copy: the fixtures below carry the backend's sentences,
 * and one carries a sentence no table here knows, to show it passes through untouched.
 */
import { describe, expect, test } from "vitest";
import type { LegalBodyOrderView, LinkSubmitAnswer } from "@/lib/api/types";
import {
  GAS_SEED_CODES,
  gasSeedOutcome,
  linkDoorRoute,
  linkSubmitOutcome,
  type DoorRoute,
} from "@/lib/legalBody/doorOutcome";

/** One of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
/** The public testnet factory, and an invented body. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const BODY = "0x00000000000000000000000000000000000b0d1e" as const;
const CHAIN = 5042002;
const NOW_S = Date.parse("2026-10-12T12:00:00Z") / 1000;

const view = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "ord_1",
  publicId: "pub_1",
  companyId: "co_a",
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"ab".repeat(32)}`, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: "2026-10-12T11:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

const RESERVED = view({
  state: "reserved",
  agentId: "42",
  identityOwner: GUARDIAN,
  bodyAddress: BODY,
  linkDeadline: NOW_S + 3_600,
});
const DEPLOYED = view({
  ...RESERVED,
  state: "deployed",
  createTxHash: `0x${"cd".repeat(32)}`,
  deployedAt: NOW_S + 5,
});
const LAPSED = view({
  ...RESERVED,
  state: "lapsed",
  lapseReason: "refused_before_send",
});

/** The backend's sentences for the codes below, as served. */
const SENTENCE = {
  bad_signature: "The signature is not the identity owner's signature of this link message.",
  unsupported_signer:
    "There is no usable signature of the identity owner: sign with its key or smart account. If the account has no code, this wallet is not deployed yet: send any transaction from it, then sign again.",
  agent_in_flight:
    "Another order for this identity, signed by its current owner, is on its way: it settles within seconds, or lapses at its deadline.",
  deadline_out_of_window:
    "The link's deadline has passed, is too close to use, or is further ahead than the factory accepts: a link message with a new deadline is needed.",
  create_would_revert:
    "The factory would refuse to create a legal body from this link, and nothing was sent.",
} as const;

const refusal = (
  code: string,
  message: string,
  order: LegalBodyOrderView,
  detail: Record<string, string> = {},
): LinkSubmitAnswer => ({ status: 422, body: { code, message, detail, order } });

describe("linkDoorRoute", () => {
  /** Every code of the table, with its route on the browser branch and on the paste branch. */
  const TABLE: readonly (readonly [string, DoorRoute, DoorRoute])[] = [
    ["order_expired", "agreement", "agreement"],
    ["order_closed", "agreement", "agreement"],
    ["agreement_outdated", "agreement", "agreement"],
    ["order_revoked", "agreement", "agreement"],
    ["other_deployment", "agreement", "agreement"],
    ["company_not_eligible", "company", "company"],
    ["legal_body_attempts", "wait", "wait"],
    ["rate_limited", "wait", "wait"],
    ["busy", "wait", "wait"],
    ["chain_unavailable", "retry", "retry"],
    ["internal_error", "retry", "retry"],
    ["agreement_unreadable", "retry", "retry"],
    ["link_already_used", "new_message", "new_message"],
    ["identity_not_found", "identity", "identity"],
    ["malformed_link", "bug", "pasted_not_hex"],
    ["malformed_signature", "bug", "pasted_not_hex"],
  ];

  test.each(TABLE)("%s routes to %s in the browser and %s on the paste branch", (code, browser, paste) => {
    expect(linkDoorRoute(code, "browser")).toBe(browser);
    expect(linkDoorRoute(code, "paste")).toBe(paste);
  });

  test("a code the table does not name shows the door's own sentence, on both branches", () => {
    expect(linkDoorRoute("guardian_mismatch_v9", "browser")).toBe("sentence");
    expect(linkDoorRoute("guardian_mismatch_v9", "paste")).toBe("sentence");
  });

  test("a name every object inherits is not a code of the table", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty", ""]) {
      expect(linkDoorRoute(code, "browser")).toBe("sentence");
      expect(linkDoorRoute(code, "paste")).toBe("sentence");
    }
  });
});

describe("linkSubmitOutcome", () => {
  test("a 200 re-derives from the order as served", () => {
    expect(linkSubmitOutcome({ status: 200, body: DEPLOYED })).toStrictEqual({
      next: "rederive",
      order: DEPLOYED,
    });
  });

  test("a 202 re-derives from the order as served, still reserved", () => {
    expect(linkSubmitOutcome({ status: 202, body: RESERVED })).toStrictEqual({
      next: "rederive",
      order: RESERVED,
    });
  });

  test.each(["bad_signature", "unsupported_signer"] as const)(
    "a 422 %s keeps the draft and shows the served sentence",
    (code) => {
      const order = view();
      expect(linkSubmitOutcome(refusal(code, SENTENCE[code], order))).toStrictEqual({
        next: "refused",
        order,
        code,
        sentence: SENTENCE[code],
        lapsed: false,
      });
    },
  );

  test("a 422 agent_in_flight, refused before the reserve, keeps the draft: signing again is the retry", () => {
    const order = view();
    expect(
      linkSubmitOutcome(refusal("agent_in_flight", SENTENCE.agent_in_flight, order, {})),
    ).toStrictEqual({
      next: "refused",
      order,
      code: "agent_in_flight",
      sentence: SENTENCE.agent_in_flight,
      lapsed: false,
    });
  });

  test("a 422 deadline_out_of_window keeps the draft and shows the served sentence", () => {
    const order = view();
    expect(
      linkSubmitOutcome(refusal("deadline_out_of_window", SENTENCE.deadline_out_of_window, order)),
    ).toStrictEqual({
      next: "refused",
      order,
      code: "deadline_out_of_window",
      sentence: SENTENCE.deadline_out_of_window,
      lapsed: false,
    });
  });

  test("a 422 whose order is lapsed says so", () => {
    const answer = refusal("create_would_revert", SENTENCE.create_would_revert, LAPSED, {
      errorName: "BadDeadline",
    });
    expect(linkSubmitOutcome(answer)).toStrictEqual({
      next: "refused",
      order: LAPSED,
      code: "create_would_revert",
      sentence: SENTENCE.create_would_revert,
      lapsed: true,
    });
  });

  test("the sentence is the one served, for a code this build does not know", () => {
    const served = "A sentence this build has never seen, served as is.";
    const outcome = linkSubmitOutcome(refusal("a_new_code", served, view()));
    expect(outcome).toStrictEqual({
      next: "refused",
      order: view(),
      code: "a_new_code",
      sentence: served,
      lapsed: false,
    });
  });
});

describe("gasSeedOutcome", () => {
  test("the eight codes the gas seed door answers", () => {
    expect([...GAS_SEED_CODES]).toStrictEqual([
      "gas_seed_disabled",
      "gas_seed_used",
      "owner_pays_own_gas",
      "not_needed",
      "gas_seed_unconfirmed",
      "busy",
      "order_closed",
      "rate_limited",
    ]);
  });

  const TABLE: readonly (readonly [(typeof GAS_SEED_CODES)[number], boolean])[] = [
    ["gas_seed_disabled", true],
    ["gas_seed_used", true],
    ["owner_pays_own_gas", true],
    ["not_needed", true],
    ["gas_seed_unconfirmed", true],
    ["busy", false],
    ["order_closed", false],
    ["rate_limited", false],
  ];

  test("the table names each of the eight codes once", () => {
    expect(TABLE.map(([code]) => code)).toStrictEqual([...GAS_SEED_CODES]);
  });

  test.each(TABLE)("%s is known, and final: %s", (code, final) => {
    expect(gasSeedOutcome(code)).toStrictEqual({ known: true, final });
  });

  test("an unknown code is neither known nor final", () => {
    expect(gasSeedOutcome("gas_seed_v2")).toStrictEqual({ known: false, final: false });
    for (const code of ["constructor", "toString", "__proto__", ""]) {
      expect(gasSeedOutcome(code)).toStrictEqual({ known: false, final: false });
    }
  });
});
