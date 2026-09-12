/**
 * ERC-8004 registration on Hedera testnet (task 10): the pure parts only.
 *
 * `registerOnHedera` runs against fake viem clients — no RPC, no key, no chain. The `--from-prod`
 * path runs against a stubbed `fetch` serving `FormationE2E_1`'s real public values, and the UAID
 * it derives is asserted against the task 9 golden vector (copied verbatim from
 * `test/hedera/uaid.test.ts`) so the script and the server can never disagree about the same
 * entity's identity. `main()` — the only piece that opens a database, a socket or a wallet — is
 * never invoked here; the script's `isEntryPoint` guard is what keeps importing it side-effect
 * free (same idiom as `test/scripts/seedPublicEntity.test.ts`).
 */
import { describe, expect, test } from "vitest";
import {
  type ProdEntity,
  assertProdHost,
  fetchProdEntity,
  recordCommandLine,
  resolveEntity,
  uaidForProdEntity,
} from "../../scripts/hedera-register-identity.mjs";
import { HEDERA_IDENTITY_REGISTRY, registerOnHedera } from "../../src/hedera/registry";
import { deriveUaid, uaidInputsFor } from "../../src/hedera/uaid";
import type { Address, EntityRecord, Hex } from "../../src/types";
import { entity } from "../helpers/hederaApp";

const METADATA_URI =
  "https://www.novicorpus.com/backend/metadata/9f8003f5-4c70-435a-9980-9a54625691b7";
const OPERATOR = "0x1111111111111111111111111111111111111111" as Address;
/** The minimal shape viem calls a `JsonRpcAccount` — no key material anywhere in this suite. */
const OPERATOR_ACCOUNT = { address: OPERATOR, type: "json-rpc" } as const;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

/** A pair of viem-shaped clients whose every answer comes from the script, recording its calls. */
function fakeClients(o: { status?: "success" | "reverted"; result?: bigint } = {}) {
  const calls: { simulate?: unknown; write?: unknown; receipt?: unknown } = {};
  const request = { marker: "the simulate request object" };
  return {
    calls,
    request,
    publicClient: {
      simulateContract: async (args: unknown) => {
        calls.simulate = args;
        return { result: o.result ?? 12n, request };
      },
      waitForTransactionReceipt: async (args: { hash: Hex }) => {
        calls.receipt = args;
        return { status: o.status ?? "success" };
      },
    },
    walletClient: {
      account: OPERATOR_ACCOUNT,
      writeContract: async (req: unknown) => {
        calls.write = req;
        return TX_HASH;
      },
    },
  };
}

describe("registerOnHedera", () => {
  test("simulates, writes the simulated request, waits, and returns the simulated agent id", async () => {
    const f = fakeClients();

    const out = await registerOnHedera({
      publicClient: f.publicClient,
      walletClient: f.walletClient,
      registry: HEDERA_IDENTITY_REGISTRY,
      metadataURI: METADATA_URI,
    });

    expect(out).toEqual({ agentId: "12", txHash: TX_HASH });
    // The agent id is the simulate RESULT: this ABI carries no event to parse for it.
    expect(f.calls.simulate).toMatchObject({
      address: HEDERA_IDENTITY_REGISTRY,
      functionName: "register",
      args: [METADATA_URI],
      account: OPERATOR_ACCOUNT,
    });
    // The write is the object simulate returned, unmodified — never a hand-built transaction.
    expect(f.calls.write).toBe(f.request);
    expect(f.calls.receipt).toEqual({ hash: TX_HASH });
  });

  test("throws when the receipt comes back reverted", async () => {
    const f = fakeClients({ status: "reverted" });
    await expect(
      registerOnHedera({
        publicClient: f.publicClient,
        walletClient: f.walletClient,
        registry: HEDERA_IDENTITY_REGISTRY,
        metadataURI: METADATA_URI,
      }),
    ).rejects.toThrow("register reverted");
  });

  test("the registry address is the pinned constant, never an env var (audit C3)", () => {
    expect(HEDERA_IDENTITY_REGISTRY).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
  });
});

// ── --from-prod ────────────────────────────────────────────────────────────────────────────────

// FormationE2E_1's real public values (naming table D18), as prod serves them.
const PUBLIC_ID = "9f8003f5-4c70-435a-9980-9a54625691b7";
const TREASURY = "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf";
const CHAIN_ID = 5042002;
// The task 9 golden vector, verbatim from test/hedera/uaid.test.ts.
const GOLDEN_UAID =
  "uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk;uid=886257;registry=novicorpus;proto=mcp;nativeId=eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf";

