/**
 * The doors in front of the legal-body flow, decided as data: whether the deployment offers the
 * flow at all, whether the wallet is signed in and can be the guardian, whether a person is on
 * record, and what the screens around them say. The screens only render these answers.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/components/onboarding/AuthProvider", () => ({
  useAuth: () => ({ session: null, ensureSession: async () => ({ token: "t" }) }),
}));

import { useLegalBodyConfig } from "@/lib/api/legalBodyHooks";
import { apiKeys } from "@/lib/api/keys";
import { ApiError, type LegalBodyConfig, type PublicConfig } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  anySignInRequired,
  bannerLines,
  declarationsClosed,
  humanErrorSentence,
  humanStepView,
  isSignInRequired,
  legalBodyDoor,
  legalBodyGate,
  signInStepState,
  type CodeRead,
  type SignInStepState,
} from "@/lib/legalBody/gates";
import type { WorldIdGateState } from "@/lib/legalBody/worldIdGate";

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;

const available = (over: Partial<AvailableConfig> = {}): AvailableConfig => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
  ...over,
});

/** A `/config` answer from a backend that serves no `legalBodies` field. */
const OLDER_CONFIG: PublicConfig = {
  walletProviderDefault: "circle",
  circleCustodyAvailable: true,
};

const GATE = LEGAL_BODY_COPY.door.notOffered;

describe("legalBodyDoor", () => {
  test("loading: nothing yet, no flow", () => {
    expect(legalBodyDoor({ status: "loading", config: null })).toEqual({ kind: "loading" });
  });

  test("a failed read: the retry, no flow", () => {
    expect(legalBodyDoor({ status: "error", config: null })).toEqual({
      kind: "error",
      sentence: LEGAL_BODY_COPY.door.unreadable,
    });
  });

  test("available false: the gate sentence, no flow", () => {
    expect(legalBodyDoor({ status: "ready", config: { available: false } })).toEqual({
      kind: "closed",
      sentence: GATE,
    });
  });

  test("a config without legalBodies offers no door: the gate sentence, and no flow", () => {
    expect(legalBodyDoor({ status: "ready", config: OLDER_CONFIG.legalBodies })).toEqual({
      kind: "closed",
      sentence: GATE,
    });
  });

  test("available: the flow, with the deployment's facts", () => {
    const config = available({ declarations: false });
    expect(legalBodyDoor({ status: "ready", config })).toEqual({ kind: "open", config });
  });

  test("through the real hook: a /config without legalBodies offers no door", () => {
    const client = new QueryClient();
    client.setQueryData(apiKeys.publicConfig(), OLDER_CONFIG);
    function Probe() {
      const door = legalBodyDoor(useLegalBodyConfig());
      return createElement("p", null, door.kind === "closed" ? door.sentence : door.kind);
    }
    const out = renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)));
    expect(out).toContain(GATE);
    expect(out).not.toContain("open");
  });
});

describe("isSignInRequired", () => {
  test("the hooks' refusal without a session, and the server's 401, both mean sign in", () => {
    expect(isSignInRequired(new ApiError(401, { code: "unauthorized", message: "sign-in required" }))).toBe(true);
    expect(isSignInRequired(new ApiError(401, { code: "unauthorized", message: "token expired" }))).toBe(true);
  });

  test("anything else is the step's own failure", () => {
    expect(isSignInRequired(new ApiError(403, { code: "guardian_not_verified", message: "x" }))).toBe(false);
    expect(isSignInRequired(new Error("unauthorized"))).toBe(false);
    expect(isSignInRequired(null)).toBe(false);
    expect(isSignInRequired({ code: "unauthorized" })).toBe(false);
  });

  test("anySignInRequired looks at every read", () => {
    const refused = new ApiError(401, { code: "unauthorized", message: "sign-in required" });
    expect(anySignInRequired([null, undefined, new Error("offline"), refused])).toBe(true);
    expect(anySignInRequired([null, new Error("offline")])).toBe(false);
    expect(anySignInRequired([])).toBe(false);
  });
});

