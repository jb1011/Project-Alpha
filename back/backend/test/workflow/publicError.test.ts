import { BaseError, HttpRequestError, RpcRequestError } from "viem";
import { expect, test } from "vitest";
import { BroadcastUnconfirmedError, PriorTransferUnconfirmedError } from "../../src/errors";
import { errorRef, operatorDiagnostic, publicErrorMessage } from "../../src/workflow/publicError";

/**
 * The 2026-09-16 incident, reproduced (brief §3).
 *
 * A deploy failed, the runner stored `e.message` verbatim in `entity.error`, and the wizard
 * rendered it. That message carried the RPC URL **with the provider API key in its path**, the
 * whole raw signed transaction and the calldata. Everything below is a guard on one property: the
 * string this function returns may be shown to a stranger.
 */

/** The RPC key, as it sits in the path of the URL viem quotes back. */
const KEY = "AbCdEf0123456789SECRET";
const RPC_URL = `https://arc-sepolia.example.com/v2/${KEY}`;
/** 130 hex chars — a raw signed transaction is far longer, and this is already over the cap. */
const RAW_TX = `0x02f8b2824268${"ab".repeat(120)}`;

test("the 2026-09-16 message shape leaks neither the key, nor the path, nor the raw tx", () => {
  const e = new HttpRequestError({
    body: { method: "eth_sendRawTransaction", params: [RAW_TX] },
    details: "rate limit exceeded",
    status: 429,
    url: RPC_URL,
  });
  // The raw message is the thing that reached the browser in September.
  expect(e.message).toContain(KEY);
  expect(e.message).toContain(RAW_TX);

  const out = publicErrorMessage(e);
  expect(out).not.toContain(KEY);
  expect(out).not.toContain("/v2/");
  expect(out).not.toContain(RAW_TX);
  // A 429 is the recognised transport case: nothing was sent, and the sentence says so.
  expect(out).toBe(
    "The chain RPC is rate-limiting us right now. Nothing was sent; try again in a minute.",
  );
});

test("the same shape WITHOUT a rate limit still comes out sanitised", () => {
  // The fall-through path, which is the one that has to be safe on its own: if the matcher never
  // fires, the sanitiser is the only thing between the RPC URL and the wizard.
  const e = new Error(
    [
      "Execution reverted for an unknown reason.",
      "",
      `URL: ${RPC_URL}`,
      `Request body: {"method":"eth_sendRawTransaction","params":["${RAW_TX}"]}`,
      "",
      "Version: viem@2.52.2",
    ].join("\n"),
  );
  const out = publicErrorMessage(e);
  expect(out).not.toContain(KEY);
  expect(out).not.toContain("/v2/");
  expect(out).not.toContain(RAW_TX);
  // The ORIGIN survives — "which host refused us" is operationally useful and is not a secret.
  expect(out).toContain("https://arc-sepolia.example.com");
  // The reason survives too.
  expect(out).toContain("Execution reverted");
  // Newlines are gone: this is rendered as one line of copy.
  expect(out).not.toContain("\n");
});

test("userinfo in a URL never survives", () => {
  const out = publicErrorMessage(
    new Error("connect failed for https://user:hunter2@rpc.example/x"),
  );
  expect(out).not.toContain("hunter2");
  expect(out).not.toContain("user:");
  expect(out).toContain("https://rpc.example");
});

test("a 32-byte hash is kept, a longer hex run is truncated", () => {
  const hash = `0x${"9".repeat(64)}`;
  const blob = `0x${"9".repeat(65)}`;
  expect(publicErrorMessage(new Error(`tx ${hash} failed`))).toContain(hash);
  const out = publicErrorMessage(new Error(`sending ${blob}`));
  expect(out).not.toContain(blob);
  expect(out).toContain("0x99999999…");
});

test("a plain Error passes through unchanged", () => {
  expect(publicErrorMessage(new Error("provision blew up"))).toBe("provision blew up");
});

test("the message is capped at 300 characters", () => {
  const out = publicErrorMessage(new Error("x".repeat(5_000)));
  expect(out.length).toBe(300);
  expect(out.endsWith("…")).toBe(true);
});

