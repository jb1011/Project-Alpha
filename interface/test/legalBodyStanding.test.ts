/**
 * The done page's record: the standing in a few words, the facts a stranger cares about, and the
 * statement a counterparty can check.
 *
 * Every word and colour the record shows is decided here, by pure functions: the standing read
 * from the public by-agent answer (only once the order is linked), the yes sentence (only for an
 * `active` standing), the seven facts of the statement a stranger reads, and the links as served.
 * There is no green tone at all: `active` takes the accent, `unknown` is neutral, never a negative,
 * and the sandbox is said out loud.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LegalBodyRecord } from "@/components/legalBody/LegalBodyRecord";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import {
  BINDING_STATES,
  type BindingState,
  type LegalBodyByAgent,
  type LegalBodyStatementJson,
  type SignedStatementJson,
  type Standing,
  STANDINGS,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  counterpartyCheck,
  legalBodyRecordView,
  linkableUrl,
  publicReadAllowed,
  standingPresentation,
  statementFactsForStranger,
  type StandingPresentation,
} from "@/lib/legalBody/standing";

const D = LEGAL_BODY_COPY.done;
const YES =
  "a registered legal body stands behind this agent, and Novi states its standing as active";

type Environment = "sandbox" | "production";
const ENVIRONMENTS: Environment[] = ["sandbox", "production"];
type Reason = Extract<PublicRead<LegalBodyByAgent>, { kind: "could_not_check" }>["reason"];
const REASONS: Reason[] = [
  "rate_limited",
  "unavailable",
  "validation_error",
  "network",
  "timeout",
  "malformed",
];

/** The three public addresses and anvil's published accounts: every address field distinct, so a
 *  value that leaks into a row is found by its value. */
const ANVIL_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ANVIL_2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

/** The statement's message in its JSON form: all 33 fields, as the public docs show them. */
const MESSAGE: LegalBodyStatementJson = {
  chainId: "5042002",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  legalBody: "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE",
  agentId: "897126",
  agentWallet: ANVIL_1,
  identityOwnerAtCreation: ANVIL_0,
  bindingState: "linked",
  identityOwnerIsContract: false,
  agentWalletIsContract: true,
  standing: "active",
  attestationState: "active",
  jurisdiction: "WY",
  entityType: "LLC",
  legalName: "Example Test Holdings LLC",
  filingNumber: "TEST-0001",
  source: "customer",
  environment: "sandbox",
  controlVerified: true,
  existenceCheckedAt: "1790780400",
  filedAt: "2026-03-10",
  einIssued: false,
  filingStatus: "not_yet_due",
  lastFiledPeriod: "0",
  lastFiledAt: "",
  lastFiledConfirmedBy: "",
  nextDue: "2027-03-01",
  oaManifestHash: `0x${"ab".repeat(32)}`,
  oaManifestVersion: "1",
  guardianHumanVerified: true,
  observedAtBlock: "31415926",
  issuedAt: "1791471600",
  expiresAt: "1791471900",
};

/** A URL no bundle could build: the record shows the answer's own link, never one composed. */
const STATEMENT_URL = "https://statements.example.test/v9/legal-bodies/by-agent/897126?from=answer";
const TRANSPARENCY_URL = "https://example.test/transparency";

type StatedAnswer = Extract<LegalBodyByAgent, { legalBody: true; statement: SignedStatementJson }>;

function stated(standing: Standing, over: Partial<LegalBodyStatementJson> = {}): StatedAnswer {
  return {
    agentId: "897126",
    legalBody: true,
    standing,
    publicId: "lb_test",
    network: "testnet",
    links: { transparency: TRANSPARENCY_URL, statement: STATEMENT_URL },
    checkedAt: "2026-10-15T12:00:00.000Z",
    statement: {
      domain: { name: "Novi Corpus Attestation", version: "2", chainId: 5042002 },
      primaryType: "LegalBodyStatement",
      message: { ...MESSAGE, standing, ...over },
      attestor: ANVIL_2,
      signature: `0x${"cd".repeat(65)}`,
    },
  };
}

