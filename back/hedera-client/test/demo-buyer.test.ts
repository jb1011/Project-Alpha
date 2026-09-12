// The demo buyer's resolution hops, with `fetch` stubbed. No network, no key, no payment.
// The claims: the UAID carries the treasury address, the two public hops reach the company's
// `verifyUrl`, and a company with no Hedera link is refused by name rather than paid for.
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTESTATION_DOMAIN, ATTESTATION_TYPES, attestationMessage } from "../src/attest.js";
import {
  nativeAddress,
  parseUaidNativeId,
  printAttestation,
  printRefusal,
  printSettlement,
  resolveHederaLinks,
} from "../src/commands/demo-buyer.js";

/** The golden UAID (plan task 9), `FormationE2E_1`'s. */
const UAID =
  "uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk;uid=886257;registry=novicorpus;proto=mcp;nativeId=eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf";
const ADDRESS = "0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf";
const BASE = "https://www.novicorpus.test/backend";
const PUBLIC_ID = "9f8003f5-4c70-435a-9980-9a54625691b7";

const legalBody = {
  address: ADDRESS,
  legalBody: true,
  standing: "active",
  publicId: PUBLIC_ID,
  links: { transparency: `${BASE}/transparency`, metadata: `${BASE}/metadata/${PUBLIC_ID}` },
};

const metadata = (hedera: unknown) => ({
  name: "FormationE2E_1",
  uaid: UAID,
  registrations: [],
  ...(hedera ? { hedera } : {}),
});

const hederaBlock = {
  accountId: "0.0.10450558",
  verifyUrl: `${BASE}/verify/${PUBLIC_ID}`,
  profileUrl: `${BASE}/metadata/${PUBLIC_ID}/profile`,
};

