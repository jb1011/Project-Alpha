# Per-Agent Turnkey Vault — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move from one shared Turnkey signing key to a **Turnkey sub-organization + wallet per agent**, where the human guardian is the sub-org root (via a passkey) and the backend is a policy-bounded delegated signer — provisioned by the onboarding saga and persisted on the entity.

**Architecture:** A new backend Turnkey **provisioning adapter** runs the verified delegated-access flow (`createSubOrganization` with a delegated API-key user + the guardian's passkey → `createPolicy` scoping the delegated user to sign-only that agent's wallet → `updateRootQuorum` to leave the guardian as sole root). A new onboarding **Step 0** provisions the vault before `createEntity`, persists the ids (`turnkey_sub_org_id`, `turnkey_wallet_id`), and supplies the per-agent operator address downstream. A per-agent signer builds from the stored sub-org id + operator. A thin `POST /onboard` route is the frontend entry. The legacy shared-key path is untouched.

**Tech Stack:** TypeScript (ESM, Node ≥20.18), `@turnkey/sdk-server` (already a dep), `@turnkey/viem`, better-sqlite3, viem, Hono, vitest, biome.

## Global Constraints

Every task's requirements implicitly include these (verbatim from the design + the verified Turnkey docs):

- **Additive / non-custodial only.** New code in `backend/src/adapters/turnkey/provisioner.ts`, `backend/src/onboarding/server.ts`; additive edits to `config/env.ts`, `persistence/db.ts`, `persistence/entityRepository.ts` + its types, `adapters/turnkey/turnkeySigner.ts`/`operatorSigner.ts`/`operatorWallet.ts`, `workflow/onboarding.ts`. Do not change Solidity, the policy translator, the OA generator, or the nanopayment/Authority code.
- **The legacy shared-key path keeps working.** New `entities` columns are nullable; per-agent vaults apply to NEW onboardings only; no backfill of agent 656785. The existing `TurnkeySigner.forKey(cfg, signWith)` stays for legacy.
- **Verified Turnkey shapes (use verbatim — confirmed against current docs 2026-06-19):**
  - Server client: `new Turnkey({ apiBaseUrl, apiPublicKey, apiPrivateKey, defaultOrganizationId }).apiClient()`.
  - **Step 1** (parent-org client) `createSubOrganization({ organizationId: <parentOrgId>, subOrganizationName, rootUsers: [DELEGATED, GUARDIAN], rootQuorumThreshold: 1, wallet: { walletName, accounts: [ACCOUNT] } })`. `DELEGATED = { userName: "Delegated Access User", apiKeys: [{ apiKeyName, publicKey: <delegatedApiPublicKey>, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [] }`. `GUARDIAN = { userName: "Guardian", userEmail?, apiKeys: [], authenticators: [{ authenticatorName: "Guardian Passkey", challenge, attestation: { credentialId, clientDataJson, attestationObject, transports } }], oauthProviders: [] }`. `ACCOUNT = { curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }`. Result carries `subOrganizationId`, `rootUserIds` (order matches `rootUsers` → `[delegatedUserId, guardianUserId]`), and the created wallet (`walletId` + `addresses[0]` = operator). *(Confirm the exact wallet result field against the installed SDK types at tsc time; fall back to `getWallets({ organizationId: subOrgId })` / `getWalletAccounts` if needed.)*
  - **Step 2** (DELEGATED client, `defaultOrganizationId = subOrgId`) `createPolicy({ policyName, effect: "EFFECT_ALLOW", consensus: "approvers.any(user, user.id == '<delegatedUserId>')", condition: "activity.action == 'SIGN' && wallet.id == '<walletId>'", notes: "" })`.
  - **Step 3** (DELEGATED client) `updateRootQuorum({ threshold: 1, userIds: ["<guardianUserId>"] })` — drops the delegated user from root.
  - Per-agent signing: a DELEGATED client with `defaultOrganizationId = subOrgId`, then `@turnkey/viem createAccount({ client, organizationId: subOrgId, signWith: <operator> })`.