/** A body whose statement could not be made just now: the API serves it with `unknown` only. The
 *  other three standings are cast in, to show a standing without a statement is never taken. */
function unsigned(standing: Standing = "unknown"): LegalBodyByAgent {
  return {
    agentId: "897126",
    legalBody: true,
    standing,
    publicId: null,
    network: "testnet",
    links: { transparency: TRANSPARENCY_URL },
    checkedAt: "2026-10-15T12:00:00.000Z",
    statement: null,
  } as LegalBodyByAgent;
}

const NONE: LegalBodyByAgent = {
  agentId: "897126",
  legalBody: false,
  standing: null,
  checkedAt: "2026-10-15T12:00:00.000Z",
};

const answer = (body: LegalBodyByAgent): PublicRead<LegalBodyByAgent> => ({ kind: "answer", body });
const failed = (reason: Reason): PublicRead<LegalBodyByAgent> => ({ kind: "could_not_check", reason });

type Input = Parameters<typeof standingPresentation>[0];
const input = (over: Partial<Input> = {}): Input => ({
  read: answer(stated("active")),
  orderState: "linked",
  environment: "sandbox",
  paymentRequired: false,
  ...over,
});

const NOT_LINKED = BINDING_STATES.filter((s) => s !== "linked");
const BEFORE_POINTER: BindingState[] = ["draft", "reserved", "deployed"];

/** Every presentation the table reaches, for the tone invariants. */
const SEEN: StandingPresentation[] = [];
const present = (p: Input) => {
  const out = standingPresentation(p);
  SEEN.push(out);
  return out;
};

const sandboxLine = (environment: Environment) => (environment === "sandbox" ? [D.sandboxStatement] : []);

describe("standingPresentation: a signed statement, the four standings", () => {
  const rows: [Standing, Environment, boolean][] = STANDINGS.flatMap((standing) =>
    ENVIRONMENTS.flatMap((environment) =>
      [false, true].map((paymentRequired): [Standing, Environment, boolean] => [
        standing,
        environment,
        paymentRequired,
      ]),
    ),
  );

  test("the table covers the four standings on both environments, charging or not", () => {
    expect(rows).toHaveLength(16);
  });

  test.each(rows)("%s on %s, paymentRequired %s", (standing, environment, paymentRequired) => {
    const over: Partial<LegalBodyStatementJson> =
      standing === "inactive"
        ? { environment, attestationState: "revoked", bindingState: "broken" }
        : { environment };
    const out = present(input({ read: answer(stated(standing, over)), environment, paymentRequired }));
    expect(out.label).toBe(standing);
    switch (standing) {
      case "active":
        expect(out.tone).toBe("accent");
        expect(out.sentences).toEqual(sandboxLine(environment));
        break;
      case "pending":
        expect(out.tone).toBe("amber");
        expect(out.sentences).toEqual([
          paymentRequired ? D.notYetPaid : D.checkNotStanding,
          ...sandboxLine(environment),
        ]);
        break;
      case "unknown":
        expect(out.tone).toBe("neutral");
        expect(out.sentences).toEqual([D.filingFactsMissing, ...sandboxLine(environment)]);
        break;
      case "inactive":
        expect(out.tone).toBe("amber");
        expect(out.sentences).toEqual([
          fillCopy(D.inactiveWords, { attestationState: "revoked", bindingState: "broken" }),
          ...sandboxLine(environment),
        ]);
        break;
    }
  });

  test("inactive says the statement's own words, whatever they are", () => {
    const out = present(
      input({
        read: answer(
          stated("inactive", { environment: "production", attestationState: "active", bindingState: "linked" }),
        ),
        environment: "production",
      }),
    );
    expect(out.sentences).toEqual([
      fillCopy(D.inactiveWords, { attestationState: "active", bindingState: "linked" }),
    ]);
    expect(out.sentences[0]).toContain("attestationState active");
    expect(out.sentences[0]).toContain("bindingState linked");
  });

  test("a statement that says sandbox is said out loud on any deployment", () => {
    const out = present(input({ environment: "production", read: answer(stated("active")) }));
    expect(out.sentences).toEqual([D.sandboxStatement]);
  });

  test("a standing this build does not know reads as unknown, in the neutral tone", () => {
    const strange = stated("active", { environment: "production" });
    const body = { ...strange, standing: "suspended" } as unknown as LegalBodyByAgent;
    const out = present(input({ read: answer(body), environment: "production" }));
    expect(out.label).toBe("unknown");
    expect(out.tone).toBe("neutral");
    expect(out.sentences).toEqual([D.standingNotKnown]);
  });
});