describe("signInStepState", () => {
  const KEY: CodeRead = { status: "success", data: null };
  const EMPTY: CodeRead = { status: "success", data: "0x" };
  /** `0xef0100` and a 20-byte delegate address: 23 bytes. */
  const DELEGATED: CodeRead = { status: "success", data: `0xef0100${"0".repeat(36)}beef` };
  const CONTRACT: CodeRead = { status: "success", data: "0x6080604052348015600f57600080fd5b50" };
  const PENDING: CodeRead = { status: "pending", data: undefined };
  const FAILED: CodeRead = { status: "error", data: undefined };

  const rows: [string, Parameters<typeof signInStepState>[0], SignInStepState][] = [
    ["no session", { hasSession: false, attempt: null, expired: false, code: KEY }, "sign_in"],
    ["a session while a connect is under way", { hasSession: true, attempt: "connecting", expired: false, code: KEY }, "sign_in"],
    ["a session after a failed attempt", { hasSession: true, attempt: "error", expired: false, code: KEY }, "sign_in"],
    ["a session the server no longer accepts", { hasSession: true, attempt: null, expired: true, code: KEY }, "expired"],
    ["the wallet's code still being read", { hasSession: true, attempt: null, expired: false, code: PENDING }, "checking"],
    ["the wallet's code could not be read", { hasSession: true, attempt: null, expired: false, code: FAILED }, "check_failed"],
    ["a plain key", { hasSession: true, attempt: null, expired: false, code: KEY }, "ready"],
    ["a plain key read as 0x", { hasSession: true, attempt: null, expired: false, code: EMPTY }, "ready"],
    ["a key delegated under EIP-7702 still signs as a key", { hasSession: true, attempt: null, expired: false, code: DELEGATED }, "ready"],
    ["a smart account: a stop", { hasSession: true, attempt: null, expired: false, code: CONTRACT }, "smart_account"],
  ];

  test.each(rows)("%s", (_name, input, state) => {
    expect(signInStepState(input)).toBe(state);
  });
});

describe("legalBodyGate", () => {
  const accepted: WorldIdGateState = { kind: "accepted", credential: "orb" };
  const refused: WorldIdGateState = { kind: "not_accepted", credential: "waiver" };

  test("sign-in first: anything but ready stays on it", () => {
    for (const signIn of ["sign_in", "expired", "checking", "check_failed", "smart_account"] as const) {
      expect(legalBodyGate({ signIn, human: accepted, view: null })).toBe("signin");
    }
  });

  test("signed in, a person not accepted: the human gate", () => {
    for (const human of [
      refused,
      { kind: "loading" },
      { kind: "error" },
      { kind: "unavailable" },
      { kind: "verify", required: true },
    ] as WorldIdGateState[]) {
      expect(legalBodyGate({ signIn: "ready", human, view: null })).toBe("human");
    }
  });

  test("both passed: the flow, so a reload lands on the thread's own step", () => {
    expect(legalBodyGate({ signIn: "ready", human: accepted, view: null })).toBe("flow");
  });

  test("a person who went back to a gate stays on it until Continue", () => {
    expect(legalBodyGate({ signIn: "ready", human: accepted, view: "signin" })).toBe("signin");
    expect(legalBodyGate({ signIn: "ready", human: accepted, view: "human" })).toBe("human");
  });

  test("going back to the human gate never skips sign-in", () => {
    expect(legalBodyGate({ signIn: "expired", human: accepted, view: "human" })).toBe("signin");
  });
});

