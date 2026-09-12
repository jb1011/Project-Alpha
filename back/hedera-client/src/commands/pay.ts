/**
 * `pay <url>` — fetch a paid resource, settling its x402 invoice from the float account.
 *
 * The refusal leg of the demo lives here: when `check_policy` denies, `payFetchFor` throws
 * before anything is signed, and this command prints `policy denied: <reason>` and exits 2
 * with no HashScan link, because there is no transaction to link to.
 */
import { decodePaymentResponseHeader } from "@x402/fetch";
import { hashscan, requireEnv } from "../mirror.js";
import { type NoviClient, type ReportPaymentArgs, createNoviClient } from "../novi.js";
import { payFetchFor } from "../pay.js";
import { custodyAgnosticSigner, localRawSigner } from "../signer.js";

/** How much of the body to print, so a long attestation does not fill the terminal. */
const BODY_HEAD = 200;

/** The message `wrapFetchWithPayment` throws when the policy hook aborts. */
const ABORT_MESSAGE = /Payment creation aborted: (.+)$/;

/**
 * Wraps a client so every `report_payment` answer is printed as it arrives.
 *
 * @param novi - The live client
 * @returns The same three tools, with `report_payment` narrating its status
 */
function narrateReports(novi: NoviClient & { close(): Promise<void> }) {
  return {
    ...novi,
    async reportPayment(args: ReportPaymentArgs) {
      const answer = await novi.reportPayment(args);
      console.log(
        `report_payment -> ${answer.status}${"reason" in answer ? ` (${answer.reason})` : ""}`,
      );
      return answer;
    },
  };
}

/**
 * Runs the pay command.
 *
 * @param argv - Command arguments; the first is the URL to fetch
 * @returns Nothing; prints the status, the body head and the settlement link
 */
export async function pay(argv: string[]) {
  const url = argv[0];
  if (!url) throw new Error("usage: novi-hedera pay <url>");

  const { pub, rawSign } = localRawSigner(requireEnv("AGENT_PRIVATE_KEY"));
  const signer = custodyAgnosticSigner(requireEnv("AGENT_ACCOUNT_ID"), pub, rawSign);
  const live = createNoviClient({
    mcpUrl: requireEnv("NOVI_MCP_URL"),
    apiKey: requireEnv("NOVI_API_KEY"),
  });

  try {
    const paid = payFetchFor({
      signer,
      novi: narrateReports(live),
      entityId: requireEnv("NOVI_ENTITY_ID"),
    });
    const res = await paid(url);
    const body = await res.text();
    console.log(`HTTP ${res.status}`);
    console.log(`body ${body.slice(0, BODY_HEAD)}`);
    const hdr = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    if (!hdr) {
      console.log("settlement: no PAYMENT-RESPONSE header");
      return;
    }
    const s = decodePaymentResponseHeader(hdr);
    console.log(
      s.success
        ? `settlement: OK ${hashscan(s.transaction)}`
        : `settlement: FAIL ${s.errorReason ?? "unknown"} ${s.transaction ? hashscan(s.transaction) : ""}`.trimEnd(),
    );
  } catch (e) {
    const denied = ABORT_MESSAGE.exec((e as Error).message ?? "");
    if (!denied?.[1]) throw e;
    // D2 in one line: the client is what refuses. Nothing was signed, so there is no
    // transaction and no HashScan link to show.
    console.log(denied[1]);
    process.exitCode = 2;
  } finally {
    await live.close();
  }
}