describe("standingPresentation: a body with no statement", () => {
  const rows: [Standing, Environment, boolean][] = STANDINGS.flatMap((standing) =>
    ENVIRONMENTS.flatMap((environment) =>
      [false, true].map((paymentRequired): [Standing, Environment, boolean] => [
        standing,
        environment,
        paymentRequired,
      ]),
    ),
  );

  test.each(rows)(
    "standing %s without a statement on %s (paymentRequired %s) is unknown: the chain could not be read",
    (standing, environment, paymentRequired) => {
      const out = present(input({ read: answer(unsigned(standing)), environment, paymentRequired }));
      expect(out.label).toBe("unknown");
      expect(out.tone).toBe("neutral");
      expect(out.sentences).toEqual([D.chainUnread, ...sandboxLine(environment)]);
    },
  );
});

describe("standingPresentation: no answer, or no record yet", () => {
  test.each(REASONS)("could not check (%s): neutral, with its reason, never a negative", (reason) => {
    for (const environment of ENVIRONMENTS) {
      const out = present(input({ read: failed(reason), environment }));
      expect(out.label).toBe("could not check");
      expect(out.tone).toBe("neutral");
      expect(out.sentences).toEqual([D.couldNotCheckReasons[reason], D.saysNothing]);
    }
  });

  test("each reason has its own sentence", () => {
    const sentences = REASONS.map((r) => D.couldNotCheckReasons[r]);
    expect(new Set(sentences).size).toBe(REASONS.length);
    expect(Object.keys(D.couldNotCheckReasons).sort()).toEqual([...REASONS].sort());
  });

  test("no legal body on a linked order: not yet visible, the record appears within a minute", () => {
    for (const environment of ENVIRONMENTS) {
      const out = present(input({ read: answer(NONE), environment }));
      expect(out.label).toBe("not yet visible");
      expect(out.tone).toBe("neutral");
      expect(out.sentences).toEqual([D.notYetVisible]);
      expect(D.notYetVisible).toBe("the record appears within a minute of the pointer being seen");
    }
  });

  test("a linked order not read yet is being read", () => {
    const out = present(input({ read: null }));
    expect(out.label).toBe("not yet visible");
    expect(out.tone).toBe("neutral");
    expect(out.sentences).toEqual([D.reading]);
  });

  test.each(NOT_LINKED)("an order %s is never read publicly: whatever read is held is ignored", (orderState) => {
    for (const read of [answer(stated("active")), answer(NONE), failed("network"), null]) {
      const out = present(input({ orderState, read }));
      expect(out.label).toBe("not yet visible");
      expect(out.tone).toBe("neutral");
      expect(out.sentences).toEqual([BEFORE_POINTER.includes(orderState) ? D.notYetVisible : D.notLinked]);
    }
  });
});

describe("the tones", () => {
  test("accent only for active; neutral for unknown, could not check and not yet visible; amber for pending and inactive", () => {
    // Every presentation the tables above produced.
    expect(SEEN.length).toBeGreaterThan(60);
    const labels = new Set(SEEN.map((p) => p.label));
    expect([...labels].sort()).toEqual(
      ["active", "could not check", "inactive", "not yet visible", "pending", "unknown"].sort(),
    );
    for (const p of SEEN) {
      expect(p.tone === "accent").toBe(p.label === "active");
      if (["unknown", "could not check", "not yet visible"].includes(p.label)) expect(p.tone).toBe("neutral");
      if (["pending", "inactive"].includes(p.label)) expect(p.tone).toBe("amber");
    }
  });

  test("the tone type has no green", () => {
    const tones: StandingPresentation["tone"][] = ["accent", "amber", "neutral"];
    // @ts-expect-error there is no green tone
    const green: StandingPresentation["tone"] = "green";
    expect(tones).not.toContain(green);
  });

  test("no presentation carries the yes sentence: it belongs to the counterparty's box", () => {
    for (const p of SEEN) for (const s of p.sentences) expect(s).not.toContain(YES);
  });
});