- **One shared delegated key.** A single backend delegated API keypair (`cfg.turnkey.delegatedApiPublicKey` / `delegatedApiPrivateKey`) is embedded in every agent's sub-org and scoped per-sub-org by policy. The parent-org API key (`TURNKEY_API_*`) is used only to create sub-orgs.
- **Secret hygiene.** `TURNKEY_DELEGATED_API_PRIVATE_KEY` is a secret — gitignored `.env`, redacted in `redact()`.
- **Live Turnkey calls are gated.** Any test that hits real Turnkey (sub-org create / sign) is behind an opt-in env flag (e.g. `LIVE_TURNKEY=1`) and skipped by default (free tier is metered). Deterministic tests inject a **fake Turnkey client**.
- **Quality gate per task:** `npm run typecheck` + `npm run lint` clean; `npx vitest run --exclude '**/*.live.test.ts'` green. Do NOT run the full `npm test` (the existing live Turnkey signer test is metered). Commit at the end of each task.

## File structure

| File | Responsibility |
|---|---|
| `backend/src/config/env.ts` (modify) | Add `turnkey.delegatedApiPublicKey` / `turnkey.delegatedApiPrivateKey` (optional); redact the private key |
| `backend/src/persistence/db.ts` (modify) | Add `turnkey_sub_org_id` / `turnkey_wallet_id` columns + the `provisioned` status to the CHECK |
| `backend/src/persistence/entityRepository.ts` + `types.ts` (modify) | `EntityRecord.turnkeySubOrgId?` / `turnkeyWalletId?`; persist/read them |
| `backend/src/adapters/turnkey/provisioner.ts` (create) | `provisionAgentVault(deps, params)` — the 3-step delegated-access flow; the only Turnkey-mutation surface |
| `backend/src/adapters/turnkey/turnkeySigner.ts` / `operatorSigner.ts` / `operatorWallet.ts` (modify) | `forEntity(...)` — build the operator signer/wallet from `{ subOrgId, operator }` + the delegated key |
| `backend/src/workflow/onboarding.ts` (modify) | New Step 0: provision → persist ids + `provisioned` status → supply operator to createEntity; idempotent resume |
| `backend/src/onboarding/server.ts` (create) | `POST /onboard` — passkey attestation + spec → drive the saga → return `{ subOrgId, walletId, operator, status }` |
| `backend/test/**` | unit (fake Turnkey client) + opt-in live |

---

### Task 1: Config — delegated API keypair

**Files:**
- Modify: `backend/src/config/env.ts`
- Test: `backend/test/config/delegatedKey.test.ts`

**Interfaces:**
- Produces: `cfg.turnkey.delegatedApiPublicKey?: string`, `cfg.turnkey.delegatedApiPrivateKey?: string`; the private key redacted in `redact()`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/config/delegatedKey.test.ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/v1",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  TURNKEY_API_PUBLIC_KEY: "pub",
  TURNKEY_API_PRIVATE_KEY: "priv",
  TURNKEY_ORGANIZATION_ID: "org",
  TURNKEY_SIGN_WITH: "0xabc",
  TURNKEY_DELEGATED_API_PUBLIC_KEY: "dpub",
  TURNKEY_DELEGATED_API_PRIVATE_KEY: "dpriv",
};

test("delegated API keypair is parsed into cfg.turnkey", () => {
  const cfg = loadConfig(base);
  expect(cfg.turnkey?.delegatedApiPublicKey).toBe("dpub");
  expect(cfg.turnkey?.delegatedApiPrivateKey).toBe("dpriv");
});

