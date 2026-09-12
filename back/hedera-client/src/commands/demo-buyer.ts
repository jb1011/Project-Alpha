// DEMO ONLY (ETHOnline 2026, Hedera lane). Not part of the production build. Never run against a production database.
// The five-leg buyer that resolves a Novi Corpus company from its UAID and pays its /verify
// route, used only for the ETHOnline demo recording.
/**
 * `demo-buyer <uaid>` — the demo's buyer, and the only place the whole rail is shown at once.
 *
 * Three hops and a payment (design D23). Nothing on Hedera links a UAID to a float account
 * except Novi Corpus itself, so discovery is a Novi Corpus resolver, said plainly: parse the
 * treasury address out of the UAID's `nativeId`, ask `/legal-bodies/:address` who that is,
 * follow its metadata link, and read the company's `verifyUrl` off the `hedera` block. Then pay
 * it, and check the signature on what comes back WITHOUT asking the server whether its own
 * document is genuine.
 *
 * The five legs of the recording are five runs of this one command and two runs of the
 * guardian's scripts, not five code paths; `docs/runbooks/hedera-demo.md` has the order. What
 * this file owes each of them is a last line a viewer can read:
 *
 *   - settled      → `signature valid: true` and `settlement: OK <hashscan>`
 *   - paused       → `policy denied: paused`, exit 2, and NO HashScan link, because nothing was
 *                    signed and there is no transaction to link to (D2)
 *   - key revoked  → `HTTP 402` and the facilitator's own error, exit 1
 *
 * Every hop prints `→ GET <url>` first. Nothing here prints a key, an API key or a header.
 */
import type { SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { type AttestationBody, verifyAttestation } from "../attest.js";
import { hashscan, requireEnv } from "../mirror.js";
import { type NoviClient, type ReportPaymentArgs, createNoviClient } from "../novi.js";
import { payFetchFor } from "../pay.js";
import { custodyAgnosticSigner, localRawSigner } from "../signer.js";

/** The message `wrapFetchWithPayment` throws when the policy hook aborts. Same regex as `pay`. */
const ABORT_MESSAGE = /Payment creation aborted: (.+)$/;

/**
 * Extracts the CAIP-10 `nativeId` routing param from a `uaid:aid:...` UAID.
 *
 * COPIED, NOT IMPORTED, from `back/backend/src/hedera/uaid.ts`. The client is the customer's
 * side and does not depend on the server package; a buyer resolving a company it did not create
 * has only the string.
 *
 * @param uaid - The universal agent id
 * @returns The CAIP-10 native id, or `null` for anything that is not a UAID carrying one
 */
export function parseUaidNativeId(uaid: string): string | null {
  if (!uaid.startsWith("uaid:aid:")) return null;
  const semi = uaid.indexOf(";");
  if (semi < 0) return null;
  for (const pair of uaid.slice(semi + 1).split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === "nativeId") return pair.slice(eq + 1);
  }
  return null;
}

/**
 * The treasury address a UAID points at: the last segment of its `eip155:` native id.
 *
 * A `hedera:testnet:0.0.x` native id is refused rather than sliced, because `/legal-bodies`
 * is keyed by an Arc address and an account id would resolve to nothing with a confusing 404.
 *
 * @param uaid - The universal agent id
 * @returns The 20-byte address, as it appears in the UAID
 */
export function nativeAddress(uaid: string): string {
  const nativeId = parseUaidNativeId(uaid);
  if (!nativeId) throw new Error(`uaid has no nativeId param: ${uaid}`);
  const address = nativeId.slice(nativeId.lastIndexOf(":") + 1);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error(`uaid nativeId is not an address: ${nativeId}`);
  return address;
}

/** What the two public hops are for: the paid route, and the profile that names the company. */
export type HederaLinks = { address: string; verifyUrl: string; profileUrl: string };

/**
 * GETs a public Novi Corpus document, narrating the hop so the recording shows it.
 *
 * @param url - The absolute URL to read
 * @param fetchImpl - The fetch to use; the tests pass a stub
 * @returns The parsed JSON body
 */
async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  console.log(`→ GET ${url}`);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    // A proxy or a tunnel answering 200 with an HTML error page is the likely cause, and a bare
    // `SyntaxError: Unexpected token '<'` would not say which of the two hops produced it.
    throw new Error(`GET ${url} -> body is not JSON`);
  }
}

/**
 * Resolves a UAID to the company's paid `/verify` URL, through the two public hops.
 *
 * @param uaid - The universal agent id the buyer was handed
 * @param base - The Novi Corpus API base, `NOVI_API_BASE`
 * @param fetchImpl - The fetch to use; the tests pass a stub
 * @returns The treasury address and the two Hedera links
 */