test("non-Error input is stringified, not crashed on", () => {
  expect(publicErrorMessage("just a string")).toBe("just a string");
  expect(publicErrorMessage(undefined)).toBe("undefined");
  expect(publicErrorMessage({ nope: 1 })).toBe("[object Object]");
});

test("a viem error's shortMessage is preferred over its whole diagnostic body", () => {
  // Not a 429 and not a funding failure, so this takes the fall-through path — and proves the
  // shortMessage preference rather than the matcher.
  const e = new HttpRequestError({
    body: { method: "eth_call" },
    details: "socket hang up",
    status: 502,
    url: RPC_URL,
  });
  expect(publicErrorMessage(e)).toBe("HTTP request failed.");
});

test("a viem error nested as a `cause` is still found", () => {
  const inner = new HttpRequestError({ body: {}, details: "socket hang up", url: RPC_URL });
  const outer = new Error(`fundTreasury failed: ${inner.message}`, { cause: inner });
  expect(publicErrorMessage(outer)).toBe("HTTP request failed.");
});

test("an RPC rate-limit code (-32005) is recognised through the wrapper", () => {
  const rpc = new RpcRequestError({
    body: { method: "eth_sendRawTransaction" },
    error: { code: -32005, message: "rate limit exceeded" },
    url: RPC_URL,
  });
  expect(publicErrorMessage(rpc)).toBe(
    "The chain RPC is rate-limiting us right now. Nothing was sent; try again in a minute.",
  );
});

test("the platform wallet being empty gets its own sentence (the 2026-09-14 incident)", () => {
  // Three shapes of the same fact: viem's pre-flight balance check, the ERC-20 revert string, and
  // the bare wording a node uses.
  for (const m of [
    "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
    "execution reverted: ERC20: transfer amount exceeds balance",
    "insufficient funds for gas * price + value",
  ]) {
    expect(publicErrorMessage(new Error(m))).toBe(
      "The platform funding wallet cannot cover this transfer right now.",
    );
  }
});

test("the rate-limit matcher wins over the funding matcher (nothing was sent)", () => {
  // A throttled send says nothing about the wallet's balance, and "nothing was sent" is the more
  // actionable half — so the order of the two matchers is a property, not an accident.
  //
  // ⚠ The fixture is a viem error because R2 now requires one for the chain sentence: a plain
  // Error carrying the same text is a NON-chain failure and must fall through (asserted below).
  const out = publicErrorMessage(
    new BaseError("HTTP error 429: rate limit exceeded (insufficient funds for gas)"),
  );
  expect(out).toContain("rate-limiting");
  // The same text on a non-viem error takes the funding matcher, and never blames the chain.
  const nonChain = publicErrorMessage(
    new Error("HTTP error 429: rate limit exceeded (insufficient funds for gas)"),
  );
  expect(nonChain).not.toContain("rate-limiting");
  expect(nonChain).toBe("The platform funding wallet cannot cover this transfer right now.");
});

test("an ordinary revert is NOT swallowed by the funding matcher", () => {
  expect(publicErrorMessage(new Error("execution reverted: NotManager()"))).toBe(
    "execution reverted: NotManager()",
  );
});

/* ── R1: "Nothing was sent" is a claim about a BROADCAST, not about an error ────────────────── */

const TX = "0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678efab" as const;

test("R1: a post-broadcast failure never says nothing was sent — it names the hash", () => {
  // The review's Critical. `fundTreasury` sends and THEN awaits the receipt, and viem rejects a
  // receipt-poll 429 verbatim. The same 429 therefore arrives in two completely different worlds,
  // and the old matcher answered "nothing was sent" in both — inviting a second transfer of
  // platform funds on the wizard's new Retry button.
  const rpc429 = new HttpRequestError({
    body: { method: "eth_getTransactionReceipt", params: [TX] },
    details: "rate limit exceeded",
    status: 429,
    url: RPC_URL,
  });
  const out = publicErrorMessage(
    new BroadcastUnconfirmedError(TX, "fundTreasury", { cause: rpc429 }),
  );
  expect(out).toBe(
    "The transfer was sent (0x1234…efab) but we could not confirm it yet. Do not retry: it will appear on the dashboard once confirmed.",
  );
  expect(out).not.toContain("Nothing was sent");
  // The rate-limit matcher is BENEATH this one and must not win, even though the cause is a 429.
  expect(out).not.toContain("rate-limiting");
  // The short hash is enough to find the transaction and short enough to read off a screenshot.
  expect(out).not.toContain(TX);
});