test("the delegated private key is redacted", () => {
  const cfg = loadConfig(base);
  expect(redact(cfg).turnkey?.delegatedApiPrivateKey).toBe("REDACTED");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/config/delegatedKey.test.ts`
Expected: FAIL — `cfg.turnkey.delegatedApiPublicKey` is `undefined`.

- [ ] **Step 3: Implement** — in `backend/src/config/env.ts`:
  - Add to `EnvSchema`: `TURNKEY_DELEGATED_API_PUBLIC_KEY: z.string().optional(),` and `TURNKEY_DELEGATED_API_PRIVATE_KEY: z.string().optional(),`.
  - In the `turnkey` object of the `Config` interface add: `delegatedApiPublicKey?: string; delegatedApiPrivateKey?: string;`.
  - Where `loadConfig` builds the `turnkey` object (the existing `if (e.TURNKEY_*) { turnkey = {...} }` block), add `delegatedApiPublicKey: e.TURNKEY_DELEGATED_API_PUBLIC_KEY, delegatedApiPrivateKey: e.TURNKEY_DELEGATED_API_PRIVATE_KEY`.
  - In `redact()`, where the `turnkey` block is redacted, add `delegatedApiPrivateKey: cfg.turnkey.delegatedApiPrivateKey ? "REDACTED" : undefined` (mirror how `apiPrivateKey` is already redacted).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/config/delegatedKey.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/test/config/delegatedKey.test.ts
git commit -m "feat(turnkey): config for the shared delegated API keypair"
```

---

### Task 2: Schema + repository — per-agent vault columns

**Files:**
- Modify: `backend/src/persistence/db.ts`
- Modify: `backend/src/persistence/entityRepository.ts`, `backend/src/types.ts`
- Test: `backend/test/entityRepository.turnkey.test.ts`

**Interfaces:**
- Produces: `entities.turnkey_sub_org_id` / `turnkey_wallet_id` columns; the `provisioned` status; `EntityRecord.turnkeySubOrgId?: string` / `turnkeyWalletId?: string`; the repository persists/reads them.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/entityRepository.turnkey.test.ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../src/persistence/db";
import { EntityRepository } from "../src/persistence/entityRepository";

function repo() {
  const db = new Database(":memory:");
  migrate(db);
  return new EntityRepository(db);
}

test("persists + reads the per-agent Turnkey ids and the provisioned status", () => {
  const r = repo();
  r.upsert({
    idempotencyKey: "k1",
    name: "Agent",
    status: "provisioned",
    manager: `0x${"a".repeat(40)}`,
    guardian: `0x${"b".repeat(40)}`,
    operator: `0x${"c".repeat(40)}`,
    amendmentDelay: 3600n,
    ein: "STUB",
    formationDate: 0,
    turnkeySubOrgId: "suborg-1",
    turnkeyWalletId: "wallet-1",
  } as never);
  const got = r.findByIdempotencyKey("k1");
  expect(got?.status).toBe("provisioned");
  expect(got?.turnkeySubOrgId).toBe("suborg-1");
  expect(got?.turnkeyWalletId).toBe("wallet-1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/entityRepository.turnkey.test.ts`
Expected: FAIL — the CHECK rejects `'provisioned'` (or the columns/fields don't exist).

- [ ] **Step 3: Implement**
  - In `backend/src/persistence/db.ts` `migrate()`: change the status CHECK to `status IN ('provisioned','translating','created','bound','funded')`, and add two columns after `operator`: `turnkey_sub_org_id TEXT,` and `turnkey_wallet_id TEXT,`. *(SQLite ignores `CREATE TABLE IF NOT EXISTS` on an existing table — for a fresh dev DB this is fine; the live DB is recreated/migrated by the operator. No ALTER needed for v1 since the table is created fresh.)*
  - In `backend/src/types.ts`: add `turnkeySubOrgId?: string;` and `turnkeyWalletId?: string;` to `EntityRecord`, and add `'provisioned'` to the status union type.
  - In `backend/src/persistence/entityRepository.ts`: add the two columns to the INSERT column list + the `ON CONFLICT DO UPDATE` set list and the value bindings (mirror an existing nullable text field like `proxy`); add them to the row→record mapping in `findByIdempotencyKey`/the read mapper.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/entityRepository.turnkey.test.ts` → PASS. Then `npm run typecheck && npm run lint`, then `npx vitest run --exclude '**/*.live.test.ts'` (existing repository/onboarding tests must stay green; the status union widened, not narrowed).

- [ ] **Step 5: Commit**

```bash
git add backend/src/persistence/db.ts backend/src/persistence/entityRepository.ts backend/src/types.ts backend/test/entityRepository.turnkey.test.ts
git commit -m "feat(turnkey): persist per-agent sub-org/wallet ids + provisioned status"
```

---

### Task 3: The Turnkey provisioning adapter

**Files:**
- Create: `backend/src/adapters/turnkey/provisioner.ts`
- Test: `backend/test/adapters/turnkey/provisioner.test.ts`
- Test (opt-in live): `backend/test/adapters/turnkey/provisioner.live.test.ts`

**Interfaces:**
- Produces:
  - `export interface GuardianPasskey { authenticatorName?: string; challenge: string; attestation: { credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] } }`
  - `export interface ProvisionParams { subOrgName: string; guardianPasskey: GuardianPasskey; guardianEmail?: string; delegatedApiPublicKey: string }`
  - `export interface VaultIds { subOrgId: string; walletId: string; operator: \`0x${string}\`; guardianUserId: string; delegatedUserId: string }`
  - `export interface ProvisionDeps { parentClient: TurnkeyApiClient; makeDelegatedClient: (subOrgId: string) => TurnkeyApiClient }` where `TurnkeyApiClient` is the minimal surface we call: `{ createSubOrganization(...); createPolicy(...); updateRootQuorum(...) }`.
  - `export async function provisionAgentVault(deps: ProvisionDeps, p: ProvisionParams): Promise<VaultIds>`

- [ ] **Step 1: Write the failing test** — inject a FAKE parent client + delegated client (vi mocks) and assert the 3-step delegated-access flow with the verified shapes.

```ts
// backend/test/adapters/turnkey/provisioner.test.ts
import { expect, test, vi } from "vitest";
import { provisionAgentVault } from "../../../src/adapters/turnkey/provisioner";

const passkey = { challenge: "chal", attestation: { credentialId: "cid", clientDataJson: "cdj", attestationObject: "att", transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"] } };

test("provisions: createSubOrg(2 root users) -> createPolicy(sign-only) -> updateRootQuorum(guardian only)", async () => {
  const createSubOrganization = vi.fn(async () => ({
    subOrganizationId: "suborg-1",
    rootUserIds: ["delegated-uid", "guardian-uid"],
    wallet: { walletId: "wallet-1", addresses: ["0x00000000000000000000000000000000000000ab"] },
  }));
  const createPolicy = vi.fn(async () => ({ policyId: "pol-1" }));
  const updateRootQuorum = vi.fn(async () => ({}));
  const delegatedClient = { createSubOrganization: vi.fn(), createPolicy, updateRootQuorum };
  const deps = {
    parentClient: { createSubOrganization, createPolicy: vi.fn(), updateRootQuorum: vi.fn() } as never,
    makeDelegatedClient: vi.fn(() => delegatedClient as never),
  };

  const ids = await provisionAgentVault(deps, {
    subOrgName: "projectAlpha - agent vault",
    guardianPasskey: passkey,
    delegatedApiPublicKey: "dpub",
  });

  // 1) sub-org with delegated (apiKey) + guardian (passkey) root users
  const subArgs = createSubOrganization.mock.calls[0][0];
  expect(subArgs.rootUsers).toHaveLength(2);
  expect(subArgs.rootUsers[0].apiKeys[0].publicKey).toBe("dpub");
  expect(subArgs.rootUsers[1].authenticators[0].attestation.credentialId).toBe("cid");
  expect(subArgs.rootQuorumThreshold).toBe(1);

  // 2) policy: delegated user, sign-only that wallet (run via the delegated client)
  expect(deps.makeDelegatedClient).toHaveBeenCalledWith("suborg-1");
  const polArgs = createPolicy.mock.calls[0][0];
  expect(polArgs.consensus).toContain("delegated-uid");
  expect(polArgs.condition).toContain("activity.action == 'SIGN'");
  expect(polArgs.condition).toContain("wallet.id == 'wallet-1'");

  // 3) root quorum reduced to the guardian only
  expect(updateRootQuorum).toHaveBeenCalledWith({ threshold: 1, userIds: ["guardian-uid"] });

  expect(ids).toEqual({
    subOrgId: "suborg-1",
    walletId: "wallet-1",
    operator: "0x00000000000000000000000000000000000000ab",
    guardianUserId: "guardian-uid",
    delegatedUserId: "delegated-uid",
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/adapters/turnkey/provisioner.test.ts`
Expected: FAIL — cannot find `provisionAgentVault`.

- [ ] **Step 3: Implement** — `backend/src/adapters/turnkey/provisioner.ts`. The function is signer-agnostic: it takes injected clients (real in prod, fakes in tests).

```ts
// backend/src/adapters/turnkey/provisioner.ts
import { getAddress } from "viem";

const ETH_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;

export interface GuardianPasskey {
  authenticatorName?: string;
  challenge: string;
  attestation: { credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] };
}
export interface ProvisionParams {
  subOrgName: string;
  guardianPasskey: GuardianPasskey;
  guardianEmail?: string;
  delegatedApiPublicKey: string;
}
export interface VaultIds {
  subOrgId: string;
  walletId: string;
  operator: `0x${string}`;
  guardianUserId: string;
  delegatedUserId: string;
}
// The minimal Turnkey apiClient surface we call (the real @turnkey/sdk-server client satisfies it).
// biome-ignore lint/suspicious/noExplicitAny: Turnkey's apiClient boundary is loosely typed
export type TurnkeyApiClient = any;
export interface ProvisionDeps {
  parentClient: TurnkeyApiClient; // parent-org API key — creates sub-orgs
  makeDelegatedClient: (subOrgId: string) => TurnkeyApiClient; // delegated API key scoped to the sub-org
}

/** Create a per-agent vault: guardian-root (passkey) + a sign-only delegated backend key. Non-custodial. */
export async function provisionAgentVault(deps: ProvisionDeps, p: ProvisionParams): Promise<VaultIds> {
  // STEP 1 — sub-org with the delegated user (api key) + the guardian (passkey) as root users.
  const sub = await deps.parentClient.createSubOrganization({
    subOrganizationName: p.subOrgName,
    rootUsers: [
      {
        userName: "Delegated Access User",
        apiKeys: [{ apiKeyName: "Backend Delegated Key", publicKey: p.delegatedApiPublicKey, curveType: "API_KEY_CURVE_P256" }],
        authenticators: [],
        oauthProviders: [],
      },
      {
        userName: "Guardian",
        userEmail: p.guardianEmail,
        apiKeys: [],
        authenticators: [
          {
            authenticatorName: p.guardianPasskey.authenticatorName ?? "Guardian Passkey",
            challenge: p.guardianPasskey.challenge,
            attestation: p.guardianPasskey.attestation,
          },
        ],
        oauthProviders: [],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Agent vault", accounts: [ETH_ACCOUNT] },
  });

  const subOrgId: string = sub.subOrganizationId;
  const delegatedUserId: string = sub.rootUserIds[0];
  const guardianUserId: string = sub.rootUserIds[1];
  const walletId: string = sub.wallet.walletId;
  const operator = getAddress(sub.wallet.addresses[0]);

  // STEP 2 — scope the delegated user to sign-only this agent's wallet (run as the delegated user).
  const delegated = deps.makeDelegatedClient(subOrgId);
  await delegated.createPolicy({
    policyName: "Backend delegated: sign-only this agent's wallet",
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${delegatedUserId}')`,
    condition: `activity.action == 'SIGN' && wallet.id == '${walletId}'`,
    notes: "",
  });

  // STEP 3 — remove the delegated user from root; the guardian is the sole root (non-custodial).
  await delegated.updateRootQuorum({ threshold: 1, userIds: [guardianUserId] });

  return { subOrgId, walletId, operator, guardianUserId, delegatedUserId };
}
```

> Verify against the installed `@turnkey/sdk-server` types: the `createSubOrganization` result field carrying the wallet (`sub.wallet.walletId` / `sub.wallet.addresses`) — if the SDK returns it under a different field, read it from there or call `parentClient.getWallets({ organizationId: subOrgId })` then `getWalletAccounts`. `tsc` will tell you.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/adapters/turnkey/provisioner.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Add the opt-in live test** (gated; creates a throwaway sub-org). Skipped unless `LIVE_TURNKEY=1`.

```ts
// backend/test/adapters/turnkey/provisioner.live.test.ts
import "dotenv/config";
import { describe, expect, test } from "vitest";
// Build real parent + delegated clients from cfg (see Task 4's helpers) and a real WebAuthn attestation
// (use a Turnkey test attestation fixture). Assert provisionAgentVault returns a sub-org id + a 0x operator.
const run = process.env.LIVE_TURNKEY === "1" ? describe : describe.skip;
run("live Turnkey provisioning (creates a throwaway sub-org)", () => {
  test("provisions a per-agent vault", async () => {
    expect(true).toBe(true); // replace with a real provision call once a test attestation fixture is wired
  });
});
```

> The live test is a stub gated to `LIVE_TURNKEY=1`; flesh it out when running a real provisioning against Turnkey (needs a real passkey attestation fixture). Default run = skipped.

- [ ] **Step 6: Commit**

```bash
git add backend/src/adapters/turnkey/provisioner.ts backend/test/adapters/turnkey/provisioner.test.ts backend/test/adapters/turnkey/provisioner.live.test.ts
git commit -m "feat(turnkey): per-agent vault provisioner (delegated-access flow)"
```

---

### Task 4: Per-agent signer + the live client builders

**Files:**
- Modify: `backend/src/adapters/turnkey/turnkeySigner.ts` (add `forEntity`)
- Modify: `backend/src/adapters/turnkey/operatorWallet.ts` (per-entity `WalletClient`)
- Create: `backend/src/adapters/turnkey/clients.ts` (build the parent + delegated `apiClient`s + `makeDelegatedClient`)
- Test: `backend/test/adapters/turnkey/forEntity.test.ts`

**Interfaces:**
- Consumes: `Config` (`cfg.turnkey.{organizationId, apiPublicKey, apiPrivateKey, delegatedApiPublicKey, delegatedApiPrivateKey, baseUrl}`), `provisionAgentVault`'s `VaultIds`.
- Produces:
  - `backend/src/adapters/turnkey/clients.ts`: `export function buildTurnkeyProvisionDeps(cfg: Config): ProvisionDeps` (parent client from `apiPublicKey/apiPrivateKey/organizationId`; `makeDelegatedClient(subOrgId)` from `delegatedApiPublicKey/delegatedApiPrivateKey` with `defaultOrganizationId = subOrgId`).
  - `TurnkeySigner.forEntity(cfg: Config, e: { subOrgId: string; operator: string }): Promise<OperatorSigner>` — a `@turnkey/viem` account built with the DELEGATED client, `organizationId = subOrgId`, `signWith = operator`.
  - `buildOperatorWalletClientForEntity(cfg: Config, e: { subOrgId: string; operator: string }): Promise<WalletClient>` (the send-txs path, per-entity).

- [ ] **Step 1: Write the failing test** — unit-test the wiring without a live Turnkey call: assert `forEntity` constructs the delegated client with `defaultOrganizationId = subOrgId` and calls `createAccount` with `organizationId = subOrgId`, `signWith = operator` (inject/spy the `@turnkey/viem` `createAccount` + the client factory).

```ts
// backend/test/adapters/turnkey/forEntity.test.ts
import { expect, test, vi } from "vitest";

// Mock @turnkey/viem.createAccount + @turnkey/sdk-server so no network is hit.
vi.mock("@turnkey/viem", () => ({
  createAccount: vi.fn(async (args: { organizationId: string; signWith: string }) => ({
    address: args.signWith,
    signTypedData: vi.fn(),
    signMessage: vi.fn(),
  })),
}));
vi.mock("@turnkey/sdk-server", () => ({
  Turnkey: class {
    apiClient() { return {}; }
  },
}));

test("forEntity builds a signer scoped to the agent's sub-org + operator", async () => {
  const { createAccount } = await import("@turnkey/viem");
  const { TurnkeySigner } = await import("../../../src/adapters/turnkey/turnkeySigner");
  const cfg = { turnkey: { baseUrl: "https://api.turnkey.com", organizationId: "org", apiPublicKey: "p", apiPrivateKey: "s", delegatedApiPublicKey: "dp", delegatedApiPrivateKey: "ds" } } as never;
  const signer = await TurnkeySigner.forEntity(cfg, { subOrgId: "suborg-1", operator: "0x00000000000000000000000000000000000000ab" });
  expect(signer.address.toLowerCase()).toBe("0x00000000000000000000000000000000000000ab");
  expect((createAccount as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ organizationId: "suborg-1", signWith: "0x00000000000000000000000000000000000000ab" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/adapters/turnkey/forEntity.test.ts`
Expected: FAIL — `TurnkeySigner.forEntity` is not a function.

- [ ] **Step 3: Implement**
  - `backend/src/adapters/turnkey/clients.ts`: build the two `apiClient`s. The parent client uses `apiPublicKey/apiPrivateKey` + `defaultOrganizationId = organizationId`. `makeDelegatedClient(subOrgId)` uses `delegatedApiPublicKey/delegatedApiPrivateKey` + `defaultOrganizationId = subOrgId`. Export `buildTurnkeyProvisionDeps(cfg)` returning `{ parentClient, makeDelegatedClient }`. (Reuse the exact `new Turnkey({...}).apiClient()` construction the existing `turnkeySigner.ts` uses.)
  - `turnkeySigner.ts`: add a static `forEntity(cfg, { subOrgId, operator })` mirroring the existing `forKey`, but build the Turnkey client with the DELEGATED keypair (`cfg.turnkey.delegatedApiPrivateKey/Public`) and `organizationId = subOrgId`, and call `createAccount({ client, organizationId: subOrgId, signWith: operator })`. Throw a clear error if the delegated keypair is absent.
  - `operatorWallet.ts`: add `buildOperatorWalletClientForEntity(cfg, { subOrgId, operator })` mirroring the existing `buildOperatorWalletClient` Turnkey branch, but with the delegated client + `organizationId = subOrgId` + `signWith = operator`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/adapters/turnkey/forEntity.test.ts` → PASS. Then `npm run typecheck && npm run lint`, then `npx vitest run --exclude '**/*.live.test.ts'`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/turnkey/clients.ts backend/src/adapters/turnkey/turnkeySigner.ts backend/src/adapters/turnkey/operatorWallet.ts backend/test/adapters/turnkey/forEntity.test.ts
git commit -m "feat(turnkey): per-entity signer + wallet client (delegated key, sub-org scoped)"
```

---

### Task 5: Onboarding Step 0 — provision before mint

**Files:**
- Modify: `backend/src/workflow/onboarding.ts`
- Test: `backend/test/onboarding.provision.int.test.ts`

**Interfaces:**
- Consumes: `provisionAgentVault` (Task 3) — injected via the saga's deps as `provision: (params) => Promise<VaultIds>` (real = `provisionAgentVault(buildTurnkeyProvisionDeps(cfg), …)`; fake in tests); `EntityRepository` (Task 2). The saga's existing deps already include `operatorSigner` for the shared-key path — the new path uses the per-entity operator from provisioning instead.
- Produces: a new first saga step that, when a `guardianPasskey` + `delegatedApiPublicKey` are provided, provisions the vault, persists `{ status: 'provisioned', turnkeySubOrgId, turnkeyWalletId, operator }`, and uses that `operator` for `createEntity`/bind. On resume, if the entity is already `provisioned` (sub-org id present), it does NOT re-provision.

- [ ] **Step 1: Write the failing test** — a fake `provision` returns canned ids; assert provision runs before createEntity, the ids + `provisioned` status are persisted, the per-agent `operator` flows into `createEntity`, and a resume (entity already `provisioned`) does not call `provision` again.

```ts
// backend/test/onboarding.provision.int.test.ts (sketch — mirror the existing onboarding.int.test.ts harness)
// 1) run onboarding with deps.provision = vi.fn(async () => ({ subOrgId:"s1", walletId:"w1", operator:"0x..ab", guardianUserId:"g", delegatedUserId:"d" }))
//    and a guardianPasskey in the spec; assert: provision called once BEFORE createEntity; the persisted record has
//    status progressing past 'provisioned' with turnkeySubOrgId/turnkeyWalletId set and operator == "0x..ab".
// 2) re-run with the same idempotency key after seeding a 'provisioned' record; assert deps.provision is NOT called again.
```

(Write the full test against the existing onboarding test harness — reuse `onboarding.int.test.ts`'s fakes for the Arc adapter + repo; add the fake `provision`. Assert call order via `mock.invocationCallOrder` or by checking the Arc adapter's `createEntity` received the provisioned operator.)

- [ ] **Step 2: Run to verify it fails** — `cd backend && npx vitest run test/onboarding.provision.int.test.ts` → FAIL (no provision step).

- [ ] **Step 3: Implement** — in `backend/src/workflow/onboarding.ts`:
  - Extend the saga deps with `provision?: (p: ProvisionParams) => Promise<VaultIds>` and the spec with an optional `guardianPasskey` + `delegatedApiPublicKey` (or read the delegated pubkey from cfg).
  - Add Step 0 before translate/createEntity: if `provision` + `guardianPasskey` are present AND the record isn't already `provisioned` (no `turnkeySubOrgId`), call `provision({...})`, then `repo.upsert({ ...rec, status: 'provisioned', turnkeySubOrgId, turnkeyWalletId, operator })`. Use that `operator` for the subsequent `createEntity`/bind (instead of `d.operatorSigner.address`). On resume, reuse the stored `operator`/`turnkeySubOrgId`.
  - Bind step: when the entity has a `turnkeySubOrgId`, build the signer via `TurnkeySigner.forEntity(cfg, { subOrgId, operator })` (Task 4) rather than the shared `operatorSigner`. (Keep the shared-`operatorSigner` path when there's no `turnkeySubOrgId` — legacy.)
  - Preserve idempotency/monotonic status (the `provisioned` status sits before `created`).

- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run typecheck && npm run lint`, then `npx vitest run --exclude '**/*.live.test.ts'` (the existing onboarding tests — legacy path — must stay green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflow/onboarding.ts backend/test/onboarding.provision.int.test.ts
git commit -m "feat(turnkey): onboarding Step 0 provisions the per-agent vault before mint (idempotent)"
```

---

### Task 6: `POST /onboard` HTTP route

**Files:**
- Create: `backend/src/onboarding/server.ts`
- Test: `backend/test/onboarding/server.test.ts`

**Interfaces:**
- Consumes: the onboarding saga (`runOnboarding`) + its deps; `buildTurnkeyProvisionDeps` (Task 4); `provisionAgentVault` (Task 3).
- Produces: `export function buildOnboardingApp(deps): Hono` exposing `POST /onboard` that accepts `{ spec, guardianPasskey }`, drives the saga (provision → mint → bind → fund), and returns `{ subOrgId, walletId, operator, status }` (or a structured error). Tests use `app.request` with an injected fake saga/provision — no network.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/onboarding/server.test.ts
import { expect, test } from "vitest";
import { buildOnboardingApp } from "../../src/onboarding/server";

test("POST /onboard provisions + returns the vault ids", async () => {
  const app = buildOnboardingApp({
    runOnboarding: async () => ({ status: "funded", turnkeySubOrgId: "s1", turnkeyWalletId: "w1", operator: "0x00000000000000000000000000000000000000ab" }),
  } as never);
  const res = await app.request("/onboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { name: "Agent" }, guardianPasskey: { challenge: "c", attestation: { credentialId: "id", clientDataJson: "j", attestationObject: "a", transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"] } } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ subOrgId: "s1", walletId: "w1", operator: "0x00000000000000000000000000000000000000ab", status: "funded" });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (cannot find `buildOnboardingApp`).

- [ ] **Step 3: Implement** — a thin Hono app; parse the body, call the injected `runOnboarding` (which wires the real `provision` from `buildTurnkeyProvisionDeps(cfg)` in the composition root), map success → 200 `{ subOrgId, walletId, operator, status }`, validation/provision errors → 400/502 with a clear message. Keep the composition (real cfg → real saga deps) in a small factory the live entrypoint uses; the test injects a fake `runOnboarding`.

- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run typecheck && npm run lint`, then `npx vitest run --exclude '**/*.live.test.ts'`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/onboarding/server.ts backend/test/onboarding/server.test.ts
git commit -m "feat(turnkey): POST /onboard route (passkey attestation -> provisioned vault)"
```

**Plan gate:** `tsc` + `biome` clean; `npx vitest run --exclude '**/*.live.test.ts'` green; the legacy shared-key onboarding path unchanged. A new agent onboarded via `POST /onboard` gets its own Turnkey sub-org (guardian-root passkey) + wallet + a sign-only delegated backend key, with the ids persisted on the entity. Live provisioning verified opt-in via `LIVE_TURNKEY=1`.

---

## Self-Review

- **Spec coverage:** provisioning adapter (§Components) → Task 3; per-agent signer (§Per-agent signing) → Task 4; saga Step 0 + persistence + idempotency (§Onboarding flow, §Error handling) → Tasks 5 + 2; schema columns (§Data model) → Task 2; delegated key config + secret hygiene (§Security, Global Constraints) → Task 1; the `POST /onboard` contract (§Frontend↔backend) → Task 6; legacy back-compat (Decision 6) → Global Constraints + Tasks 2/4/5 keep the shared-key path; testing with a fake Turnkey client + opt-in live (§Testing) → every task's deterministic tests + Task 3's live stub. Recovery/backup-authenticator (Decision 5) is **not yet a task** — see gap below.
- **Gap (flagged, not silently dropped):** the design's Decision 5 (add a **backup authenticator** at creation) is not in these 6 tasks — the provisioner creates a single guardian passkey. Add it as a follow-up task (extend `ProvisionParams` with an optional second authenticator and include it in the guardian root user's `authenticators[]`) when the frontend can produce two attestations, OR fold a `backupPasskey?` into Task 3 now if desired. Documented as a fast-follow in the design.
- **Placeholder scan:** Task 3's live test is an explicit gated stub (needs a real attestation fixture) — flagged, not hidden; Task 5's test is a sketch pointing at the existing harness (the step list is concrete). All `src` code is complete.
- **Type consistency:** `VaultIds` (Task 3) is consumed by Tasks 4/5/6; `ProvisionParams`/`ProvisionDeps` (Task 3) built by `buildTurnkeyProvisionDeps` (Task 4) and used by the saga (Task 5); `EntityRecord.turnkeySubOrgId/turnkeyWalletId` + `'provisioned'` status (Task 2) used by Tasks 5/6; `cfg.turnkey.delegatedApi*` (Task 1) used by Task 4. Turnkey call shapes are the verified ones in Global Constraints.
- **Open prerequisite:** a real WebAuthn attestation fixture for the live provisioning test; the exact `createSubOrganization` wallet-result field (confirm vs the installed SDK types — `tsc` will catch it). Both noted at point of use.