describe("counterpartyCheck", () => {
  test("active: the yes sentence, word for word, and the exact URL as served", () => {
    const out = counterpartyCheck(stated("active", { environment: "production" }));
    expect(out.yesSentence).toBe(YES);
    expect(out.url).toBe(STATEMENT_URL);
    expect(out.environment).toBe("production");
    expect(out.sayInstead).toBeNull();
  });

  test("active on a sandbox answer: the yes sentence, the sandbox word, and that it is a test", () => {
    const out = counterpartyCheck(stated("active"));
    expect(out.yesSentence).toBe(YES);
    expect(out.environment).toBe("sandbox");
    expect(out.sayInstead).toBe(D.sayWithSandbox);
    expect(out.sayInstead).toContain("sandbox");
  });

  test.each(["pending", "unknown", "inactive"] as const)(
    "%s: never the yes sentence; the standing as it is",
    (standing) => {
      for (const environment of ENVIRONMENTS) {
        const out = counterpartyCheck(stated(standing, { environment }));
        expect(out.yesSentence).toBe("");
        expect(out.url).toBe(STATEMENT_URL);
        expect(out.environment).toBe(environment);
        const asItIs = fillCopy(D.sayAsItIs, { standing });
        expect(out.sayInstead).toBe(environment === "sandbox" ? `${asItIs} ${D.sayTest}` : asItIs);
        expect(out.sayInstead).toContain(standing);
        expect(out.sayInstead).not.toContain(YES);
      }
    },
  );

  test("the environment is the statement's own word, not the network's", () => {
    const answerOnTestnet = stated("active", { environment: "production" });
    expect(answerOnTestnet.network).toBe("testnet");
    expect(counterpartyCheck(answerOnTestnet).environment).toBe("production");
  });

  test("a standing this build does not know is never a yes", () => {
    const body = { ...stated("active"), standing: "suspended" } as unknown as StatedAnswer;
    const out = counterpartyCheck(body);
    expect(out.yesSentence).toBe("");
    expect(out.sayInstead).toContain("suspended");
  });
});

describe("statementFactsForStranger", () => {
  const ROWS = [
    [D.facts.identity, MESSAGE.agentId],
    [D.facts.body, MESSAGE.legalBody],
    [D.facts.binding, MESSAGE.bindingState],
    [D.facts.attestation, MESSAGE.attestationState],
    [D.facts.filingStatus, MESSAGE.filingStatus],
    [D.facts.nextDue, MESSAGE.nextDue],
    [D.facts.environment, MESSAGE.environment],
  ];

  test("the golden statement holds 33 fields", () => {
    expect(Object.keys(MESSAGE)).toHaveLength(33);
  });

  test("exactly the seven rows, in order: identity, body, binding, attestation, filing status, next due, environment", () => {
    expect(statementFactsForStranger(MESSAGE).map((r) => [r.label, r.value])).toEqual(ROWS);
  });

  test("none of the fields kept for the tenant's own page, nor the envelope's attestor", () => {
    const rows = statementFactsForStranger(MESSAGE);
    const text = rows.map((r) => `${r.label} ${r.value}`.toLowerCase()).join("\n");
    const excluded = [
      MESSAGE.identityOwnerAtCreation,
      MESSAGE.agentWallet,
      MESSAGE.identityRegistry,
      MESSAGE.factory,
      MESSAGE.oaManifestHash,
      MESSAGE.observedAtBlock,
      MESSAGE.issuedAt,
      MESSAGE.expiresAt,
      ANVIL_2,
    ];
    for (const value of excluded) expect(text).not.toContain(value.toLowerCase());
    // The two contract flags: neither a label about them nor their boolean value.
    for (const r of rows) {
      expect(r.label.toLowerCase()).not.toContain("contract");
      expect(["true", "false"]).not.toContain(r.value);
    }
    for (const name of [
      "identityOwnerAtCreation",
      "agentWallet",
      "identityRegistry",
      "factory",
      "oaManifestHash",
      "identityOwnerIsContract",
      "agentWalletIsContract",
      "observedAtBlock",
      "issuedAt",
      "expiresAt",
      "attestor",
    ])
      expect(text).not.toContain(name.toLowerCase());
  });

  test("a next due date the statement leaves empty reads as not recorded", () => {
    const rows = statementFactsForStranger({ ...MESSAGE, nextDue: "" });
    expect(rows[5]).toEqual({ label: D.facts.nextDue, value: D.notRecorded });
  });
});