/** Answers each URL from a script, and records the order it was asked in. */
function stubFetch(script: Record<string, unknown>) {
  const seen: string[] = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    const body = script[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}

describe("parseUaidNativeId", () => {
  it("returns the CAIP-10 nativeId of the golden UAID", () => {
    expect(parseUaidNativeId(UAID)).toBe(`eip155:5042002:${ADDRESS}`);
  });

  it("returns null for a string that is not a uaid:aid UAID, or carries no nativeId", () => {
    expect(parseUaidNativeId("did:hedera:testnet:abc")).toBeNull();
    expect(parseUaidNativeId("uaid:aid:7yCVPN2iLzHZ")).toBeNull();
    expect(parseUaidNativeId("uaid:aid:7yCVPN2iLzHZ;uid=886257")).toBeNull();
  });
});

describe("nativeAddress", () => {
  it("takes the address off the end of a CAIP-10 nativeId", () => {
    expect(nativeAddress(UAID)).toBe(ADDRESS);
  });

  it("refuses a UAID whose nativeId is not an address", () => {
    expect(() => nativeAddress("uaid:aid:x;nativeId=hedera:testnet:0.0.10450558")).toThrow(
      /not an address/,
    );
  });

  it("refuses a UAID with no nativeId", () => {
    expect(() => nativeAddress("uaid:aid:x")).toThrow(/no nativeId/);
  });
});

describe("resolveHederaLinks", () => {
  it("walks legal-bodies then metadata to the hedera block", async () => {
    const { impl, seen } = stubFetch({
      [`${BASE}/legal-bodies/${ADDRESS}`]: legalBody,
      [`${BASE}/metadata/${PUBLIC_ID}`]: metadata(hederaBlock),
    });
    const links = await resolveHederaLinks(UAID, BASE, impl);
    expect(links).toEqual({
      address: ADDRESS,
      verifyUrl: `${BASE}/verify/${PUBLIC_ID}`,
      profileUrl: `${BASE}/metadata/${PUBLIC_ID}/profile`,
    });
    expect(seen).toEqual([`${BASE}/legal-bodies/${ADDRESS}`, `${BASE}/metadata/${PUBLIC_ID}`]);
  });

  it("tolerates a trailing slash on the base", async () => {
    const { impl } = stubFetch({
      [`${BASE}/legal-bodies/${ADDRESS}`]: legalBody,
      [`${BASE}/metadata/${PUBLIC_ID}`]: metadata(hederaBlock),
    });
    const links = await resolveHederaLinks(UAID, `${BASE}/`, impl);
    expect(links.verifyUrl).toBe(`${BASE}/verify/${PUBLIC_ID}`);
  });

  it("refuses a metadata document with no hedera block", async () => {
    const { impl } = stubFetch({
      [`${BASE}/legal-bodies/${ADDRESS}`]: legalBody,
      [`${BASE}/metadata/${PUBLIC_ID}`]: metadata(undefined),
    });
    await expect(resolveHederaLinks(UAID, BASE, impl)).rejects.toThrow("entity has no Hedera link");
  });

  it("refuses a hedera block with no verifyUrl", async () => {
    const { impl } = stubFetch({
      [`${BASE}/legal-bodies/${ADDRESS}`]: legalBody,
      [`${BASE}/metadata/${PUBLIC_ID}`]: metadata({ accountId: "0.0.10450558" }),
    });
    await expect(resolveHederaLinks(UAID, BASE, impl)).rejects.toThrow("entity has no Hedera link");
  });

  it("refuses an address that is not one of ours", async () => {
    const { impl } = stubFetch({
      [`${BASE}/legal-bodies/${ADDRESS}`]: {
        address: ADDRESS,
        legalBody: false,
        standing: null,
        checkedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    await expect(resolveHederaLinks(UAID, BASE, impl)).rejects.toThrow(/no metadata link/);
  });

  it("names the hop that failed when a request is not ok", async () => {
    const { impl } = stubFetch({});
    await expect(resolveHederaLinks(UAID, BASE, impl)).rejects.toThrow(
      `GET ${BASE}/legal-bodies/${ADDRESS} -> 404`,
    );
  });
});

// ── The lines the recording shows ───────────────────────────────────────────────────────────────
// Each leg of the demo is judged on its last line, so the lines are asserted rather than eyeballed
// at the recording, where a wrong one costs a retake.

const SYNTHETIC_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TX_ID = "0.0.7162784@1789178320.131369376";

const attestation = {
  subject: {
    publicId: PUBLIC_ID,
    name: "FormationE2E_1",
    agentId: "886257",
    registry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    treasury: ADDRESS,
    uaid: UAID,
  },
  standing: "active" as const,
  formation: { status: "complete", environment: "production" },
  controller: { humanVerified: true, credential: "orb" },
  legalBody: { oaHash: null, manifestVersion: null },
  issuedAt: "2026-09-12T00:00:00.000Z",
  issuedAtUnix: "1789171200",
  expiresAt: "2026-09-12T00:05:00.000Z",
  expiresAtUnix: "1789171500",
};

/** A response carrying a settlement header, either spelling the client accepts. */
const withSettlement = (settle: SettleResponse, status = 200) =>
  new Response("{}", {
    status,
    headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) },
  });

/** Captures what a block printed, one entry per `console.log`. */
function captured() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("printAttestation", () => {
  it("prints standing, humanVerified, the attestor and a valid signature", async () => {
    const account = privateKeyToAccount(SYNTHETIC_KEY);
    const signature = await account.signTypedData({
      domain: ATTESTATION_DOMAIN,
      types: ATTESTATION_TYPES,
      primaryType: "LegalBodyAttestation",
      message: attestationMessage(attestation),
    });
    const c = captured();
    await printAttestation(
      JSON.stringify({ ...attestation, attestor: account.address, signature }),
    );
    c.restore();
    expect(c.lines).toEqual([
      "standing: active",
      "humanVerified: true",
      `attestor: ${account.address}`,
      "signature valid: true",
    ]);
  });

  it("says `unsigned` rather than showing an empty attestor", async () => {
    const c = captured();
    await printAttestation(JSON.stringify(attestation));
    c.restore();
    expect(c.lines.at(-1)).toBe("attestor: unsigned");
  });

  it("reports a body that is not an attestation instead of throwing", async () => {
    const c = captured();
    await printAttestation("<html>gateway timeout</html>");
    c.restore();
    expect(c.lines).toEqual(["body did not parse as an attestation"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("printSettlement", () => {
  it("prints the HashScan link on a settled payment", () => {
    const c = captured();
    printSettlement(
      withSettlement({
        success: true,
        transaction: TX_ID,
        network: "hedera:testnet",
        payer: "0.0.1",
      }),
    );
    c.restore();
    expect(c.lines).toEqual([`settlement: OK https://hashscan.io/testnet/transaction/${TX_ID}`]);
  });

  it("says so when there is no settlement header at all", () => {
    const c = captured();
    printSettlement(new Response("{}", { status: 200 }));
    c.restore();
    expect(c.lines).toEqual(["settlement: no PAYMENT-RESPONSE header"]);
  });
});

describe("printRefusal", () => {
  it("prints the facilitator's error and the transaction the ledger rejected", () => {
    const c = captured();
    printRefusal(
      withSettlement(
        {
          success: false,
          errorReason: "transaction_failed",
          transaction: TX_ID,
          network: "hedera:testnet",
          payer: "0.0.1",
        } as SettleResponse,
        402,
      ),
    );
    c.restore();
    expect(c.lines).toEqual([
      `PAYMENT-RESPONSE transaction_failed https://hashscan.io/testnet/transaction/${TX_ID}`,
    ]);
  });
});