test("R1: an unresolved PREVIOUS transfer refuses the new one and says so", () => {
  const out = publicErrorMessage(new PriorTransferUnconfirmedError(TX));
  expect(out).toBe(
    "A previous transfer (0x1234…efab) has not been confirmed yet, so nothing new was sent. Do not retry until it appears on the dashboard.",
  );
});

test('R1: "Nothing was sent" survives for a PRE-broadcast rate limit', () => {
  // The window the sentence is true in: viem refused the send itself, so no hash exists.
  const out = publicErrorMessage(
    new HttpRequestError({
      body: { method: "eth_sendRawTransaction" },
      details: "rate limit exceeded",
      status: 429,
      url: RPC_URL,
    }),
  );
  expect(out).toContain("Nothing was sent");
});

/* ── R2: only a CHAIN error may blame the chain ─────────────────────────────────────────────── */

test("R2: an axios-style 429 (Circle, doola) does not claim the chain, or that nothing was sent", () => {
  // Measured by the reviewer on the installed axios: `e.status === 429` on a plain Error. The old
  // matcher read that property and answered for a request it knew nothing about — while a Circle
  // transaction was in flight.
  const axiosish = Object.assign(new Error("Request failed with status code 429"), {
    status: 429,
    isAxiosError: true,
  });
  const out = publicErrorMessage(axiosish);
  expect(out).not.toContain("rate-limiting");
  expect(out).not.toContain("Nothing was sent");
  expect(out).toBe("Request failed with status code 429");
});

test("R2: a viem BaseError in the CAUSE chain still reaches the chain sentence", () => {
  const inner = new RpcRequestError({
    body: { method: "eth_sendRawTransaction" },
    error: { code: -32005, message: "rate limit exceeded" },
    url: RPC_URL,
  });
  expect(publicErrorMessage(new Error("fundTreasury failed", { cause: inner }))).toBe(
    "The chain RPC is rate-limiting us right now. Nothing was sent; try again in a minute.",
  );
});

/* ── R8: the numeric-`status` branch is load-bearing ────────────────────────────────────────── */

test("R8: a 429 that exists ONLY as a property is still recognised", () => {
  // The reviewer's point: both old 429 fixtures also spelled it in their text, so deleting
  // `fullDiagnostic`'s property branch left the suite green. This shape cannot be matched on text
  // — and it is the shape a transport that stops rendering `Status:` would hand us.
  const e = Object.assign(new BaseError("upstream refused the request"), { status: 429 });
  expect(publicErrorMessage(e)).toBe(
    "The chain RPC is rate-limiting us right now. Nothing was sent; try again in a minute.",
  );
});

/* ── R4 / R6: the sanitiser's two holes ─────────────────────────────────────────────────────── */

test("R4: a URL glued to a word character is reduced too", () => {
  // The leading `\b` in URL_RUN could not match between `_` and `h`, so the scan never reached the
  // scheme and the whole URL — key included — was passed through verbatim.
  const out = publicErrorMessage(new Error(`RPC_URL_${RPC_URL} refused`));
  expect(out).not.toContain(KEY);
  expect(out).not.toContain("/v2/");
  expect(out).toContain("https://arc-sepolia.example.com");
});