describe("publicReadAllowed: no public link before the order is linked", () => {
  test("a linked order with its identity is read", () => {
    expect(publicReadAllowed({ state: "linked", agentId: "897126" })).toBe(true);
  });

  test.each(NOT_LINKED)("an order %s is not", (state) => {
    expect(publicReadAllowed({ state, agentId: "897126" })).toBe(false);
  });

  test("nor a linked order with no identity, nor no order at all", () => {
    expect(publicReadAllowed({ state: "linked", agentId: null })).toBe(false);
    expect(publicReadAllowed(null)).toBe(false);
  });
});

describe("linkableUrl: a served URL is a link only over http or https", () => {
  test.each([
    ["https://example.test/legal-bodies/by-agent/1", "https://example.test/legal-bodies/by-agent/1"],
    ["http://localhost:8789/legal-bodies/by-agent/1", "http://localhost:8789/legal-bodies/by-agent/1"],
    ["javascript:alert(1)", null],
    ["data:text/html,hi", null],
    ["not a url", null],
    ["", null],
  ])("%j", (url, expected) => {
    expect(linkableUrl(url)).toBe(expected);
  });
});

describe("legalBodyRecordView", () => {
  test("a signed statement: the standing, the seven facts, both links and the check box", () => {
    const view = legalBodyRecordView(input());
    expect(view.standing.label).toBe("active");
    expect(view.retry).toBe(false);
    expect(view.facts).toEqual(statementFactsForStranger(stated("active").statement.message));
    expect(view.links).toEqual({
      statement: { text: STATEMENT_URL, href: STATEMENT_URL },
      transparency: { text: TRANSPARENCY_URL, href: TRANSPARENCY_URL },
    });
    expect(view.check).toEqual({
      ...counterpartyCheck(stated("active")),
      href: STATEMENT_URL,
      environmentTone: "amber",
    });
  });

  test("the environment word is amber on sandbox and neutral on production", () => {
    const production = legalBodyRecordView(
      input({ environment: "production", read: answer(stated("active", { environment: "production" })) }),
    );
    expect(production.check?.environment).toBe("production");
    expect(production.check?.environmentTone).toBe("neutral");
  });

  test("a URL that is not http or https is shown as text and never linked", () => {
    const body = stated("active");
    body.links = { ...body.links, statement: "javascript:alert(1)" };
    const view = legalBodyRecordView(input({ read: answer(body) }));
    expect(view.links?.statement).toEqual({ text: "javascript:alert(1)", href: null });
    expect(view.check?.url).toBe("javascript:alert(1)");
    expect(view.check?.href).toBeNull();
  });

  test.each(REASONS)("could not check (%s): Try again, and nothing else to show", (reason) => {
    const view = legalBodyRecordView(input({ read: failed(reason) }));
    expect(view.retry).toBe(true);
    expect(view.facts).toBeNull();
    expect(view.links).toBeNull();
    expect(view.check).toBeNull();
  });

  test("not yet visible after the link: Try again", () => {
    const view = legalBodyRecordView(input({ read: answer(NONE) }));
    expect(view.retry).toBe(true);
    expect(view.check).toBeNull();
  });

  test("no statement just now: Try again, the transparency link, no check box", () => {
    const view = legalBodyRecordView(input({ read: answer(unsigned()) }));
    expect(view.retry).toBe(true);
    expect(view.facts).toBeNull();
    expect(view.check).toBeNull();
    expect(view.links).toEqual({
      statement: null,
      transparency: { text: TRANSPARENCY_URL, href: TRANSPARENCY_URL },
    });
  });

  test("still reading: nothing to retry yet", () => {
    const view = legalBodyRecordView(input({ read: null }));
    expect(view.retry).toBe(false);
    expect(view.check).toBeNull();
  });

  test.each(NOT_LINKED)("an order %s shows no public fact, even with a held read", (orderState) => {
    const view = legalBodyRecordView(input({ orderState, read: answer(stated("active")) }));
    expect(view.retry).toBe(false);
    expect(view.facts).toBeNull();
    expect(view.links).toBeNull();
    expect(view.check).toBeNull();
  });
});

