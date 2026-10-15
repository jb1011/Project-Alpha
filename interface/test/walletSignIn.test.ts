/**
 * The wallet sign-in card's state machine, and the rule a screen gates on.
 *
 * The card's badge and the screen around it must agree on "signed in". A stored session can meet
 * a wallet that is locked or not yet rehydrated: the card then offers "Connect wallet" while the
 * session is still valid. While that connect is under way, or after it failed, the card's badge
 * is not signed in, and a screen that gates on the session alone would disagree with it. So the
 * card tells the screen about every attempt, and both read the same rule.
 */
import { describe, expect, test } from "vitest";
import {
  connectAttempt,
  signInAttempt,
  walletSignedIn,
  walletStateOf,
  type WalletAttempt,
} from "@/lib/walletSignIn";

const ATTEMPTS: WalletAttempt[] = [null, "connecting", "error"];
const BOOLS = [false, true];

describe("walletStateOf", () => {
  const cases: [WalletAttempt, boolean, boolean, string][] = [
    [null, false, false, "idle"],
    [null, false, true, "connected"],
    [null, true, false, "logged-in"],
    [null, true, true, "logged-in"],
    ["connecting", false, false, "connecting"],
    ["connecting", true, false, "connecting"],
    ["connecting", true, true, "connecting"],
    ["error", false, true, "error"],
    ["error", true, false, "error"],
    ["error", true, true, "error"],
  ];

  test.each(cases)("attempt %s, session %s, connected %s: %s", (attempt, session, connected, state) => {
    expect(walletStateOf(attempt, session, connected)).toBe(state);
  });
});

describe("walletSignedIn", () => {
  test("a session with no attempt under way", () => {
    expect(walletSignedIn(true, null)).toBe(true);
  });

  test("a stored session while a connect is under way, or after it failed: not signed in", () => {
    expect(walletSignedIn(true, "connecting")).toBe(false);
    expect(walletSignedIn(true, "error")).toBe(false);
  });

  test("no session: never", () => {
    for (const attempt of ATTEMPTS) expect(walletSignedIn(false, attempt)).toBe(false);
  });

  test("the screen's rule and the card's badge agree in every combination", () => {
    for (const attempt of ATTEMPTS)
      for (const session of BOOLS)
        for (const connected of BOOLS)
          expect(walletSignedIn(session, attempt)).toBe(
            walletStateOf(attempt, session, connected) === "logged-in",
          );
  });
});

/** Records what an attempt reports, in order, and the screen's rule after each report. */
function recorder(session: boolean) {
  const events: string[] = [];
  let attempt: WalletAttempt = null;
  return {
    events,
    signedIn: () => walletSignedIn(session, attempt),
    report: {
      attempt(next: WalletAttempt) {
        attempt = next;
        events.push(`attempt:${next}`);
      },
      error(message: string | null) {
        events.push(`error:${message}`);
      },
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("connectAttempt", () => {
  test("a stored session: not signed in while the connect is under way, signed in once it lands", async () => {
    const r = recorder(true);
    const wallet = deferred();
    const running = connectAttempt(() => wallet.promise, r.report);
    expect(r.signedIn()).toBe(false);
    wallet.resolve();
    await running;
    expect(r.signedIn()).toBe(true);
    expect(r.events).toEqual(["error:null", "attempt:connecting", "attempt:null"]);
  });

  test("a refused connect: the attempt stays failed and its message is reported", async () => {
    const r = recorder(true);
    await connectAttempt(async () => {
      throw new Error("User rejected the request.");
    }, r.report);
    expect(r.signedIn()).toBe(false);
    expect(r.events).toEqual([
      "error:null",
      "attempt:connecting",
      "attempt:error",
      "error:User rejected the request.",
    ]);
  });

  test("a failure that is not an Error reads the fallback sentence", async () => {
    const r = recorder(false);
    await connectAttempt(async () => {
      throw "nope";
    }, r.report);
    expect(r.events.at(-1)).toBe("error:Wallet connection failed.");
  });
});

describe("signInAttempt", () => {
  test("a sign-in clears an earlier failed attempt before it starts", async () => {
    const r = recorder(true);
    r.report.attempt("error");
    r.events.length = 0;
    await signInAttempt(async () => {}, r.report);
    expect(r.signedIn()).toBe(true);
    expect(r.events).toEqual(["error:null", "attempt:null"]);
  });

  test("a refused sign-in: failed, with its message", async () => {
    const r = recorder(false);
    await signInAttempt(async () => {
      throw new Error("Signature refused.");
    }, r.report);
    expect(r.events).toEqual([
      "error:null",
      "attempt:null",
      "attempt:error",
      "error:Signature refused.",
    ]);
  });

  test("a failure that is not an Error reads the fallback sentence", async () => {
    const r = recorder(false);
    await signInAttempt(async () => {
      throw 42;
    }, r.report);
    expect(r.events.at(-1)).toBe("error:Sign-in failed.");
  });
});