test("N3: a URL containing BRACKETS is reduced, IPv6 host and bracketed query alike", () => {
  // `]` was in the excluded character class, so the run stopped at the bracket and the rest of the
  // URL — key included — survived into `entity.error` and into journald. Any deployment whose
  // ARC_*_RPC_URL is a bracketed host (a local node, a containerised one, an IPv6-only provider)
  // would have leaked its key: the 2026-09-16 incident again, through a different door.
  for (const url of [
    `http://[::1]:8545/v2/${KEY}`,
    `https://[2001:db8::1]/rpc/${KEY}`,
    `https://h.example/a?f[x]=1&key=${KEY}`,
  ]) {
    const out = publicErrorMessage(new Error(`connect failed for ${url}`));
    expect(out, url).not.toContain(KEY);
    expect(out, url).not.toContain("/v2/");
    expect(out, url).not.toContain("/rpc/");
  }
  // The origin still survives, brackets and port intact — it is what an operator reads.
  expect(publicErrorMessage(new Error(`connect failed for http://[::1]:8545/v2/${KEY}`))).toContain(
    "http://[::1]:8545",
  );
});

test("N3: the same URL through a real viem error, in BOTH outputs", () => {
  const e = new HttpRequestError({
    body: { method: "eth_sendRawTransaction" },
    status: 500,
    url: `http://[::1]:8545/v2/${KEY}`,
  });
  // The browser sentence takes the shortMessage, so assert the operator's copy too — it is the one
  // that quotes the URL, and journald is a lower bar than the browser, not a vault.
  expect(operatorDiagnostic(e)).not.toContain(KEY);
  expect(operatorDiagnostic(e)).toContain("http://[::1]:8545");
});

test("R6: a labelled credential OUTSIDE a URL is redacted", () => {
  for (const raw of [
    `Authorization: Bearer ${KEY} rejected`,
    `headers: {"x-api-key":"${KEY}"}`,
    `config apiKey=${KEY} invalid`,
    `token: ${KEY}`,
    // R5's latent case, closed by the same rule: a 64-hex private key is under the hex threshold
    // (a 32-byte hash is deliberately kept), but it is LABELLED.
    `invalid private key 0x${"ab".repeat(32)}`,
  ]) {
    const out = publicErrorMessage(new Error(raw));
    expect(out, raw).toContain("<redacted>");
    expect(out, raw).not.toContain(KEY);
    expect(out, raw).not.toContain("ababab");
  }
});

test("R6: the redactor does not eat ordinary prose", () => {
  // The rule needs a value that looks like a credential (12+ credential-ish characters), or every
  // "token expired" becomes unreadable — and `src/secrets/index.ts` deliberately prints key NAMES.
  for (const raw of [
    "token expired",
    "secret invalid",
    "DOOLA_WEBHOOK_SECRET is missing",
    "private key invalid",
  ])
    expect(publicErrorMessage(new Error(raw)), raw).toBe(raw);
});

/* ── Q4: the operator diagnostic and the join key ───────────────────────────────────────────── */

test("Q4: operatorDiagnostic keeps the whole chain, through the SAME sanitiser", () => {
  const inner = new HttpRequestError({
    body: { method: "eth_sendRawTransaction", params: [RAW_TX] },
    details: "rate limit exceeded",
    status: 429,
    url: RPC_URL,
  });
  const detail = operatorDiagnostic(new Error("fundTreasury failed", { cause: inner }));
  // Everything an operator needs…
  expect(detail).toContain("fundTreasury failed");
  expect(detail).toContain("HttpRequestError");
  expect(detail).toContain("429");
  expect(detail).toContain("https://arc-sepolia.example.com");
  // …and nothing a journal reader should not have. journald is a lower bar than the browser, not
  // a vault: same URL rule, same hex rule, no matcher substitution, a bigger budget.
  expect(detail).not.toContain(KEY);
  expect(detail).not.toContain("/v2/");
  expect(detail).not.toContain(RAW_TX);
  expect(detail.length).toBeLessThanOrEqual(600);
  expect(detail).not.toContain("\n");
});

test("Q4: the ref is stable per error text and differs across errors", () => {
  const a = errorRef(new Error("boom"));
  expect(a).toMatch(/^[0-9a-f]{8}$/);
  expect(errorRef(new Error("boom"))).toBe(a);
  expect(errorRef(new Error("bang"))).not.toBe(a);
});