/** Prod's two public endpoints, scripted. Records every URL so the test can assert which were hit. */
function stubFetch(
  o: { transparency?: unknown; metadata?: unknown; metadataStatus?: number } = {},
) {
  const urls: string[] = [];
  const body = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/transparency")) {
      return body(
        o.transparency ?? {
          stats: { entities: 1 },
          entities: [
            {
              publicId: PUBLIC_ID,
              name: "FormationE2E_1",
              agentId: "886257",
              treasury: TREASURY,
              legalManager: "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE",
            },
          ],
        },
      );
    }
    return body(
      o.metadata ?? { legalBody: { name: "FormationE2E_1", oaHash: null } },
      o.metadataStatus ?? 200,
    );
  }) as typeof fetch;
  return { impl, urls };
}

describe("fetchProdEntity", () => {
  test("reads name, treasury and agent id off /transparency and uses the metadata URL itself as the URI", async () => {
    const s = stubFetch();
    const p = await fetchProdEntity(PUBLIC_ID, s.impl);

    expect(p).toMatchObject({
      publicId: PUBLIC_ID,
      name: "FormationE2E_1",
      agentId: "886257",
      treasury: TREASURY,
      metadataURI: `https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}`,
    });
    expect(s.urls).toEqual([
      "https://www.novicorpus.com/backend/transparency",
      `https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}`,
    ]);
  });

  test("refuses a publicId that prod does not list", async () => {
    const s = stubFetch();
    await expect(fetchProdEntity("11111111-2222-3333-4444-555555555555", s.impl)).rejects.toThrow(
      /not listed on/,
    );
  });

  test("refuses when the metadata URI does not resolve on prod", async () => {
    const s = stubFetch({ metadataStatus: 404 });
    await expect(fetchProdEntity(PUBLIC_ID, s.impl)).rejects.toThrow(/HTTP 404/);
  });

  test("refuses a row with no treasury, rather than registering an identity with no native id", async () => {
    const s = stubFetch({
      transparency: {
        entities: [
          { publicId: PUBLIC_ID, name: "FormationE2E_1", agentId: "886257", treasury: null },
        ],
      },
    });
    await expect(fetchProdEntity(PUBLIC_ID, s.impl)).rejects.toThrow(/treasury/);
  });
});

describe("uaidForProdEntity", () => {
  test("derives the task 9 golden vector from FormationE2E_1's public values", async () => {
    const s = stubFetch();
    const p: ProdEntity = await fetchProdEntity(PUBLIC_ID, s.impl);
    expect(uaidForProdEntity(p, CHAIN_ID)).toBe(GOLDEN_UAID);
  });

  test("agrees with the server's own derivation for the same entity", async () => {
    const s = stubFetch();
    const p = await fetchProdEntity(PUBLIC_ID, s.impl);
    // The scaffold row is FormationE2E_1 as the database holds it. Prod's public view of the same
    // entity must reach the identical UAID through the SERVER's path (`uaidInputsFor` +
    // `deriveUaid` on an EntityRecord), or the demo would publish two identities for one body.
    const rec: EntityRecord = entity();
    const serverSide = deriveUaid(uaidInputsFor(rec, CHAIN_ID), { uid: rec.agentId as string });
    expect(uaidForProdEntity(p, CHAIN_ID)).toBe(serverSide);
  });
});

describe("assertProdHost", () => {
  test("accepts the prod host", () => {
    expect(() =>
      assertProdHost(`https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}`),
    ).not.toThrow();
  });

  test("refuses any other host", () => {
    expect(() => assertProdHost("http://localhost:8787/backend/metadata/x")).toThrow(
      /www\.novicorpus\.com/,
    );
  });
});

describe("recordCommandLine", () => {
  test("prints the exact --record line the box has to run", () => {
    expect(
      recordCommandLine({
        entity: "FormationE2E_1",
        agentId: "12",
        txHash: TX_HASH,
        uaid: GOLDEN_UAID,
      }),
    ).toBe(`--record --entity FormationE2E_1 --agent-id 12 --tx ${TX_HASH} --uaid ${GOLDEN_UAID}`);
  });
});

describe("resolveEntity", () => {
  const rows = [
    entity({ idempotencyKey: "0xA:FormationE2E_1", name: "FormationE2E_1", publicId: PUBLIC_ID }),
    entity({ idempotencyKey: "0xB:Other", name: "Other", publicId: "other-public-id" }),
  ];

  test("matches an idempotency key, a public id, or a name", () => {
    expect(resolveEntity(rows, "0xB:Other").name).toBe("Other");
    expect(resolveEntity(rows, PUBLIC_ID).name).toBe("FormationE2E_1");
    expect(resolveEntity(rows, "FormationE2E_1").idempotencyKey).toBe("0xA:FormationE2E_1");
  });

  test("throws for an unknown target", () => {
    expect(() => resolveEntity(rows, "nope")).toThrow(/no such entity/);
  });

  test("throws rather than guess when one name matches two rows", () => {
    const dupes = [
      ...rows,
      entity({ idempotencyKey: "0xC:FormationE2E_1", name: "FormationE2E_1" }),
    ];
    expect(() => resolveEntity(dupes, "FormationE2E_1")).toThrow(/ambiguous/);
  });
});
