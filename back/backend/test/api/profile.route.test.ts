/**
 * GET /metadata/:publicId/profile — the HCS-11 profile document (task 11, design D11) — and the
 * Hedera cross-links the metadata route gained in the same task.
 *
 * The app is built here rather than through `test/helpers/hederaApp.ts` for ONE reason: the
 * metadata route reads the stored JSON off `docStore`, which the shared scaffold does not wire.
 * Every value that matters is still the scaffold's (`entity()`, `METADATA_BASE`, `PUBLIC_ID`,
 * `IDENTITY_REGISTRY`), so a Hedera fact cannot mean one thing here and another in the scaffold.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { HEDERA_IDENTITY_REGISTRY } from "../../src/hedera/registry";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord, Hex } from "../../src/types";
import {
  IDENTITY_REGISTRY,
  METADATA_BASE,
  PUBLIC_ID,
  TREASURY,
  WEB,
  arcReads,
  entity,
} from "../helpers/hederaApp";

const CHAIN_ID = 5042002;
/** The Arc entry, in the form the route serves it: CAIP-2 chain, EIP-55 checksummed address —
 *  exactly what `cfg.identityRegistry` holds, because `env.ts` checksums every address it parses. */
const ARC_REGISTRY = `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}`;
/** The Hedera entry, checksummed to match. Chain id 296 is a literal here because it is Hedera
 *  testnet's, not ours. */
const HEDERA_REGISTRY = `eip155:296:${HEDERA_IDENTITY_REGISTRY}`;
const VERIFY_URL = `${METADATA_BASE}/verify/${PUBLIC_ID}`;
const PROFILE_URL = `${METADATA_BASE}/metadata/${PUBLIC_ID}/profile`;

/** The `cfg.hedera` block `HEDERA_ENABLED` produces. Presence is the whole gate for the profile
 *  route; `/verify`, which mounts on the same object, is what reads the price and the facilitator. */
const HEDERA = {
  cfg: {
    network: "testnet",
    facilitatorUrl: "https://f.test",
    mirrorUrl: "https://m.test",
    usdcTokenId: "0.0.429274",
    payToAccountId: "0.0.10412694",
    verifyPriceUsdc: "0.001",
    verifyPriceAtomic: 1000n,
  },
} as const;

/** The facilitator's `/supported`, in Blocky402's shape. Wiring `hedera` mounts `/verify` beside
 *  the profile, and that fetches this once in the background at mount time — stubbed so this file
 *  never reaches the network. */
const SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: "hedera:testnet",
      extra: { feePayer: "0.0.7162784" },
    },
  ],
  extensions: [],
  signers: { "hedera:*": ["0.0.7162784"] },
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;

/** Seed the demo entity with the overrides a test cares about, and the stored JSON translate wrote. */
function seed(over: Partial<EntityRecord> = {}): EntityRecord {
  const rec = entity(over);
  repo.upsert(rec);
  docStore.put(
    `meta-${rec.idempotencyKey}.json`,
    JSON.stringify({ name: rec.name, legalBody: { jurisdiction: "WY" } }),
  );
  return rec;
}

/** The app the two public routes are served from. `ens` absent unless a test asks for it — the
 *  whole point of the ungating is that `registrations[]` no longer waits on it. */
/** A PUBLISHED TEST VECTOR (Anvil's account 1), for the deployment that holds an attestation
 *  key. A real `NOVI_ATTESTATION_KEY` comes from 1Password and never from a file. */
const ATTESTATION_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ATTESTOR = privateKeyToAccount(ATTESTATION_KEY).address;