export async function resolveHederaLinks(
  uaid: string,
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HederaLinks> {
  const root = base.replace(/\/+$/, "");
  const address = nativeAddress(uaid);

  const body = await getJson<{ links?: { metadata?: string | null } }>(
    `${root}/legal-bodies/${address}`,
    fetchImpl,
  );
  // An address that is not one of ours answers 200 with `legalBody: false` and no metadata link.
  // That is a real answer to a real question, not an error — but there is nothing left to pay.
  const metadataUrl = body.links?.metadata;
  if (!metadataUrl) throw new Error(`${address} has no metadata link: not a Novi Corpus company`);

  const meta = await getJson<{ hedera?: { verifyUrl?: string; profileUrl?: string } }>(
    metadataUrl,
    fetchImpl,
  );
  const verifyUrl = meta.hedera?.verifyUrl;
  // The block appears only once the company has a float account linked (`link_hedera_account`).
  // Without it there is no Hedera rail for this company and nothing to pay.
  if (typeof verifyUrl !== "string" || !verifyUrl)
    throw new Error(`entity has no Hedera link: ${metadataUrl} carries no hedera.verifyUrl`);

  return { address, verifyUrl, profileUrl: meta.hedera?.profileUrl ?? "" };
}

/**
 * Wraps a client so every `report_payment` answer is printed as it arrives.
 *
 * The same eight lines `pay` narrates with, kept here rather than shared because task 15 does
 * not touch `commands/pay.ts`.
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
 * Reads a `PAYMENT-RESPONSE` header off a response, either spelling.
 *
 * @param res - The response the paying fetch returned
 * @returns The raw header value, or `null`
 */
const settlementHeader = (res: Response) =>
  res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");

/**
 * Decodes a settlement header without ever throwing.
 *
 * `payFetchFor` has already reported the payment by the time this runs, so a decode here is
 * only about what to PRINT and must not undo a run that succeeded.
 *
 * @param header - The raw header value
 * @returns The settlement, or `undefined` if it did not decode
 */
function decodeSettlement(header: string): SettleResponse | undefined {
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

/**
 * Prints the settlement line and the HashScan link, exactly as `pay` prints them.
 *
 * @param res - The response the paying fetch returned
 * @returns Nothing; prints one line
 */
export function printSettlement(res: Response) {
  const hdr = settlementHeader(res);
  if (!hdr) {
    console.log("settlement: no PAYMENT-RESPONSE header");
    return;
  }
  const s = decodeSettlement(hdr);
  if (!s) {
    console.log("settlement: PAYMENT-RESPONSE did not decode; check the mirror node");
    return;
  }
  console.log(
    s.success
      ? `settlement: OK ${hashscan(s.transaction)}`
      : `settlement: FAIL ${s.errorReason ?? "unknown"} ${s.transaction ? hashscan(s.transaction) : ""}`.trimEnd(),
  );
}

/**
 * Prints what the facilitator refused, for the revoked-key leg.
 *
 * The HashScan link is printed when the facilitator names a transaction, because on this leg
 * there IS one: the facilitator submitted the transfer and the network rejected it with
 * `INVALID_SIGNATURE`, which is the whole point of the leg.
 *
 * @param res - The 402 the paying fetch returned
 * @returns Nothing; prints one line
 */
export function printRefusal(res: Response) {
  const hdr = settlementHeader(res);
  if (!hdr) {
    console.log("PAYMENT-RESPONSE: absent");
    return;
  }
  const s = decodeSettlement(hdr);
  if (!s) {
    console.log("PAYMENT-RESPONSE: did not decode");
    return;
  }
  console.log(
    `PAYMENT-RESPONSE ${s.errorReason ?? "unknown"}${s.transaction ? ` ${hashscan(s.transaction)}` : ""}`,
  );
}

/**
 * Prints what the paid document says, and whether the signature on it holds.
 *
 * Checked OFFLINE against the `attestor` the body names. That address is then worth comparing
 * against the one `/metadata/:publicId` publishes — the half a forged body cannot restate — which
 * the runbook asks the operator to do by eye during the recording.
 *
 * @param text - The response body
 * @returns Nothing; prints the four lines the demo shows, and fails the run on a bad signature
 */
export async function printAttestation(text: string) {
  let body: AttestationBody;
  try {
    body = JSON.parse(text) as AttestationBody;
  } catch {
    console.log("body did not parse as an attestation");
    process.exitCode = 1;
    return;
  }
  console.log(`standing: ${body.standing}`);
  console.log(`humanVerified: ${body.controller?.humanVerified}`);
  if (!body.attestor || !body.signature) {
    // Absent together or present together: an empty field is one a verifier could read as
    // "checked", which is worse than no field at all.
    console.log("attestor: unsigned");
    return;
  }
  console.log(`attestor: ${body.attestor}`);
  const valid = await verifyAttestation(body, body.attestor, body.signature);
  console.log(`signature valid: ${valid}`);
  // A forged or drifted body would otherwise read as success to anything scripting this command,
  // which is the one outcome an offline check exists to prevent. The settlement line still prints:
  // the payment did happen, and the operator needs its transaction id either way.
  if (!valid) process.exitCode = 1;
}

/**
 * Runs the demo buyer.
 *
 * @param argv - Command arguments; the first is the UAID to resolve
 * @returns Nothing; prints `DEMO ONLY` first, then the hops, the document and the settlement
 */
export async function demoBuyer(argv: string[]) {
  console.log("DEMO ONLY");
  if (process.env.NODE_ENV === "production")
    throw new Error("demo-buyer refuses to run with NODE_ENV=production");
  if (process.env.HEDERA_DEMO_LOCAL !== "1")
    throw new Error("demo-buyer requires HEDERA_DEMO_LOCAL=1");
  const uaid = argv[0];
  if (!uaid) throw new Error("usage: novi-hedera demo-buyer <uaid>");

  const links = await resolveHederaLinks(uaid, requireEnv("NOVI_API_BASE"));
  console.log(`profile: ${links.profileUrl || "unset"}`);

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
    console.log(`→ GET ${links.verifyUrl}`);
    const res = await paid(links.verifyUrl);
    const text = await res.text();
    console.log(`HTTP ${res.status}`);
    if (!res.ok) {
      // The revoked-key leg. The facilitator signed and submitted; the network refused, so the
      // paywall answers 402 a second time and says why.
      printRefusal(res);
      process.exitCode = 1;
      return;
    }
    await printAttestation(text);
    printSettlement(res);
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
