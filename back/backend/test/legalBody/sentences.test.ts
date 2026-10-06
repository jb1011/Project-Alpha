/**
 * The fixed sentences of the legal-body flow: every code a door of the flow or the link check can
 * answer has one, and each one is plain text a customer can read as it is.
 *
 * The codes are collected from the code itself: every `refusal("…")` and `sentenceFor("…")` call,
 * and every `code: "…"` a refusal is returned with, in the modules that answer them and in the
 * doors' route file; and every member of `LinkRefusalCode`, in a list the compiler holds to the
 * type. A code added to the flow is walked without an edit here. The codes the flow answers by
 * name are listed only to prove that the walk finds them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Address } from "viem";
import { describe, expect, test } from "vitest";
import { ACCEPTED_CREDENTIALS } from "../../src/adapters/worldid/guardianGate";
import { readJson } from "../../src/api/errors";
import { type WorldIdDeps, assertRealHuman } from "../../src/api/routes/worldId";
import { ApiError } from "../../src/errors";
import type { LinkRefusalCode } from "../../src/legalBody/checkLink";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import type { GuardianVerification } from "../../src/persistence/worldStore";
import { ANVIL_ACCOUNT_2 } from "../helpers/customerCompanyFixtures";

const SRC = join(import.meta.dirname, "..", "..", "src");

/** The modules that answer a code of the flow, relative to `src`: the domain modules, the link
 *  check and the doors' route file. */
const ANSWERING_MODULES = [
  "legalBody/orders.ts",
  "legalBody/linkDoor.ts",
  "legalBody/create.ts",
  "legalBody/resolver.ts",
  "legalBody/binding.ts",
  "legalBody/checkLink.ts",
  "api/routes/legalBodyOrders.ts",
];

/** Every member of `LinkRefusalCode`: a member missing here, or a key that is not one, does not
 *  compile. */
const LINK_REFUSAL_CODES: Record<LinkRefusalCode, true> = {
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

/** The codes the flow answers by name, beside the link check's: the walk must find each one. */
const NAMED_CODES = [
  "agent_in_flight",
  "legal_body_cap",
  "legal_body_orders",
  "legal_body_attempts",
  "busy",
  "rate_limited",
  "company_not_eligible",
  "order_expired",
  "order_revoked",
  "order_closed",
  "order_lapsed",
  "link_already_used",
  "agreement_outdated",
  "agreement_unreadable",
  "other_deployment",
  "chain_unavailable",
  "internal_error",
  "legal_text_not_approved",
  "malformed_link",
  "identity_not_found",
];

const CODE = "([a-z][a-z0-9_]*)";
/** How a module answers a code: a refusal, a sentence, or a refusal it returns. */
const ANSWERED = [
  new RegExp(`\\brefusal\\(\\s*"${CODE}"`, "g"),
  new RegExp(`\\bsentenceFor\\(\\s*"${CODE}"`, "g"),
  new RegExp(`\\bcode:\\s*"${CODE}"`, "g"),
  new RegExp(`\\.code\\s*\\?\\?\\s*"${CODE}"`, "g"),
];

const source = (module: string) => readFileSync(join(SRC, module), "utf8");

function answeredIn(module: string): string[] {
  const text = source(module);
  return ANSWERED.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[1] as string));
}

/** Every code collected from the answering modules, and every member of `LinkRefusalCode`. */
function answeredCodes(): Set<string> {
  return new Set([...ANSWERING_MODULES.flatMap(answeredIn), ...Object.keys(LINK_REFUSAL_CODES)]);
}

/** Every `.ts` file under `dir`, relative to `src`. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return name.endsWith(".ts") ? [relative(SRC, path).split("\\").join("/")] : [];
  });
}

/** The rules every fixed sentence keeps, one failure message per broken rule. */
function brokenRules(text: string): string[] {
  const broken: string[] = [];
  if (text.length >= 200) broken.push(`${text.length} characters`);
  if (/0x/i.test(text)) broken.push("a 0x");
  if (/https?:|:\/\/|www\./i.test(text)) broken.push("a URL");
  if (/[{}]/.test(text)) broken.push("a brace");
  return broken;
}

/** The words of a sentence that says the request changed nothing. */
const NOTHING_CHANGED = /nothing (?:was |has )?changed/i;