function app(
  o: {
    ens?: boolean;
    legalBody?: boolean;
    hedera?: boolean;
    attestationKey?: Hex;
    /** A DISTINCT `PUBLIC_API_URL`, i.e. the prod shape: metadata links on the www proxy, paid
     *  links on the API's own origin. Absent -> both bases are the metadata one, as before. */
    publicApiBase?: string;
  } = {},
) {
  return buildApiApp({
    webOrigin: WEB,
    jwtSecret: "s",
    chainId: CHAIN_ID,
    identityRegistry: IDENTITY_REGISTRY,
    repo,
    docStore,
    now: () => 1_789_100_000_000,
    // On unless a test turns it off — `HEDERA_ENABLED` off is the exception this file tests, not
    // the state the rest of it runs in.
    hedera:
      o.hedera === false
        ? undefined
        : o.attestationKey
          ? { cfg: { ...HEDERA.cfg, attestationKey: o.attestationKey } }
          : HEDERA,
    legalBody:
      o.legalBody === false
        ? undefined
        : {
            resolver: { resolve: async () => ({ kind: "none" }) },
            chainReads: arcReads(),
            readBudget: new TokenBucket(30, 1),
            links: {
              transparency: `${WEB}/transparency`,
              metadataBase: METADATA_BASE,
              ...(o.publicApiBase ? { publicApiBase: o.publicApiBase } : {}),
            },
            network: "testnet" as const,
          },
    ens: o.ens
      ? {
          parentName: "novicorpus.eth",
          chainId: CHAIN_ID,
          identityRegistry: IDENTITY_REGISTRY,
          metadataBaseUrl: METADATA_BASE,
        }
      : undefined,
  } as never);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(SUPPORTED), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "profile-")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

// ── /metadata/:publicId — registrations[], ungated from ENS ───────────────────────────────────

test("registrations carries the HEDERA entry with NO ENS configured", async () => {
  seed({ agentId: null, hederaAgentId: "12" });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.registrations).toEqual([{ agentId: "12", agentRegistry: HEDERA_REGISTRY }]);
  // The ENS name is still gated on the gateway being wired: it is ENS's half, not ERC-8004's.
  expect(body).not.toHaveProperty("ens");
});

test("registrations carries the ARC entry with NO ENS configured", async () => {
  seed({ hederaAgentId: null });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.registrations).toEqual([{ agentId: "886257", agentRegistry: ARC_REGISTRY }]);
});

test("both registrations, Arc FIRST — the order is the home chain then the rail", async () => {
  seed({ hederaAgentId: "12" });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.registrations).toEqual([
    { agentId: "886257", agentRegistry: ARC_REGISTRY },
    { agentId: "12", agentRegistry: HEDERA_REGISTRY },
  ]);
});

test("an entity registered on neither chain gets NO registrations array invented for it", async () => {
  seed({ agentId: null, hederaAgentId: null });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body).not.toHaveProperty("registrations");
});

test("the ENS name still appears when the gateway IS wired, beside both registrations", async () => {
  seed({ hederaAgentId: "12" });
  const body = await (await app({ ens: true }).request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.ens).toBe(`${PUBLIC_ID}.novicorpus.eth`);
  expect(body.registrations).toHaveLength(2);
});

// ── /metadata/:publicId — uaid and the hedera block ───────────────────────────────────────────

test("uaid appears only when the column is written", async () => {
  seed();
  expect(await (await app().request(`/metadata/${PUBLIC_ID}`)).json()).not.toHaveProperty("uaid");
  seed({ uaid: "uaid:aid:abc;uid=886257" });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.uaid).toBe("uaid:aid:abc;uid=886257");
});

test("the hedera block appears only once an account is LINKED, and its urls are the metadata base's", async () => {
  seed();
  expect(await (await app().request(`/metadata/${PUBLIC_ID}`)).json()).not.toHaveProperty("hedera");
  seed({ hederaAccountId: "0.0.10412694" });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  // The demo buyer reads exactly these two urls off this block (plan task 15). No `attestor`:
  // this deployment holds no attestation key, and an empty field would claim one exists.
  expect(body.hedera).toEqual({
    accountId: "0.0.10412694",
    verifyUrl: VERIFY_URL,
    profileUrl: PROFILE_URL,
  });
});

