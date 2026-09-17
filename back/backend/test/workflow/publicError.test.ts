import { HttpRequestError, RpcRequestError } from "viem";
import { expect, test } from "vitest";
import { publicErrorMessage } from "../../src/workflow/publicError";

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
  const out = publicErrorMessage(
    new Error("HTTP error 429: rate limit exceeded (insufficient funds for gas)"),
  );
  expect(out).toContain("rate-limiting");
});

test("an ordinary revert is NOT swallowed by the funding matcher", () => {
  expect(publicErrorMessage(new Error("execution reverted: NotManager()"))).toBe(
    "execution reverted: NotManager()",
  );
});