describe("a sentence for every code", () => {
  test("every code a door or the link check can answer has one sentence: under 200 characters, with no 0x, no URL and no brace", () => {
    const codes = answeredCodes();
    for (const code of codes) {
      expect(Object.hasOwn(LEGAL_BODY_SENTENCES, code), `${code} has a sentence`).toBe(true);
      const sentence = LEGAL_BODY_SENTENCES[code] as string;
      expect(sentence, code).toMatch(/^[A-Z].*\.$/);
      expect(brokenRules(sentence), code).toEqual([]);
    }
  });

  test("the walk finds every code the flow answers by name in the modules themselves", () => {
    const fromModules = new Set(ANSWERING_MODULES.flatMap(answeredIn));
    for (const code of NAMED_CODES) expect(fromModules.has(code), code).toBe(true);
  });

  test("every module that answers with the table is walked, and none builds a refusal of its own", () => {
    const importers = sourcesUnder(SRC).filter((module) =>
      /from\s+"(?:\.\/|(?:\.\.\/)+legalBody\/)sentences"/.test(source(module)),
    );
    // If this is ever empty the guard has stopped guarding anything.
    expect(importers.length).toBeGreaterThan(0);
    for (const module of importers) expect(ANSWERING_MODULES, module).toContain(module);
    for (const module of ANSWERING_MODULES) {
      const text = source(module);
      expect(text, `${module} builds an ApiError`).not.toMatch(/new\s+ApiError\s*\(/);
      // Every refusal names its code as written, so the walk above sees it.
      const calls = text.match(/\brefusal\(/g)?.length ?? 0;
      const named = text.match(new RegExp(`\\brefusal\\(\\s*"${CODE}"`, "g"))?.length ?? 0;
      expect(named, module).toBe(calls);
    }
  });
});

describe("what the sentences say", () => {
  test("unsupported_signer covers a signature the factory cannot use, and a wallet not deployed yet", () => {
    const sentence = LEGAL_BODY_SENTENCES.unsupported_signer;
    expect(sentence).toMatch(/no usable signature/i);
    expect(sentence).toContain(
      "this wallet is not deployed yet: send any transaction from it, then sign again",
    );
  });

  test("order_lapsed says the order is over and a new order is needed", () => {
    const sentence = LEGAL_BODY_SENTENCES.order_lapsed;
    expect(sentence).toMatch(/lapsed/);
    expect(sentence).toMatch(/no longer be linked/);
    expect(sentence).toMatch(/new order/);
  });

  test("only codes never answered once anything changed say that nothing was changed", () => {
    const sayNothingChanged = Object.keys(LEGAL_BODY_SENTENCES)
      .filter((code) => NOTHING_CHANGED.test(LEGAL_BODY_SENTENCES[code] as string))
      .sort();
    // Each of these is answered only before any write, or by a pass that moved no state.
    expect(sayNothingChanged).toEqual(["chain_unavailable", "order_closed"]);
    // A refusal of the link can follow the reserve, with the order lapsed; so can an error the
    // door did not choose.
    for (const code of [...Object.keys(LINK_REFUSAL_CODES), "order_lapsed", "internal_error"])
      expect(LEGAL_BODY_SENTENCES[code], code).not.toMatch(NOTHING_CHANGED);
  });

  test("a sentence that can be followed by order_lapsed sends nobody back to the order it ends", () => {
    for (const code of Object.keys(LINK_REFUSAL_CODES))
      expect(LEGAL_BODY_SENTENCES[code], code).not.toMatch(/ask for a new link message/i);
  });
});

describe("the checks every door shares with the rest of the API", () => {
  const tenant: Address = ANVIL_ACCOUNT_2.address;
  const accepted = [...ACCEPTED_CREDENTIALS][0] as string;

  function worldWith(
    verification: Partial<GuardianVerification> | undefined,
    environment = "production",
  ): WorldIdDeps {
    return {
      cfg: { environment, action: "verify-guardian" },
      store: {
        findByTenant: () =>
          verification === undefined
            ? undefined
            : ({ environment: "production", ...verification } as GuardianVerification),
      },
    } as unknown as WorldIdDeps;
  }

  function refusalOf(run: () => unknown): ApiError {
    try {
      run();
    } catch (err) {
      if (err instanceof ApiError) return err;
      throw err;
    }
    throw new Error("no refusal");
  }

  test("the real-human check and the JSON read answer fixed messages under the same rules", async () => {
    const answers = [
      refusalOf(() => assertRealHuman(undefined, tenant, "production")),
      refusalOf(() => assertRealHuman(worldWith(undefined, "staging"), tenant, "production")),
      refusalOf(() => assertRealHuman(worldWith(undefined), tenant, "production")),
      refusalOf(() => assertRealHuman(worldWith({ credential: null }), tenant, "production")),
      refusalOf(() =>
        assertRealHuman(
          worldWith({ credential: accepted, environment: "staging" }),
          tenant,
          "production",
        ),
      ),
    ];
    let jsonRefusal: unknown;
    try {
      await readJson({ req: { json: () => Promise.reject(new SyntaxError("Unexpected token")) } });
    } catch (err) {
      jsonRefusal = err;
    }
    expect(jsonRefusal).toBeInstanceOf(ApiError);
    answers.push(jsonRefusal as ApiError);

    expect(answers.map((a) => a.code)).toEqual([
      "unavailable",
      "unavailable",
      "guardian_not_verified",
      "waiver_not_accepted",
      "guardian_not_verified",
      "validation_error",
    ]);
    for (const answer of answers) expect(brokenRules(answer.message), answer.code).toEqual([]);
  });
});