test("with a distinct PUBLIC_API_URL the PAID url moves to it and the free one does not", async () => {
  // Prod's shape: metadata lives on the www/backend proxy, which forwards no x402 header — a
  // `verifyUrl` there answers 402 with an empty body, so the paid link must name the API itself.
  const publicApiBase = "https://api.example.test";
  seed({ hederaAccountId: "0.0.10412694" });
  const body = await (await app({ publicApiBase }).request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.hedera).toEqual({
    accountId: "0.0.10412694",
    verifyUrl: `${publicApiBase}/verify/${PUBLIC_ID}`,
    // The profile stays on the metadata base: it is free, it crosses the proxy intact, and the
    // float account's on-chain `hcs-11:` memo already points at that url.
    profileUrl: PROFILE_URL,
  });
});

test("the hedera block carries registerTx once the Hedera registration is recorded", async () => {
  seed({ hederaAccountId: "0.0.10412694" });
  expect((await (await app().request(`/metadata/${PUBLIC_ID}`)).json()).hedera).not.toHaveProperty(
    "registerTx",
  );
  const tx = "0xc5389a0a6f38fdecb6792c0b07442026f86e3d710168c6ae108ecf855c521eb7";
  seed({ hederaAccountId: "0.0.10412694", hederaAgentId: "113", hederaRegisterTx: tx });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body.hedera).toEqual({
    accountId: "0.0.10412694",
    verifyUrl: VERIFY_URL,
    profileUrl: PROFILE_URL,
    registerTx: tx,
  });
});

test("the attestor address is published on the FREE surface once a key is configured (task 13)", async () => {
  seed({ hederaAccountId: "0.0.10412694" });
  const body = await (
    await app({ attestationKey: ATTESTATION_KEY }).request(`/metadata/${PUBLIC_ID}`)
  ).json();
  // The key a verifier checks the PAID document's signature against, served where it costs
  // nothing — reading the attestor out of the signed body alone would accept any signer.
  expect(body.hedera).toEqual({
    accountId: "0.0.10412694",
    verifyUrl: VERIFY_URL,
    profileUrl: PROFILE_URL,
    attestor: ATTESTOR,
  });
});

test("no legal-body links wired: no hedera block rather than a url built from nothing", async () => {
  seed({ hederaAccountId: "0.0.10412694" });
  const body = await (await app({ legalBody: false }).request(`/metadata/${PUBLIC_ID}`)).json();
  expect(body).not.toHaveProperty("hedera");
});

// ── /metadata/:publicId/profile — the HCS-11 document ─────────────────────────────────────────