describe("LegalBodyRecord, rendered", () => {
  const render = (over: Partial<Input> = {}) =>
    renderToString(
      createElement(LegalBodyRecord, { ...input(over), onRetry: () => {}, retrying: false }),
    );

  test("an active sandbox body: the URL as text and as a link, the sandbox word and the yes sentence", () => {
    const html = render();
    expect(html).toContain(`href="${STATEMENT_URL.replace(/&/g, "&amp;")}"`);
    expect(html.split(STATEMENT_URL.replace(/&/g, "&amp;")).length - 1).toBeGreaterThanOrEqual(3);
    expect(html).toContain(`href="${TRANSPARENCY_URL}"`);
    expect(html).toContain(YES);
    expect(html).toContain("sandbox");
    expect(html).toContain(D.sayWithSandbox);
    expect(html).toContain(D.checkHeading);
    for (const label of Object.values(D.facts)) expect(html).toContain(label);
  });

  test("never green", () => {
    for (const html of [
      render(),
      render({ read: answer(stated("pending")) }),
      render({ read: answer(stated("inactive")) }),
      render({ read: answer(stated("unknown")) }),
      render({ read: failed("timeout") }),
      render({ read: answer(NONE) }),
    ]) {
      expect(html).not.toMatch(/green|emerald|#28c840/i);
    }
  });

  test("a standing that is not active never shows the yes sentence", () => {
    for (const standing of ["pending", "unknown", "inactive"] as const)
      expect(render({ read: answer(stated(standing)) })).not.toContain(YES);
  });

  test("could not check: the words and Try again", () => {
    const html = render({ read: failed("rate_limited") });
    expect(html).toContain("could not check");
    expect(html).toContain(D.couldNotCheckReasons.rate_limited);
    expect(html).toContain(D.retry);
    expect(html).not.toContain(D.checkHeading);
  });
});

describe("the done page's reads and words", () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");

  test("the public read is enabled only through publicReadAllowed", () => {
    const code = source("DoneStep.tsx");
    expect(code).toMatch(/useLegalBodyByAgentQuery\([^)]*publicReadAllowed\(/);
    expect(code.split("useLegalBodyByAgentQuery(").length - 1).toBe(1);
  });

  test.each(["DoneStep.tsx", "LegalBodyRecord.tsx"])("%s writes nothing and reaches no wallet", (name) => {
    const code = source(name);
    for (const reach of [
      "useMutation",
      "Mutation(",
      "useAllowedWrite",
      "useWriteContract",
      "signTypedData",
      "useEffect",
      "apiKey",
    ])
      expect(code).not.toContain(reach);
  });

  test("the two ways on are the copy's, wired to the shell's two intents", () => {
    const code = source("DoneStep.tsx");
    expect(code).toContain('startAnother("new_order")');
    expect(code).toContain('startAnother("new_company")');
    expect(D.anotherAgent).toBe("Get a legal body for another agent");
    expect(D.anotherCompany).toBe("Declare another company");
  });
});
