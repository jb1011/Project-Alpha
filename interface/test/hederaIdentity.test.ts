/**
 * Hedera identity on the public metadata document: what may be shown, and when nothing may be.
 *
 * The backend publishes three independently optional facts on GET /metadata/:publicId (`uaid`,
 * the `eip155:296` registrations[] entry, the `hedera` block). The UI's one job is to hide every
 * line that is absent, and to never invent a HashScan link or a chip from a field that is not
 * there. FormationE2E_1's real prod shape is the fixture; an empty document is the other pole.
 */
import { describe, expect, test } from "vitest";
import type { PublicMetadata, TransparencyHedera } from "@/lib/api/types";
import { hashscanAccountUrl, hashscanContractUrl, hashscanTxUrl } from "@/lib/hedera/hashscan";
import {
  HEDERA_IDENTITY_REGISTRY,
  hederaIdentityChip,
  hederaIdentityFromMetadata,
  hederaTransparencyLinks,
  publicIdFromMetadataUri,
  shortUaid,
} from "@/lib/hedera/identity";

const PUBLIC_ID = "9f8003f5-4c70-435a-9980-9a54625691b7";
const UAID =
  "uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk;uid=886257;registry=novicorpus;proto=mcp;nativeId=eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf";
const REGISTER_TX = "0xc5389a0a6f38fdecb6792c0b07442026f86e3d710168c6ae108ecf855c521eb7";

/** FormationE2E_1 as served on prod after the hedera deploy. */
const FORMATION_E2E: PublicMetadata = {
  uaid: UAID,
  registrations: [
    {
      agentId: "886257",
      agentRegistry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    },
    {
      agentId: "113",
      agentRegistry: `eip155:296:${HEDERA_IDENTITY_REGISTRY}`,
    },
  ],
  hedera: {
    accountId: "0.0.10450558",
    verifyUrl: `https://api.novicorpus.com/verify/${PUBLIC_ID}`,
    profileUrl: `https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}/profile`,
    registerTx: REGISTER_TX,
    attestor: "0x038B40CFf3A948aA596AcFdd113c9Eac96011e2b",
  },
};

test("FormationE2E_1 yields every field and a HashScan chip", () => {
  const view = hederaIdentityFromMetadata(FORMATION_E2E);
  expect(view).toEqual({
    uaid: UAID,
    hederaAgentId: "113",
    registryAddress: HEDERA_IDENTITY_REGISTRY,
    accountId: "0.0.10450558",
    profileUrl: `https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}/profile`,
    verifyUrl: `https://api.novicorpus.com/verify/${PUBLIC_ID}`,
    registerTx: REGISTER_TX,
    attestor: "0x038B40CFf3A948aA596AcFdd113c9Eac96011e2b",
  });
  expect(hederaIdentityChip(view)).toEqual({
    label: "Hedera identity ↗",
    title: "Registered on Hedera testnet as ERC-8004 agent 113.",
    href: hashscanTxUrl(REGISTER_TX),
  });
  expect(hashscanAccountUrl(view!.accountId!)).toBe(
    "https://hashscan.io/testnet/account/0.0.10450558",
  );
});

test("no Hedera identity at all → nothing to render", () => {
  expect(hederaIdentityFromMetadata(undefined)).toBeNull();
  expect(hederaIdentityFromMetadata(null)).toBeNull();
  expect(hederaIdentityFromMetadata({})).toBeNull();
  expect(
    hederaIdentityFromMetadata({
      registrations: [
        {
          agentId: "886257",
          agentRegistry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        },
      ],
    }),
  ).toBeNull();
  expect(hederaIdentityChip(null)).toBeNull();
});

describe("each field is independently optional", () => {
  test("uaid alone is enough to show a UAID row, and never a chip", () => {
    const view = hederaIdentityFromMetadata({ uaid: UAID });
    expect(view).toEqual({ uaid: UAID });
    expect(hederaIdentityChip(view)).toBeNull();
  });

  test("Hedera registration without a tx links the chip at the registry contract", () => {
    const view = hederaIdentityFromMetadata({
      registrations: [
        { agentId: "113", agentRegistry: `eip155:296:${HEDERA_IDENTITY_REGISTRY}` },
      ],
    });
    expect(view?.hederaAgentId).toBe("113");
    expect(hederaIdentityChip(view)?.href).toBe(hashscanContractUrl(HEDERA_IDENTITY_REGISTRY));
  });

  test("a hedera block without a registration shows account and profile, not a chip", () => {
    const view = hederaIdentityFromMetadata({
      hedera: {
        accountId: "0.0.10450558",
        profileUrl: "https://www.novicorpus.com/backend/metadata/x/profile",
      },
    });
    expect(view).toEqual({
      accountId: "0.0.10450558",
      profileUrl: "https://www.novicorpus.com/backend/metadata/x/profile",
    });
    expect(hederaIdentityChip(view)).toBeNull();
  });

  test("empty strings are treated as absent", () => {
    expect(
      hederaIdentityFromMetadata({
        uaid: "",
        hedera: { accountId: "   ", verifyUrl: "", profileUrl: "", registerTx: "", attestor: "" },
      }),
    ).toBeNull();
  });

  test("the paid verifyUrl is read, and stays on the owner's dashboard", () => {
    const view = hederaIdentityFromMetadata({
      hedera: { verifyUrl: `https://api.novicorpus.com/verify/${PUBLIC_ID}` },
    });
    expect(view?.verifyUrl).toBe(`https://api.novicorpus.com/verify/${PUBLIC_ID}`);
  });
});

// ── The public transparency row (GET /transparency) ───────────────────────────────────────────
//
// The page renders these links from the ROW, with no request of its own: the backend publishes
// the same facts per row that `/metadata/:publicId` carries. The row has no `verifyUrl` field at
// all, which is how the paid link stays off the free page.

/** FormationE2E_1's row, as the backend's `hederaFactsOf` builds it. */
const ROW: TransparencyHedera = {
  agentId: "113",
  registerTx: REGISTER_TX,
  profileUrl: `https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}/profile`,
  uaid: UAID,
};

test("a registered row links the profile and the registration, and nothing else", () => {
  expect(hederaTransparencyLinks(ROW)).toEqual([
    { label: "Profile", href: ROW.profileUrl },
    { label: "Hedera register", href: hashscanTxUrl(REGISTER_TX) },
  ]);
});

test("no row, or a row with only an agent id, links nothing", () => {
  expect(hederaTransparencyLinks(undefined)).toEqual([]);
  expect(hederaTransparencyLinks(null)).toEqual([]);
  // An entity registered but not yet anchored to a tx or a profile: the row exists, and there is
  // still nothing a stranger could click through to.
  expect(hederaTransparencyLinks({ agentId: "113" })).toEqual([]);
});

test("publicId is the UUID tail of an https metadataURI, and nothing else", () => {
  expect(
    publicIdFromMetadataUri(`https://www.novicorpus.com/backend/metadata/${PUBLIC_ID}`),
  ).toBe(PUBLIC_ID);
  expect(publicIdFromMetadataUri(`file:///tmp/meta-${PUBLIC_ID}.json`)).toBeNull();
  expect(publicIdFromMetadataUri("https://www.novicorpus.com/backend/metadata/not-a-uuid")).toBeNull();
  expect(publicIdFromMetadataUri(null)).toBeNull();
});

test("shortUaid keeps the aid prefix and drops routing params", () => {
  expect(shortUaid(UAID)).toBe("uaid:aid:7yCVPN2iL…");
  expect(shortUaid("uaid:aid:short")).toBe("uaid:aid:short");
});