test("the profile is public, unauthenticated, and cached exactly like the metadata route", async () => {
  seed({ uaid: "uaid:aid:abc;uid=886257", hederaAgentId: "12" });
  const res = await app().request(`/metadata/${PUBLIC_ID}/profile`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("the profile document has the HCS-11 shape, and carries both registrations", async () => {
  seed({ uaid: "uaid:aid:abc;uid=886257", hederaAgentId: "12", oaHash: "0xv2hash" });
  const body = await (await app().request(`/metadata/${PUBLIC_ID}/profile`)).json();
  expect(body).toEqual({
    version: "1.0",
    type: 1,
    display_name: "FormationE2E_1",
    uaid: "uaid:aid:abc;uid=886257",
    aiAgent: { type: 1, capabilities: [], model: "novi-corpus-legal-body" },
    properties: {
      description: "a registered legal body; check standing at verifyUrl",
      legalBody: {
        agentId: "886257",
        treasury: TREASURY,
        oaHash: "0xv2hash",
        manifestVersion: null,
      },
      verifyUrl: VERIFY_URL,
      metadataUrl: `${METADATA_BASE}/metadata/${PUBLIC_ID}`,
      registrations: [
        { agentId: "886257", agentRegistry: ARC_REGISTRY },
        { agentId: "12", agentRegistry: HEDERA_REGISTRY },
      ],
    },
  });
});

test("the profile never STATES standing — it is a static document and standing is live", async () => {
  seed({ uaid: "uaid:aid:abc;uid=886257" });
  const res = await app().request(`/metadata/${PUBLIC_ID}/profile`);
  expect(res.status).toBe(200);
  const body = await res.json();
  // Not at any level. A document cached for five minutes cannot carry a fact that changes the
  // moment a guardian suspends the body; it points at /verify, which reads the chain per request.
  expect(body).not.toHaveProperty("standing");
  expect(body.properties).not.toHaveProperty("standing");
  expect(body.properties.legalBody).not.toHaveProperty("standing");
  expect(body.properties.description).toBe("a registered legal body; check standing at verifyUrl");
  // The claims ceiling (D9): "a registered legal body", never "verified", never "KYC'd".
  const text = JSON.stringify(body);
  expect(text).not.toContain("verified");
  expect(text).not.toContain("KYC");
});

test("an entity with no uaid has no profile to serve — 404, not an empty document", async () => {
  seed();
  expect((await app().request(`/metadata/${PUBLIC_ID}/profile`)).status).toBe(404);
});

test("unknown and malformed ids both 404, as on the metadata route", async () => {
  seed({ uaid: "uaid:aid:abc;uid=886257" });
  expect(
    (await app().request("/metadata/33333333-3333-3333-3333-333333333333/profile")).status,
  ).toBe(404);
  expect((await app().request("/metadata/not-a-uuid/profile")).status).toBe(404);
});

test("no legal-body links wired: the profile's urls are null rather than invented", async () => {
  seed({ uaid: "uaid:aid:abc;uid=886257" });
  const body = await (
    await app({ legalBody: false }).request(`/metadata/${PUBLIC_ID}/profile`)
  ).json();
  expect(body.properties.verifyUrl).toBeNull();
  expect(body.properties.metadataUrl).toBeNull();
});

// ── the flag ─────────────────────────────────────────────────────────────────────────────────

test("with the Hedera flag off the profile route is not mounted", async () => {
  // A row that WOULD serve a profile: registered, with a uaid. The flag is the only thing missing.
  seed({ uaid: "uaid:aid:abc;uid=886257", hederaAgentId: "12" });
  expect((await app({ hedera: false }).request(`/metadata/${PUBLIC_ID}/profile`)).status).toBe(404);
  // And the metadata beside it still serves, unchanged: the flag takes the rail, not the route.
  expect((await app({ hedera: false }).request(`/metadata/${PUBLIC_ID}`)).status).toBe(200);
});

test("the hedera block is absent with the flag off, even for a LINKED row", async () => {
  // `registerTx` is seeded so the absence assertion below covers it literally rather than by
  // implication. `attestor` cannot be seeded beside it: the attestation key lives INSIDE the
  // hedera config block (`env.ts`: `HEDERA_ENABLED` off produces no block at all), so "flag off
  // with a key configured" is not a state this deployment can be in.
  seed({
    hederaAccountId: "0.0.10412694",
    uaid: "uaid:aid:abc;uid=886257",
    hederaAgentId: "12",
    hederaRegisterTx: "0xc5389a0a6f38fdecb6792c0b07442026f86e3d710168c6ae108ecf855c521eb7",
  });
  const body = await (await app({ hedera: false }).request(`/metadata/${PUBLIC_ID}`)).json();
  // Neither url is published, because neither route is mounted to answer it.
  expect(body).not.toHaveProperty("hedera");
  // The identity facts are NOT flag-gated: they are true of the company either way.
  expect(body.uaid).toBe("uaid:aid:abc;uid=886257");
  expect(body.registrations).toEqual([
    { agentId: "886257", agentRegistry: ARC_REGISTRY },
    { agentId: "12", agentRegistry: HEDERA_REGISTRY },
  ]);
});