describe("humanStepView", () => {
  test("loading: the reading line, no button", () => {
    expect(humanStepView({ kind: "loading" })).toEqual({
      title: "ask",
      line: "checking",
      points: false,
      verify: false,
      continue: false,
      retry: false,
    });
  });

  test("no World ID on this deployment: its sentence and no button", () => {
    for (const state of [{ kind: "unavailable" }, { kind: "skip" }] as WorldIdGateState[]) {
      expect(humanStepView(state)).toEqual({
        title: "ask",
        line: "unavailable",
        points: false,
        verify: false,
        continue: false,
        retry: false,
      });
    }
  });

  test("a failed read: its sentence and a retry", () => {
    expect(humanStepView({ kind: "error" })).toMatchObject({ line: "unreadable", retry: true, verify: false, continue: false });
  });

  test("nobody on record: the points and Verify", () => {
    expect(humanStepView({ kind: "verify", required: true })).toEqual({
      title: "ask",
      line: null,
      points: true,
      verify: true,
      continue: false,
      retry: false,
    });
  });

  test("a record this product refuses: the record line, the points and Verify, never Continue", () => {
    expect(humanStepView({ kind: "not_accepted", credential: "waiver" })).toEqual({
      title: "ask",
      line: "record",
      points: true,
      verify: true,
      continue: false,
      retry: false,
    });
  });

  test("accepted: the record and Continue", () => {
    expect(humanStepView({ kind: "accepted", credential: "orb" })).toEqual({
      title: "accepted",
      line: "record",
      points: false,
      verify: false,
      continue: true,
      retry: false,
    });
  });
});

describe("humanErrorSentence", () => {
  const W = LEGAL_BODY_COPY.human.worldErrors;

  test("no error, no sentence", () => {
    expect(humanErrorSentence(null)).toBeNull();
  });

  test("World's own refusals in plain words", () => {
    expect(humanErrorSentence("world:nullifier_replayed")).toBe(W.sameHuman);
    expect(humanErrorSentence("world:max_verifications_reached")).toBe(W.sameHuman);
    expect(humanErrorSentence("world:user_rejected")).toBe(W.dismissed);
    expect(humanErrorSentence("world:verification_rejected")).toBe(W.dismissed);
  });

  test("any other World code is named, not hidden", () => {
    const s = humanErrorSentence("world:connection_failed");
    expect(s).toContain("connection_failed");
    expect(s).not.toContain("{code}");
  });

  test("the API's own sentence is shown as served", () => {
    expect(humanErrorSentence("World ID verification is not configured.")).toBe(
      "World ID verification is not configured.",
    );
  });
});

describe("bannerLines", () => {
  test("sandbox without payment: the banner and the one money sentence", () => {
    expect(bannerLines(available())).toEqual([
      LEGAL_BODY_COPY.sandbox.banner,
      LEGAL_BODY_COPY.sandbox.noPaymentStep,
    ]);
  });

  test("sandbox that charges: the banner, and nothing about money", () => {
    expect(bannerLines(available({ paymentRequired: true }))).toEqual([LEGAL_BODY_COPY.sandbox.banner]);
  });

  test("production: no banner, and no money sentence about a testnet", () => {
    expect(bannerLines(available({ environment: "production" }))).toEqual([]);
    expect(bannerLines(available({ environment: "production", paymentRequired: true }))).toEqual([]);
  });
});

describe("declarationsClosed", () => {
  test("a deployment that takes no declarations shows its sentence in place of the form", () => {
    expect(declarationsClosed(available({ declarations: false }), { phase: "company", companyStep: "form" })).toBe(true);
  });

  test("existing threads still run there", () => {
    const config = available({ declarations: false });
    expect(declarationsClosed(config, { phase: "agreement" })).toBe(false);
    expect(declarationsClosed(config, { phase: "company", companyStep: "waiting" })).toBe(false);
    expect(declarationsClosed(config, { phase: "done" })).toBe(false);
  });

  test("a deployment that takes declarations shows the form", () => {
    expect(declarationsClosed(available(), { phase: "company", companyStep: "form" })).toBe(false);
  });
});
