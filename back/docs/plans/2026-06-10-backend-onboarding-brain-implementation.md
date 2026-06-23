# Backend "Brain" — Onboarding Milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-agnostic TypeScript orchestration backend ("the brain") that turns a structured agent description into a fully-wired legal body on Arc — generate its operating agreement, register its ERC-8004 identity, deploy + wire its `LegalManager` and immutable `AgentTreasury` via the Factory in one atomic tx, bind its wallet, and persist the record — driven by a CLI and fully tested.

**Architecture:** A new `backend/` TypeScript package (ESM, Node ≥20.18.2, vitest, biome) lives in the existing Foundry monorepo. Contract ABIs are code-generated from Foundry `out/` artifacts into `as const` TS (type-safe via viem + abitype, no drift). Small, independently-testable modules (`config`, `secrets`, `persistence`, `policy`, `oa`, `adapters/{arc,turnkey}`) are sequenced by one idempotent, resumable onboarding **saga** and exposed through a `commander` CLI. Pure logic (the law→code `translator`, the OA hasher) is unit-tested; on-chain logic is integration-tested against a local **anvil** with the Solidity `MockIdentityRegistry` double; Turnkey/Circle/Arc-testnet paths have env-gated live smoke tests.

**Tech Stack:** TypeScript 5.6 (NodeNext ESM), viem 2 + abitype, better-sqlite3, zod, commander, dotenv, @turnkey/sdk-server + @turnkey/viem, vitest, @biomejs/biome. Foundry (forge/anvil 1.5.1) for the contract layer.

---

## Conventions (read once before starting)

- **Package manager:** `npm` (lockfile `backend/package-lock.json`). All `npm` commands below are run **from `backend/`** unless a path says otherwise.
- **Module system:** ESM. `package.json` has `"type": "module"`; TS uses `"module"/"moduleResolution": "NodeNext"`. Imports of local `.ts` files use **no extension** in source (vitest/tsx resolve them); only emitted `.js` would need extensions, and we run via `tsx`/`vitest` so this does not bite us.
- **Tests:** `npx vitest run` (CI) / `npx vitest` (watch). Unit tests end `.test.ts`; anvil integration tests end `.int.test.ts`; env-gated live smoke tests end `.live.test.ts` and `describe.skipIf(!process.env.<FLAG>)`.
- **Lint/format:** `npx biome check .` (and `--write` to fix).
- **Money units:** ERC-20 USDC has **6 decimals** (`parseUnits(x, 6)`). Arc **native gas is USDC at 18 decimals** — never mix. The treasury holds the ERC-20 USDC at `0x3600…0000`.
- **Arc finality:** single-block, irreversible — wait for **one** receipt, add **no** multi-confirmation logic.
- **Never log secrets.** `config` validates them; nothing prints private keys / API secrets.
- **Commits:** one per task (or per green test cluster). Follow [[git-collaboration-workflow]]: work on a feature branch, rebase on `origin/master` before pushing. End commit messages with the `Co-Authored-By` trailer.
- **Verified contract facts** baked into this plan (from `docs/research/STACK_REFERENCE.md` + on-chain verification 2026-06-04):
  - Arc testnet: chainId **5042002**, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`.
  - ERC-8004 IdentityRegistry **`0x8004A818BFB912233c491871b3d84c89A494BD9e`** (ERC-721 "AgentIdentity"/"AGENT"). `register()` returns **agentId 0 first** (`_lastId++`) and `_safeMint`s to the caller (Factory implements `IERC721Receiver`). `setAgentWallet(agentId, newWallet, deadline, signature)` requires the signature to come from **`newWallet`** (EIP-712 `AgentWalletSet`) and the **caller to be the NFT owner**, with `deadline ≤ now + 1h`.
  - USDC ERC-20 **`0x3600000000000000000000000000000000000000`** (6 decimals).
  - Compile contracts `evm_version = "paris"` (no PUSH0); `via_ir = true`. Already set in `foundry.toml`.

---

## File Structure

New package rooted at `backend/`. Foundry stays at repo root (`src/`, `test/`, `script/`, `foundry.toml`, `out/`).

```
backend/
  package.json                      # ESM, scripts, deps
  package-lock.json
  tsconfig.json                     # NodeNext, strict
  biome.json                        # lint/format
  vitest.config.ts                  # test config (unit + int + live)
  .env.example                      # backend-specific env template
  addresses.arc-testnet.json        # checked-in deploy addresses (factory/impl/beacon/registry/usdc)
  scripts/
    gen-abis.mts                    # reads ../out/*.json -> src/abis/generated.ts (as const)
  src/
    abis/
      generated.ts                  # GENERATED typed ABIs (do not hand-edit)
    chains.ts                       # arcTestnet + anvilChain (viem defineChain)
    types.ts                        # shared domain types (Address re-exports, TreasuryConfig, records)
    config/
      env.ts                        # zod env loader + validation; redact()
    secrets/
      index.ts                      # SecretStore interface + EnvSecretStore
    persistence/
      db.ts                         # openDatabase + migrate (SQLite schema)
      entityRepository.ts           # EntityRepository iface + SqliteEntityRepository
      documentStore.ts              # DocumentStore iface + FileDocumentStore
    policy/
      units.ts                      # parseDuration, usdToUnits, formatUnitsUsd
      agentSpec.ts                  # zod AgentSpec schema + parseAgentSpec
      translator.ts                 # PURE law->code translate() + TranslationError
    oa/
      generator.ts                  # renderOperatingAgreement, computeOaHash, renderMetadata
    adapters/
      arc/
        clients.ts                  # public/wallet client factories from config
        walletSet.ts               # buildWalletSetTypedData (pure EIP-712 builder)
        arcAdapter.ts               # ArcAdapter: createEntity, setAgentWallet, reads
      turnkey/
        signer.ts                   # OperatorSigner iface + LocalKeySigner
        turnkeySigner.ts            # TurnkeySigner (enclave key) + provisioning notes
    workflow/
      onboarding.ts                 # runOnboarding saga (idempotent/resumable)
    cli/
      index.ts                      # commander program (create-entity/get-entity/list/bind/fund)
  test/
    helpers/
      artifacts.ts                  # loadArtifact(name) from ../out
      anvil.ts                      # startAnvil(): spawn + wait ready + stop
      stack.ts                      # deployStack(): MockUSDC, MockIdentityRegistry, impl, Factory
    *.test.ts / *.int.test.ts / *.live.test.ts
  data/                             # gitignored: sqlite db + doc store (runtime)
```

---

## Milestone M0 — Accounts + Arc-testnet contract deploy

Ops/runbook milestone. Produces the checked-in addresses file the backend reads. Mostly exact commands; no TDD code yet.

### Task 0.1: Compile + deploy contracts to Arc testnet, capture addresses

**Files:**
- Create: `backend/addresses.arc-testnet.json`
- Use (root): `script/Deploy.s.sol` (already exists), `.env` (root, gitignored)

- [ ] **Step 1: Ensure contracts compile under the Arc profile**

Run (from repo root):

```bash
forge build
```

Expected: `Compiler run successful`. Confirms `out/` artifacts (which the backend codegen reads) are current.

- [ ] **Step 2: Populate the root `.env` with the platform deployer key + registry**

The root `.env` (gitignored) already has `.env.example` keys. Set:

```bash
# root .env
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=0x<platform_deployer_private_key>        # Factory owner == manager in v1
IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
# Optional: BEACON_OWNER=0x<multisig>  (defaults to deployer if unset)
```

The deployer EOA must hold Arc testnet USDC for gas (USDC is the native gas token on Arc). Fund it at https://faucet.circle.com (see Task 0.3).

- [ ] **Step 3: Deploy LegalManager impl + Factory to Arc testnet**

Run (from repo root):

```bash
source .env
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --broadcast \
  --slow
```

Expected console output (capture all four addresses):

```
LegalManager impl: 0x...
LegalManagerFactory: 0x...
Beacon: 0x...
Beacon owner: 0x...
```

If you get `ESTIMATION_ERROR` / `Create2: Failed on deploy`, the bytecode contains PUSH0 — confirm `foundry.toml` has `evm_version = "paris"` and re-`forge build`.

- [ ] **Step 4: Write the checked-in addresses file**

Create `backend/addresses.arc-testnet.json` from the deploy output:

```json
{
  "chainId": 5042002,
  "rpcUrl": "https://rpc.testnet.arc.network",
  "explorer": "https://testnet.arcscan.app",
  "identityRegistry": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  "usdc": "0x3600000000000000000000000000000000000000",
  "legalManagerImpl": "0x<from step 3>",
  "factory": "0x<from step 3>",
  "beacon": "0x<from step 3>",
  "beaconOwner": "0x<from step 3>",
  "deployedAt": "2026-06-10",
  "note": "Arc TESTNET only — not NYDFS reviewed. via_ir bytecode re-review pending before mainnet."
}
```

- [ ] **Step 5: Verify the Factory is live on Arc**

Run (from repo root, substitute the factory address):

```bash
source .env
cast call 0x<factory> "beacon()(address)" --rpc-url "$ARC_TESTNET_RPC_URL"
cast call 0x<factory> "owner()(address)"  --rpc-url "$ARC_TESTNET_RPC_URL"
```

Expected: `beacon()` returns the beacon address from step 3; `owner()` returns the deployer EOA (the platform/manager key).

- [ ] **Step 6: Commit**

```bash
git add backend/addresses.arc-testnet.json
git commit -m "feat(backend): record Arc-testnet deploy addresses (M0)"
```

### Task 0.2: Turnkey org + operator-key pattern (documented + env-gated)

**Files:**
- Create: `backend/docs/turnkey-setup.md`

- [ ] **Step 1: Create the Turnkey org + API key**

Document, in `backend/docs/turnkey-setup.md`, the exact manual steps (no secret values committed):

```markdown
# Turnkey setup (operator enclave keys)

1. Create a Turnkey organization at https://app.turnkey.com (or via API).
2. Create an API key pair (P-256). Store the API public key + private key as
   TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY (backend .env, gitignored).
3. Record TURNKEY_ORGANIZATION_ID (the parent org id).
4. Per-agent pattern (v1 demo): one operator key per agent.
   - Non-custodial target: provision a per-agent SUB-ORG with the HUMAN REGISTRANT as the
     sub-org ROOT user, then create the operator key inside it, then grant the platform
     headless signing via a Delegated Access policy (no email/OTP).
   - v1 fallback (clearly labeled, custodial-in-practice): create the operator key directly
     under the parent org. Acceptable ONLY for the testnet demo.
5. Base URL: https://api.turnkey.com
```

> Note: the Turnkey SDK and delegated-access flow evolve. The actual SDK calls live in Task 4.3 and **must be re-verified against current `@turnkey/sdk-server` docs at build time** (carried risk from the design doc).

- [ ] **Step 2: Commit**

```bash
git add backend/docs/turnkey-setup.md
git commit -m "docs(backend): Turnkey operator-key setup runbook (M0)"
```

### Task 0.3: Circle dev account + fund the platform EOA (documented)

**Files:**
- Modify: `backend/docs/turnkey-setup.md` is separate; create `backend/docs/circle-setup.md`

- [ ] **Step 1: Document Circle + faucet funding**

Create `backend/docs/circle-setup.md`:

```markdown
# Circle + Arc testnet funding (rails are THIN in v1)

1. Create a Circle developer account at https://developers.circle.com.
2. Generate a TESTNET API key -> CIRCLE_API_KEY (backend .env). (Rails only; NOT custody.)
3. Fund the platform deployer EOA with Arc testnet USDC (native gas) at https://faucet.circle.com.
   - The same USDC ERC-20 (0x3600...0000) is used to fund agent treasuries in the optional fund step.
4. v1 does NOT integrate Circle wallets for custody — operator custody is Turnkey (see design).
```

- [ ] **Step 2: Commit**

```bash
git add backend/docs/circle-setup.md
git commit -m "docs(backend): Circle dev-account + faucet runbook (M0)"
```

---

## Milestone M1 — `backend/` skeleton: package, config, secrets, persistence

### Task 1.1: Scaffold the package (package.json, tsconfig, biome, vitest)

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/biome.json`, `backend/vitest.config.ts`, `backend/.env.example`, `backend/.gitignore`, `backend/src/types.ts`, `backend/test/smoke.test.ts`

- [ ] **Step 1: Write `backend/package.json`**

```json
{
  "name": "agent-legal-body-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.18.2" },
  "bin": { "legalbody": "src/cli/index.ts" },
  "scripts": {
    "gen:abis": "tsx scripts/gen-abis.mts",
    "cli": "tsx src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "commander": "^12.1.0",
    "dotenv": "^16.4.5",
    "viem": "^2.21.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

> Turnkey deps (`@turnkey/sdk-server`, `@turnkey/viem`) are added in M4 to keep M1–M3 installable without them. Install with `@latest` then (per the carried risk) verify the API against current docs.

- [ ] **Step 2: Write `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": false,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "scripts", "test", "vitest.config.ts"]
}
```

- [ ] **Step 3: Write `backend/biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "files": { "ignore": ["dist", "data", "src/abis/generated.ts", "node_modules"] },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "off" },
      "suspicious": { "noExplicitAny": "warn" }
    }
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 }
}
```

- [ ] **Step 4: Write `backend/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Anvil integration + live tests run serially to avoid port/nonce contention.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 5: Write `backend/.env.example` and `backend/.gitignore`**

`backend/.env.example`:

```bash
# Arc
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
ARC_CHAIN_ID=5042002
# Platform / manager (also Factory owner). v1 may be a local key.
PLATFORM_PRIVATE_KEY=0x
# Addresses (defaults exist in addresses.arc-testnet.json; env overrides win)
IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
USDC_ADDRESS=0x3600000000000000000000000000000000000000
FACTORY_ADDRESS=0x
# Roles (guardian only needs an address during onboarding)
GUARDIAN_ADDRESS=0x
# Operator: local fallback for demo; Turnkey in M4
OPERATOR_PRIVATE_KEY=0x
# Storage
DATA_DIR=./data
# Turnkey (M4; optional)
TURNKEY_API_PUBLIC_KEY=
TURNKEY_API_PRIVATE_KEY=
TURNKEY_ORGANIZATION_ID=
TURNKEY_BASE_URL=https://api.turnkey.com
# Circle (thin; optional)
CIRCLE_API_KEY=
```

`backend/.gitignore`:

```
node_modules/
dist/
data/
.env
.env.*
!.env.example
```

- [ ] **Step 6: Write `backend/src/types.ts` (shared domain types)**

```ts
import type { Address, Hex } from "viem";

export type { Address, Hex };

/** Mirror of LegalManagerFactory.TreasuryConfig (encoded into createEntity). */
export interface TreasuryConfig {
  usdc: Address;
  payoutAddress: Address;
  cap: bigint;
  period: bigint;
  allowlistEnabled: boolean;
}

/** Onboarding status, monotonic. Matches the SQLite status enum. */
export type EntityStatus = "translating" | "created" | "bound" | "funded";

/** One persisted legal-body record. agentId/proxy/treasury are null until step 4 (created). */
export interface EntityRecord {
  idempotencyKey: string;
  name: string;
  status: EntityStatus;
  manager: Address;
  guardian: Address;
  operator: Address | null;
  amendmentDelay: string; // bigint serialized as decimal string
  ein: string;
  formationDate: number; // unix seconds (uint64)
  oaHash: Hex | null;
  metadataURI: string | null;
  docPath: string | null;
  treasuryConfig: TreasuryConfig | null;
  agentId: string | null; // uint256 as decimal string
  proxy: Address | null;
  treasury: Address | null;
  createTxHash: Hex | null;
  bindTxHash: Hex | null;
  fundTxHash: Hex | null;
}
```

- [ ] **Step 7: Write a smoke test `backend/test/smoke.test.ts`**

```ts
import { expect, test } from "vitest";
import { keccak256, toHex } from "viem";

test("toolchain is wired (viem importable, keccak works)", () => {
  expect(keccak256(toHex("legal body"))).toMatch(/^0x[0-9a-f]{64}$/);
});
```

- [ ] **Step 8: Install + run the smoke test**

Run (from `backend/`):

```bash
npm install
npx vitest run test/smoke.test.ts
```

Expected: install succeeds; 1 test passes.

- [ ] **Step 9: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/tsconfig.json \
        backend/biome.json backend/vitest.config.ts backend/.env.example \
        backend/.gitignore backend/src/types.ts backend/test/smoke.test.ts
git commit -m "feat(backend): scaffold TS package (ESM, vitest, biome) (M1)"
```

### Task 1.2: ABI codegen from Foundry `out/` → typed `as const`

**Files:**
- Create: `backend/scripts/gen-abis.mts`, `backend/src/abis/generated.ts` (generated)
- Test: `backend/test/abis.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/abis.test.ts`**

```ts
import { expect, test } from "vitest";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
} from "../src/abis/generated";

test("generated ABIs expose the functions the backend calls", () => {
  const names = (abi: readonly { name?: string }[]) =>
    new Set(abi.map((x) => x.name).filter(Boolean));

  expect(names(legalManagerFactoryAbi).has("createEntity")).toBe(true);
  expect(names(iIdentityRegistryAbi).has("setAgentWallet")).toBe(true);
  expect(names(iIdentityRegistryAbi).has("getAgentWallet")).toBe(true);
  expect(names(legalManagerAbi).has("status")).toBe(true);
  expect(names(agentTreasuryAbi).has("available")).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/abis.test.ts`
Expected: FAIL — `Cannot find module '../src/abis/generated'`.

- [ ] **Step 3: Write `backend/scripts/gen-abis.mts`**

```ts
/**
 * Generate type-safe `as const` ABIs from Foundry artifacts in ../out.
 * Run: npm run gen:abis  (re-run after any contract change + `forge build`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "out");
const DEST = resolve(HERE, "..", "src", "abis", "generated.ts");

// exportName -> artifact path under out/<Sol>/<Json>
const TARGETS: Record<string, string> = {
  legalManagerFactoryAbi: "LegalManagerFactory.sol/LegalManagerFactory.json",
  legalManagerAbi: "LegalManager.sol/LegalManager.json",
  agentTreasuryAbi: "AgentTreasury.sol/AgentTreasury.json",
  iIdentityRegistryAbi: "IIdentityRegistry.sol/IIdentityRegistry.json",
  // Test-only doubles (used by anvil integration tests):
  mockIdentityRegistryAbi: "MockIdentityRegistry.sol/MockIdentityRegistry.json",
  mockUsdcAbi: "MockUSDC.sol/MockUSDC.json",
};

function loadAbi(rel: string): unknown {
  const json = JSON.parse(readFileSync(resolve(OUT, rel), "utf8"));
  if (!Array.isArray(json.abi)) throw new Error(`no abi in ${rel}`);
  return json.abi;
}

let body = "// GENERATED by scripts/gen-abis.mts — do not edit by hand.\n";
body += "// Re-run `npm run gen:abis` after `forge build`.\n\n";
for (const [name, rel] of Object.entries(TARGETS)) {
  const abi = loadAbi(rel);
  body += `export const ${name} = ${JSON.stringify(abi)} as const;\n\n`;
}

mkdirSync(dirname(DEST), { recursive: true });
writeFileSync(DEST, body);
console.log(`wrote ${DEST} (${Object.keys(TARGETS).length} ABIs)`);
```

- [ ] **Step 4: Generate, then run the test to verify it passes**

Run (from `backend/`):

```bash
npm run gen:abis
npx vitest run test/abis.test.ts
```

Expected: codegen prints `wrote .../generated.ts (6 ABIs)`; test PASSES.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/gen-abis.mts backend/src/abis/generated.ts backend/test/abis.test.ts
git commit -m "feat(backend): codegen typed ABIs from Foundry out/ (M1)"
```

### Task 1.3: Chain definitions (`arcTestnet` + `anvilChain`)

**Files:**
- Create: `backend/src/chains.ts`
- Test: `backend/test/chains.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/chains.test.ts`**

```ts
import { expect, test } from "vitest";
import { anvilChain, arcTestnet } from "../src/chains";

test("arcTestnet has the verified id and USDC-as-native-gas (18 dec native)", () => {
  expect(arcTestnet.id).toBe(5042002);
  expect(arcTestnet.nativeCurrency.symbol).toBe("USDC");
  expect(arcTestnet.nativeCurrency.decimals).toBe(18); // native gas units; ERC-20 USDC is 6
});

test("anvilChain is 31337", () => {
  expect(anvilChain.id).toBe(31337);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/chains.test.ts`
Expected: FAIL — cannot find `../src/chains`.

- [ ] **Step 3: Write `backend/src/chains.ts`**

```ts
import { type Chain, defineChain } from "viem";

/** Arc testnet. Native gas IS USDC (18-decimal native units); the ERC-20 USDC is 6-decimal. */
export const arcTestnet: Chain = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

/** Local anvil chain used by integration tests. */
export const anvilChain: Chain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

/** Build a viem Chain for a given id/rpc (Arc id keeps Arc metadata; else generic). */
export function chainFor(id: number, rpcUrl: string): Chain {
  if (id === arcTestnet.id) {
    return { ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  }
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/chains.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/chains.ts backend/test/chains.test.ts
git commit -m "feat(backend): viem chain defs for Arc testnet + anvil (M1)"
```

### Task 1.4: Typed config loader (`config/env.ts`)

**Files:**
- Create: `backend/src/config/env.ts`
- Test: `backend/test/config.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/config.test.ts`**

```ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../src/config/env";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
  ARC_CHAIN_ID: "5042002",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  GUARDIAN_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  FACTORY_ADDRESS: "0x00000000000000000000000000000000000F4c70",
  DATA_DIR: "./data",
};

test("loadConfig parses valid env with defaults", () => {
  const cfg = loadConfig(base);
  expect(cfg.chainId).toBe(5042002);
  expect(cfg.identityRegistry).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
  expect(cfg.usdc).toBe("0x3600000000000000000000000000000000000000");
  expect(cfg.platformPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
});

test("loadConfig rejects a malformed private key", () => {
  expect(() => loadConfig({ ...base, PLATFORM_PRIVATE_KEY: "nope" })).toThrow(/PLATFORM_PRIVATE_KEY/);
});

test("redact never reveals secret material", () => {
  const cfg = loadConfig(base);
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain("1".repeat(64));
  expect(printed).toContain("REDACTED");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot find `../src/config/env`.

- [ ] **Step 3: Write `backend/src/config/env.ts`**

```ts
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { Address, Hex } from "../types";

const addressSchema = z
  .string()
  .refine((s) => isAddress(s), { message: "must be a 0x address" })
  .transform((s) => getAddress(s) as Address);

const privKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { message: "PLATFORM_PRIVATE_KEY must be 0x + 64 hex" })
  .transform((s) => s as Hex);

const EnvSchema = z.object({
  ARC_TESTNET_RPC_URL: z.string().url(),
  ARC_CHAIN_ID: z.coerce.number().int().positive().default(5042002),
  PLATFORM_PRIVATE_KEY: privKeySchema,
  IDENTITY_REGISTRY: addressSchema.default("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
  USDC_ADDRESS: addressSchema.default("0x3600000000000000000000000000000000000000"),
  FACTORY_ADDRESS: addressSchema.optional(),
  GUARDIAN_ADDRESS: addressSchema.optional(),
  OPERATOR_PRIVATE_KEY: privKeySchema.optional(),
  DATA_DIR: z.string().default("./data"),
  TURNKEY_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_API_PRIVATE_KEY: z.string().optional(),
  TURNKEY_ORGANIZATION_ID: z.string().optional(),
  TURNKEY_BASE_URL: z.string().url().default("https://api.turnkey.com"),
  CIRCLE_API_KEY: z.string().optional(),
});

export interface Config {
  rpcUrl: string;
  chainId: number;
  platformPrivateKey: Hex;
  identityRegistry: Address;
  usdc: Address;
  factoryAddress?: Address;
  guardianAddress?: Address;
  operatorPrivateKey?: Hex;
  dataDir: string;
  dbPath: string;
  docStoreDir: string;
  turnkey?: {
    apiPublicKey: string;
    apiPrivateKey: string;
    organizationId: string;
    baseUrl: string;
  };
  circleApiKey?: string;
}

/** Validate + shape env into Config. Throws a readable error on the first invalid field. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`Invalid config: ${first.path.join(".")} — ${first.message}`);
  }
  const e = parsed.data;
  const turnkey =
    e.TURNKEY_API_PUBLIC_KEY && e.TURNKEY_API_PRIVATE_KEY && e.TURNKEY_ORGANIZATION_ID
      ? {
          apiPublicKey: e.TURNKEY_API_PUBLIC_KEY,
          apiPrivateKey: e.TURNKEY_API_PRIVATE_KEY,
          organizationId: e.TURNKEY_ORGANIZATION_ID,
          baseUrl: e.TURNKEY_BASE_URL,
        }
      : undefined;

  return {
    rpcUrl: e.ARC_TESTNET_RPC_URL,
    chainId: e.ARC_CHAIN_ID,
    platformPrivateKey: e.PLATFORM_PRIVATE_KEY,
    identityRegistry: e.IDENTITY_REGISTRY,
    usdc: e.USDC_ADDRESS,
    factoryAddress: e.FACTORY_ADDRESS,
    guardianAddress: e.GUARDIAN_ADDRESS,
    operatorPrivateKey: e.OPERATOR_PRIVATE_KEY,
    dataDir: e.DATA_DIR,
    dbPath: `${e.DATA_DIR}/legalbody.db`,
    docStoreDir: `${e.DATA_DIR}/documents`,
    turnkey,
    circleApiKey: e.CIRCLE_API_KEY,
  };
}

/** Safe-to-log view: secrets replaced with "REDACTED". */
export function redact(cfg: Config): Record<string, unknown> {
  return {
    ...cfg,
    platformPrivateKey: "REDACTED",
    operatorPrivateKey: cfg.operatorPrivateKey ? "REDACTED" : undefined,
    circleApiKey: cfg.circleApiKey ? "REDACTED" : undefined,
    turnkey: cfg.turnkey
      ? { ...cfg.turnkey, apiPrivateKey: "REDACTED", apiPublicKey: "REDACTED" }
      : undefined,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/test/config.test.ts
git commit -m "feat(backend): typed env config loader with redaction (M1)"
```

### Task 1.5: Secrets seam (`secrets/index.ts`)

**Files:**
- Create: `backend/src/secrets/index.ts`
- Test: `backend/test/secrets.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/secrets.test.ts`**

```ts
import { expect, test } from "vitest";
import { EnvSecretStore } from "../src/secrets/index";

test("EnvSecretStore returns present secrets and undefined for missing", () => {
  const store = new EnvSecretStore({ FOO: "bar" });
  expect(store.get("FOO")).toBe("bar");
  expect(store.get("MISSING")).toBeUndefined();
});

test("require() throws a clear error when a secret is absent", () => {
  const store = new EnvSecretStore({});
  expect(() => store.require("PLATFORM_PRIVATE_KEY")).toThrow(/PLATFORM_PRIVATE_KEY/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/secrets.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/secrets/index.ts`**

```ts
/** Thin seam so adapters depend on an interface, not raw env. Swap for a secrets manager later. */
export interface SecretStore {
  get(key: string): string | undefined;
  require(key: string): string;
}

export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  get(key: string): string | undefined {
    return this.env[key];
  }

  require(key: string): string {
    const v = this.env[key];
    if (v === undefined || v === "") throw new Error(`Missing required secret: ${key}`);
    return v;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/secrets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/secrets/index.ts backend/test/secrets.test.ts
git commit -m "feat(backend): SecretStore interface + env impl (M1)"
```

### Task 1.6: Persistence — SQLite schema + EntityRepository

**Files:**
- Create: `backend/src/persistence/db.ts`, `backend/src/persistence/entityRepository.ts`
- Test: `backend/test/entityRepository.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/entityRepository.test.ts`**

```ts
import { afterEach, beforeEach, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import type { EntityRecord } from "../src/types";

let db: Database.Database;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

const record = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  idempotencyKey: "key-1",
  name: "Demo Agent",
  status: "translating",
  manager: "0x000000000000000000000000000000000000aAaa",
  guardian: "0x000000000000000000000000000000000000bBbb",
  operator: null,
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: null,
  proxy: null,
  treasury: null,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  ...over,
});

test("upsert then findByIdempotencyKey round-trips, incl. bigint-as-string + json", () => {
  repo.upsert(record({ treasuryConfig: { usdc: "0x3600000000000000000000000000000000000000", payoutAddress: "0x000000000000000000000000000000000000cCcc", cap: 1_000_000n, period: 2_592_000n, allowlistEnabled: false } }));
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.name).toBe("Demo Agent");
  expect(got?.treasuryConfig?.cap).toBe(1_000_000n);
  expect(got?.treasuryConfig?.period).toBe(2_592_000n);
});

test("upsert updates an existing row (same idempotencyKey)", () => {
  repo.upsert(record());
  repo.upsert(record({ status: "created", agentId: "0", proxy: "0x000000000000000000000000000000000000dEaD" }));
  const got = repo.findByIdempotencyKey("key-1");
  expect(got?.status).toBe("created");
  expect(got?.agentId).toBe("0");
  expect(repo.list()).toHaveLength(1);
});

test("findByAgentId locates a created entity", () => {
  repo.upsert(record({ status: "created", agentId: "42" }));
  expect(repo.findByAgentId("42")?.idempotencyKey).toBe("key-1");
});

test("recordEvent + listEvents append-only audit trail", () => {
  repo.upsert(record());
  repo.recordEvent("key-1", "createEntity", "created", "0xabc", "{}");
  repo.recordEvent("key-1", "setAgentWallet", "bound", "0xdef", "{}");
  expect(repo.listEvents("key-1").map((e) => e.step)).toEqual(["createEntity", "setAgentWallet"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/entityRepository.test.ts`
Expected: FAIL — cannot find `../src/persistence/db`.

- [ ] **Step 3: Write `backend/src/persistence/db.ts`**

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** Open (and create dirs for) a SQLite db. Use ":memory:" in tests. */
export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Create tables if absent. Idempotent. */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      idempotency_key TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('translating','created','bound','funded')),
      manager         TEXT NOT NULL,
      guardian        TEXT NOT NULL,
      operator        TEXT,
      amendment_delay TEXT NOT NULL,
      ein             TEXT NOT NULL,
      formation_date  INTEGER NOT NULL,
      oa_hash         TEXT,
      metadata_uri    TEXT,
      doc_path        TEXT,
      treasury_config TEXT,             -- JSON (bigints as decimal strings)
      agent_id        TEXT,             -- uint256 as decimal string
      proxy           TEXT,
      treasury        TEXT,
      create_tx_hash  TEXT,
      bind_tx_hash    TEXT,
      fund_tx_hash    TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities(agent_id);

    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT PRIMARY KEY,
      oa_hash    TEXT,
      path       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      step            TEXT NOT NULL,
      status          TEXT NOT NULL,
      tx_hash         TEXT,
      detail          TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (idempotency_key) REFERENCES entities(idempotency_key)
    );
  `);
}
```

- [ ] **Step 4: Write `backend/src/persistence/entityRepository.ts`**

```ts
import type Database from "better-sqlite3";
import type { Address, EntityRecord, Hex, TreasuryConfig } from "../types";

export interface EventRow {
  step: string;
  status: string;
  txHash: string | null;
  detail: string | null;
  createdAt: string;
}

export interface EntityRepository {
  upsert(record: EntityRecord): void;
  findByIdempotencyKey(key: string): EntityRecord | undefined;
  findByAgentId(agentId: string): EntityRecord | undefined;
  list(): EntityRecord[];
  recordEvent(key: string, step: string, status: string, txHash: string | null, detail: string): void;
  listEvents(key: string): EventRow[];
}

interface Row {
  idempotency_key: string;
  name: string;
  status: EntityRecord["status"];
  manager: string;
  guardian: string;
  operator: string | null;
  amendment_delay: string;
  ein: string;
  formation_date: number;
  oa_hash: string | null;
  metadata_uri: string | null;
  doc_path: string | null;
  treasury_config: string | null;
  agent_id: string | null;
  proxy: string | null;
  treasury: string | null;
  create_tx_hash: string | null;
  bind_tx_hash: string | null;
  fund_tx_hash: string | null;
}

function serializeTreasury(tc: TreasuryConfig | null): string | null {
  if (!tc) return null;
  return JSON.stringify({ ...tc, cap: tc.cap.toString(), period: tc.period.toString() });
}
function deserializeTreasury(s: string | null): TreasuryConfig | null {
  if (!s) return null;
  const o = JSON.parse(s);
  return { usdc: o.usdc, payoutAddress: o.payoutAddress, cap: BigInt(o.cap), period: BigInt(o.period), allowlistEnabled: o.allowlistEnabled };
}
function toRecord(r: Row): EntityRecord {
  return {
    idempotencyKey: r.idempotency_key,
    name: r.name,
    status: r.status,
    manager: r.manager as Address,
    guardian: r.guardian as Address,
    operator: (r.operator as Address) ?? null,
    amendmentDelay: r.amendment_delay,
    ein: r.ein,
    formationDate: r.formation_date,
    oaHash: (r.oa_hash as Hex) ?? null,
    metadataURI: r.metadata_uri,
    docPath: r.doc_path,
    treasuryConfig: deserializeTreasury(r.treasury_config),
    agentId: r.agent_id,
    proxy: (r.proxy as Address) ?? null,
    treasury: (r.treasury as Address) ?? null,
    createTxHash: (r.create_tx_hash as Hex) ?? null,
    bindTxHash: (r.bind_tx_hash as Hex) ?? null,
    fundTxHash: (r.fund_tx_hash as Hex) ?? null,
  };
}

export class SqliteEntityRepository implements EntityRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(rec: EntityRecord): void {
    this.db
      .prepare(`
        INSERT INTO entities (
          idempotency_key, name, status, manager, guardian, operator, amendment_delay,
          ein, formation_date, oa_hash, metadata_uri, doc_path, treasury_config,
          agent_id, proxy, treasury, create_tx_hash, bind_tx_hash, fund_tx_hash, updated_at
        ) VALUES (
          @idempotency_key, @name, @status, @manager, @guardian, @operator, @amendment_delay,
          @ein, @formation_date, @oa_hash, @metadata_uri, @doc_path, @treasury_config,
          @agent_id, @proxy, @treasury, @create_tx_hash, @bind_tx_hash, @fund_tx_hash, CURRENT_TIMESTAMP
        )
        ON CONFLICT(idempotency_key) DO UPDATE SET
          name=excluded.name, status=excluded.status, manager=excluded.manager,
          guardian=excluded.guardian, operator=excluded.operator,
          amendment_delay=excluded.amendment_delay, ein=excluded.ein,
          formation_date=excluded.formation_date, oa_hash=excluded.oa_hash,
          metadata_uri=excluded.metadata_uri, doc_path=excluded.doc_path,
          treasury_config=excluded.treasury_config, agent_id=excluded.agent_id,
          proxy=excluded.proxy, treasury=excluded.treasury,
          create_tx_hash=excluded.create_tx_hash, bind_tx_hash=excluded.bind_tx_hash,
          fund_tx_hash=excluded.fund_tx_hash, updated_at=CURRENT_TIMESTAMP
      `)
      .run({
        idempotency_key: rec.idempotencyKey,
        name: rec.name,
        status: rec.status,
        manager: rec.manager,
        guardian: rec.guardian,
        operator: rec.operator,
        amendment_delay: rec.amendmentDelay,
        ein: rec.ein,
        formation_date: rec.formationDate,
        oa_hash: rec.oaHash,
        metadata_uri: rec.metadataURI,
        doc_path: rec.docPath,
        treasury_config: serializeTreasury(rec.treasuryConfig),
        agent_id: rec.agentId,
        proxy: rec.proxy,
        treasury: rec.treasury,
        create_tx_hash: rec.createTxHash,
        bind_tx_hash: rec.bindTxHash,
        fund_tx_hash: rec.fundTxHash,
      });
  }

  findByIdempotencyKey(key: string): EntityRecord | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE idempotency_key = ?").get(key) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  findByAgentId(agentId: string): EntityRecord | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE agent_id = ?").get(agentId) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(): EntityRecord[] {
    return (this.db.prepare("SELECT * FROM entities ORDER BY created_at").all() as Row[]).map(toRecord);
  }

  recordEvent(key: string, step: string, status: string, txHash: string | null, detail: string): void {
    this.db
      .prepare("INSERT INTO events (idempotency_key, step, status, tx_hash, detail) VALUES (?,?,?,?,?)")
      .run(key, step, status, txHash, detail);
  }

  listEvents(key: string): EventRow[] {
    return (
      this.db.prepare("SELECT step, status, tx_hash as txHash, detail, created_at as createdAt FROM events WHERE idempotency_key = ? ORDER BY id").all(key) as EventRow[]
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/entityRepository.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/persistence/db.ts backend/src/persistence/entityRepository.ts backend/test/entityRepository.test.ts
git commit -m "feat(backend): SQLite schema + EntityRepository (M1)"
```

### Task 1.7: Persistence — FileDocumentStore

**Files:**
- Create: `backend/src/persistence/documentStore.ts`
- Test: `backend/test/documentStore.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/documentStore.test.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FileDocumentStore } from "../src/persistence/documentStore";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "docstore-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("put writes a file and returns a stable file:// URI; get reads it back", () => {
  const store = new FileDocumentStore(dir);
  const put = store.put("operating-agreement.md", "# OA\nbody");
  expect(put.uri.startsWith("file://")).toBe(true);
  expect(store.get(put.id)).toBe("# OA\nbody");
});

test("same id derives from name (deterministic per logical doc)", () => {
  const store = new FileDocumentStore(dir);
  const a = store.put("oa-key-1.md", "x");
  const b = store.put("oa-key-1.md", "y"); // overwrite
  expect(a.id).toBe(b.id);
  expect(store.get(a.id)).toBe("y");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/documentStore.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/persistence/documentStore.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

export interface PutResult {
  id: string; // == the file name (logical doc id)
  path: string; // absolute path on disk
  uri: string; // file:// URI used as metadataURI in v1
}

export interface DocumentStore {
  put(name: string, contents: string): PutResult;
  get(id: string): string;
}

/** Local-filesystem doc store. Interface allows S3 / Vercel Blob later (deferred). */
export class FileDocumentStore implements DocumentStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = isAbsolute(root) ? root : resolve(process.cwd(), root);
    mkdirSync(this.root, { recursive: true });
  }

  put(name: string, contents: string): PutResult {
    const path = join(this.root, name);
    writeFileSync(path, contents, "utf8");
    return { id: name, path, uri: pathToFileURL(path).href };
  }

  get(id: string): string {
    return readFileSync(join(this.root, id), "utf8");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/documentStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full M1 suite + lint**

Run: `npx vitest run && npx biome check .`
Expected: all tests pass; biome clean (fix with `npx biome check --write .` if needed, then re-run).

- [ ] **Step 6: Commit**

```bash
git add backend/src/persistence/documentStore.ts backend/test/documentStore.test.ts
git commit -m "feat(backend): FileDocumentStore (M1)"
```

---

## Milestone M2 — `policy/translator` + `oa/generator` (pure, TDD)

### Task 2.1: Unit helpers — duration + USD parsing

**Files:**
- Create: `backend/src/policy/units.ts`
- Test: `backend/test/units.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/units.test.ts`**

```ts
import { expect, test } from "vitest";
import { formatUnitsUsd, parseDuration, usdToUnits } from "../src/policy/units";

test("parseDuration handles suffixes and raw seconds", () => {
  expect(parseDuration("30d")).toBe(2_592_000n);
  expect(parseDuration("24h")).toBe(86_400n);
  expect(parseDuration("90m")).toBe(5_400n);
  expect(parseDuration("3600s")).toBe(3_600n);
  expect(parseDuration("3600")).toBe(3_600n);
  expect(parseDuration(3600)).toBe(3_600n);
});

test("parseDuration rejects garbage", () => {
  expect(() => parseDuration("soon")).toThrow(/duration/i);
  expect(() => parseDuration("-5m")).toThrow(/duration/i);
});

test("usdToUnits uses 6 decimals; formatUnitsUsd inverts", () => {
  expect(usdToUnits("1000.00")).toBe(1_000_000_000n);
  expect(usdToUnits("0.000001")).toBe(1n);
  expect(formatUnitsUsd(1_000_000_000n)).toBe("1000");
});

test("usdToUnits rejects non-USD strings", () => {
  expect(() => usdToUnits("ten dollars")).toThrow(/usd/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/units.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/policy/units.ts`**

```ts
import { formatUnits, parseUnits } from "viem";

const USDC_DECIMALS = 6;
const UNIT_SECONDS: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3_600n,
  d: 86_400n,
};

/** Parse "30d" | "24h" | "90m" | "3600s" | "3600" | number into bigint SECONDS. */
export function parseDuration(input: string | number): bigint {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0) throw new Error(`Invalid duration: ${input}`);
    return BigInt(input);
  }
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  const m = /^(\d+)(s|m|h|d)$/.exec(trimmed);
  if (!m) throw new Error(`Invalid duration: "${input}" (use e.g. 30d, 24h, 90m, 3600s)`);
  return BigInt(m[1]) * UNIT_SECONDS[m[2]];
}

/** Parse a plain USD amount string ("1000.00") into 6-decimal USDC base units. */
export function usdToUnits(usd: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(usd.trim())) {
    throw new Error(`Invalid USD amount: "${usd}" (use e.g. 1000.00, max 6 decimals)`);
  }
  return parseUnits(usd.trim(), USDC_DECIMALS);
}

/** Inverse of usdToUnits for display. */
export function formatUnitsUsd(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/units.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/policy/units.ts backend/test/units.test.ts
git commit -m "feat(backend): duration + USD unit helpers (M2)"
```

### Task 2.2: `agent.json` schema (`policy/agentSpec.ts`)

**Files:**
- Create: `backend/src/policy/agentSpec.ts`, `backend/agent.example.json`
- Test: `backend/test/agentSpec.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/agentSpec.test.ts`**

```ts
import { expect, test } from "vitest";
import { parseAgentSpec } from "../src/policy/agentSpec";

const valid = {
  name: "Acme Research Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000cCcc",
    spendingCapUsdc: "1000.00",
    spendingPeriod: "30d",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  metadata: { description: "Does research", agentType: "service", capabilities: ["research"] },
};

test("parseAgentSpec accepts a valid spec and normalizes addresses", () => {
  const spec = parseAgentSpec(valid);
  expect(spec.name).toBe("Acme Research Agent");
  expect(spec.roles.manager).toBe("0x000000000000000000000000000000000000aAaa");
});

test("parseAgentSpec rejects a missing required field with a clear path", () => {
  const bad = structuredClone(valid) as Record<string, unknown>;
  (bad.treasury as Record<string, unknown>).payoutAddress = undefined;
  expect(() => parseAgentSpec(bad)).toThrow(/payoutAddress/);
});

test("parseAgentSpec rejects a bad address", () => {
  const bad = structuredClone(valid);
  bad.roles.manager = "0xnotanaddress";
  expect(() => parseAgentSpec(bad)).toThrow(/manager/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/agentSpec.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/policy/agentSpec.ts`**

```ts
import { getAddress, isAddress } from "viem";
import { z } from "zod";

const addr = z
  .string()
  .refine((s) => isAddress(s), { message: "must be a 0x address" })
  .transform((s) => getAddress(s));

export const AgentSpecSchema = z.object({
  name: z.string().min(1),
  jurisdiction: z.string().default("Wyoming-DAO-LLC"),
  roles: z.object({
    manager: addr,
    guardian: addr,
    operator: addr.optional(), // usually created by Turnkey; may be pinned for tests
  }),
  treasury: z.object({
    usdc: addr.optional(), // defaults to config USDC in the translator
    payoutAddress: addr,
    spendingCapUsdc: z.string(),
    spendingPeriod: z.union([z.string(), z.number()]),
    allowlistEnabled: z.boolean().default(false),
  }),
  governance: z.object({
    amendmentDelay: z.union([z.string(), z.number()]).default("24h"),
  }),
  legal: z
    .object({
      ein: z.string().optional(),
      formationDate: z.string().optional(), // ISO date; stubbed if absent
    })
    .default({}),
  metadata: z
    .object({
      description: z.string().default(""),
      agentType: z.string().default("service"),
      capabilities: z.array(z.string()).default([]),
      version: z.string().default("1"),
    })
    .default({}),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** Parse + validate an agent.json object. Throws a readable error keyed by field path. */
export function parseAgentSpec(input: unknown): AgentSpec {
  const parsed = AgentSpecSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`Invalid agent spec: ${first.path.join(".")} — ${first.message}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Write `backend/agent.example.json`**

```json
{
  "name": "Acme Research Agent",
  "jurisdiction": "Wyoming-DAO-LLC",
  "roles": {
    "manager": "0x0000000000000000000000000000000000000001",
    "guardian": "0x0000000000000000000000000000000000000002"
  },
  "treasury": {
    "payoutAddress": "0x0000000000000000000000000000000000000003",
    "spendingCapUsdc": "1000.00",
    "spendingPeriod": "30d",
    "allowlistEnabled": false
  },
  "governance": { "amendmentDelay": "24h" },
  "legal": { "formationDate": "2026-06-10" },
  "metadata": {
    "description": "Autonomous research agent",
    "agentType": "service",
    "capabilities": ["research", "summarization"],
    "version": "1"
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/agentSpec.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/policy/agentSpec.ts backend/agent.example.json backend/test/agentSpec.test.ts
git commit -m "feat(backend): agent.json zod schema + example (M2)"
```

### Task 2.3: The law→code `translator` (PURE)

**Files:**
- Create: `backend/src/policy/translator.ts`
- Test: `backend/test/translator.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/translator.test.ts`**

```ts
import { expect, test } from "vitest";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { TranslationError, translate } from "../src/policy/translator";

const USDC = "0x3600000000000000000000000000000000000000";
const spec = (over: Record<string, unknown> = {}) =>
  parseAgentSpec({
    name: "A",
    roles: { manager: "0x0000000000000000000000000000000000000001", guardian: "0x0000000000000000000000000000000000000002" },
    treasury: { payoutAddress: "0x0000000000000000000000000000000000000003", spendingCapUsdc: "1000.00", spendingPeriod: "30d", allowlistEnabled: false },
    governance: { amendmentDelay: "24h" },
    ...over,
  });

test("translate maps legal terms to the exact on-chain param tuple", () => {
  const r = translate(spec(), { usdc: USDC });
  expect(r.amendmentDelay).toBe(86_400n);
  expect(r.treasury.cap).toBe(1_000_000_000n); // 1000 USDC, 6 decimals
  expect(r.treasury.period).toBe(2_592_000n); // 30d
  expect(r.treasury.usdc).toBe(USDC);
  expect(r.treasury.payoutAddress).toBe("0x0000000000000000000000000000000000000003");
  expect(r.manager).toBe("0x0000000000000000000000000000000000000001");
  expect(r.legal.ein).toBe("STUB-NOT-FILED");
});

test("translate rejects an amendmentDelay below the 1h on-chain minimum", () => {
  expect(() => translate(spec({ governance: { amendmentDelay: "30m" } }), { usdc: USDC })).toThrow(TranslationError);
});

test("translate rejects a spending period above the 365d on-chain maximum", () => {
  expect(() => translate(spec({ treasury: { payoutAddress: "0x0000000000000000000000000000000000000003", spendingCapUsdc: "1", spendingPeriod: "400d", allowlistEnabled: false } }), { usdc: USDC })).toThrow(/period/i);
});

test("translate enforces role distinctness it can check pre-operator", () => {
  const same = spec({ roles: { manager: "0x0000000000000000000000000000000000000001", guardian: "0x0000000000000000000000000000000000000001" } });
  expect(() => translate(same, { usdc: USDC })).toThrow(/distinct/i);
});

test("translate enforces payout != operator when operator is pinned", () => {
  const pinned = spec({ roles: { manager: "0x0000000000000000000000000000000000000001", guardian: "0x0000000000000000000000000000000000000002", operator: "0x0000000000000000000000000000000000000003" } });
  // payout (…0003) == operator (…0003) -> must throw
  expect(() => translate(pinned, { usdc: USDC })).toThrow(/payout/i);
});

test("translate parses an ISO formationDate to unix seconds", () => {
  const r = translate(spec({ legal: { formationDate: "2026-06-10" } }), { usdc: USDC });
  expect(r.legal.formationDate).toBe(Math.floor(Date.UTC(2026, 5, 10) / 1000));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/translator.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/policy/translator.ts`**

```ts
import type { AgentSpec } from "./agentSpec";
import { parseDuration, usdToUnits } from "./units";
import type { Address, TreasuryConfig } from "../types";

/** On-chain bounds duplicated from the contracts so we fail fast OFF-chain with clear messages. */
const MIN_AMENDMENT_DELAY = 3_600n; // LegalManager.MIN_AMENDMENT_DELAY (1h); also AgentTreasury.MIN_POLICY_DELAY
const MAX_POLICY_PERIOD = 31_536_000n; // AgentTreasury.MAX_POLICY_PERIOD (365d)

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export interface TranslateResult {
  manager: Address;
  guardian: Address;
  /** Present only if pinned in the spec; otherwise filled by the Turnkey step in the saga. */
  operator?: Address;
  amendmentDelay: bigint;
  treasury: TreasuryConfig;
  legal: { ein: string; formationDate: number };
}

function isoToUnix(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TranslationError(`legal.formationDate is not a valid date: "${iso}"`);
  return Math.floor(ms / 1000);
}

/**
 * PURE law→code translation: an agent spec + the platform USDC default → the precise
 * on-chain parameter tuple (amendmentDelay, TreasuryConfig, roles, legal stub).
 * No I/O, no clock, no chain reads — fully deterministic and unit-tested.
 */
export function translate(spec: AgentSpec, defaults: { usdc: Address }): TranslateResult {
  const amendmentDelay = parseDuration(spec.governance.amendmentDelay);
  if (amendmentDelay < MIN_AMENDMENT_DELAY) {
    throw new TranslationError(`governance.amendmentDelay must be >= 1h (got ${amendmentDelay}s)`);
  }

  const period = parseDuration(spec.treasury.spendingPeriod);
  if (period === 0n) throw new TranslationError("treasury.spendingPeriod must be > 0");
  if (period > MAX_POLICY_PERIOD) {
    throw new TranslationError(`treasury.spendingPeriod must be <= 365d (got ${period}s)`);
  }

  const cap = usdToUnits(spec.treasury.spendingCapUsdc);
  const usdc = (spec.treasury.usdc ?? defaults.usdc) as Address;
  const payoutAddress = spec.treasury.payoutAddress as Address;
  const manager = spec.roles.manager as Address;
  const guardian = spec.roles.guardian as Address;
  const operator = spec.roles.operator as Address | undefined;

  // Role distinctness the contract enforces (RolesMustDiffer + payout != operator).
  if (manager.toLowerCase() === guardian.toLowerCase()) {
    throw new TranslationError("roles.manager and roles.guardian must be distinct");
  }
  if (operator) {
    const lc = operator.toLowerCase();
    if (lc === manager.toLowerCase() || lc === guardian.toLowerCase()) {
      throw new TranslationError("roles.operator must be distinct from manager and guardian");
    }
    if (lc === payoutAddress.toLowerCase()) {
      throw new TranslationError("treasury.payoutAddress must not equal the operator (safe-sink rule)");
    }
  }

  const ein = spec.legal.ein ?? "STUB-NOT-FILED";
  const formationDate = spec.legal.formationDate ? isoToUnix(spec.legal.formationDate) : 0;

  return {
    manager,
    guardian,
    operator,
    amendmentDelay,
    treasury: { usdc, payoutAddress, cap, period, allowlistEnabled: spec.treasury.allowlistEnabled },
    legal: { ein, formationDate },
  };
}

/**
 * Late check used by the saga once the operator address is known (Turnkey step): re-validate the
 * operator-dependent distinctness rules. Throws TranslationError on violation.
 */
export function assertOperatorDistinct(r: TranslateResult, operator: Address): void {
  const lc = operator.toLowerCase();
  if (lc === r.manager.toLowerCase() || lc === r.guardian.toLowerCase()) {
    throw new TranslationError("operator must be distinct from manager and guardian");
  }
  if (lc === r.treasury.payoutAddress.toLowerCase()) {
    throw new TranslationError("treasury.payoutAddress must not equal the operator (safe-sink rule)");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/translator.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/policy/translator.ts backend/test/translator.test.ts
git commit -m "feat(backend): pure law->code policy translator (M2)"
```

### Task 2.4: OA generator (doc + metadata + deterministic `oaHash`)

**Files:**
- Create: `backend/src/oa/generator.ts`
- Test: `backend/test/generator.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/generator.test.ts`**

```ts
import { expect, test } from "vitest";
import { computeOaHash, renderMetadata, renderOperatingAgreement } from "../src/oa/generator";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { translate } from "../src/policy/translator";

const USDC = "0x3600000000000000000000000000000000000000";
const spec = parseAgentSpec({
  name: "Acme",
  roles: { manager: "0x0000000000000000000000000000000000000001", guardian: "0x0000000000000000000000000000000000000002" },
  treasury: { payoutAddress: "0x0000000000000000000000000000000000000003", spendingCapUsdc: "1000.00", spendingPeriod: "30d", allowlistEnabled: false },
  governance: { amendmentDelay: "24h" },
});
const resolved = translate(spec, { usdc: USDC });

test("oaHash is deterministic for identical inputs", () => {
  const doc1 = renderOperatingAgreement(spec, resolved);
  const doc2 = renderOperatingAgreement(spec, resolved);
  expect(computeOaHash(doc1)).toBe(computeOaHash(doc2));
  expect(computeOaHash(doc1)).toMatch(/^0x[0-9a-f]{64}$/);
});

test("oaHash changes when a material term changes (the cap)", () => {
  const other = translate(parseAgentSpec({ ...spec, treasury: { ...spec.treasury, spendingCapUsdc: "2000.00" } }), { usdc: USDC });
  const a = computeOaHash(renderOperatingAgreement(spec, resolved));
  const b = computeOaHash(renderOperatingAgreement(spec, other));
  expect(a).not.toBe(b);
});

test("renderMetadata embeds the ERC-8004 fields + oaHash", () => {
  const doc = renderOperatingAgreement(spec, resolved);
  const meta = renderMetadata(spec, resolved, computeOaHash(doc));
  expect(meta.name).toBe("Acme");
  expect(meta.legalBody.oaHash).toBe(computeOaHash(doc));
  expect(meta.legalBody.jurisdiction).toBe("Wyoming-DAO-LLC");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/generator.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/oa/generator.ts`**

```ts
import { type Hex, keccak256, toHex } from "viem";
import type { AgentSpec } from "../policy/agentSpec";
import { formatUnitsUsd } from "../policy/units";
import type { TranslateResult } from "../policy/translator";

/**
 * Render a canonical operating-agreement document. MUST be deterministic: explicit field order,
 * no timestamps / random data, so computeOaHash is stable for identical inputs.
 */
export function renderOperatingAgreement(spec: AgentSpec, r: TranslateResult): string {
  const lines = [
    `# Operating Agreement — ${spec.name}`,
    "",
    `Jurisdiction: ${spec.jurisdiction}`,
    `EIN: ${r.legal.ein}`,
    `Formation date (unix): ${r.legal.formationDate}`,
    "",
    "## Roles",
    `- Manager (platform controller): ${r.manager}`,
    `- Guardian (human registrant; pause/veto/rescue): ${r.guardian}`,
    `- Operator (agent spending key): ${r.operator ?? "<assigned at onboarding>"}`,
    "",
    "## Treasury policy",
    `- USDC token: ${r.treasury.usdc}`,
    `- Payout (safe sink) address: ${r.treasury.payoutAddress}`,
    `- Spending cap per window: ${formatUnitsUsd(r.treasury.cap)} USDC`,
    `- Window length (seconds): ${r.treasury.period}`,
    `- Allowlist enforced: ${r.treasury.allowlistEnabled}`,
    "",
    "## Governance",
    `- Amendment / dissolution timelock (seconds): ${r.amendmentDelay}`,
    "",
    "This agreement is enforced on-chain by the LegalManager + AgentTreasury contracts on Arc.",
    "",
  ];
  return lines.join("\n");
}

/** keccak256 over the UTF-8 document bytes — the on-chain operatingAgreementHash. */
export function computeOaHash(doc: string): Hex {
  return keccak256(toHex(doc));
}

export interface AgentMetadata {
  name: string;
  description: string;
  agent_type: string;
  capabilities: string[];
  version: string;
  legalBody: {
    jurisdiction: string;
    ein: string;
    formationDate: number;
    oaHash: Hex;
  };
}

/** ERC-8004 metadata JSON (the metadataURI target in v1; stored locally). */
export function renderMetadata(spec: AgentSpec, r: TranslateResult, oaHash: Hex): AgentMetadata {
  return {
    name: spec.name,
    description: spec.metadata.description,
    agent_type: spec.metadata.agentType,
    capabilities: spec.metadata.capabilities,
    version: spec.metadata.version,
    legalBody: {
      jurisdiction: spec.jurisdiction,
      ein: r.legal.ein,
      formationDate: r.legal.formationDate,
      oaHash,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/generator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full M2 suite**

Run: `npx vitest run test/units.test.ts test/agentSpec.test.ts test/translator.test.ts test/generator.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/oa/generator.ts backend/test/generator.test.ts
git commit -m "feat(backend): OA generator + deterministic oaHash + metadata (M2)"
```

---

## Milestone M3 — `adapters/arc` + anvil integration of `createEntity`

### Task 3.1: viem client factories

**Files:**
- Create: `backend/src/adapters/arc/clients.ts`
- Test: `backend/test/clients.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/clients.test.ts`**

```ts
import { expect, test } from "vitest";
import { loadConfig } from "../src/config/env";
import { managerAccount, publicClientFor, managerWalletClient } from "../src/adapters/arc/clients";

const cfg = loadConfig({
  ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
  ARC_CHAIN_ID: "5042002",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
});

test("managerAccount derives an address from the platform key", () => {
  expect(managerAccount(cfg).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test("client factories build without throwing", () => {
  expect(publicClientFor(cfg).chain?.id).toBe(5042002);
  expect(managerWalletClient(cfg).account?.address).toBe(managerAccount(cfg).address);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/clients.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/adapters/arc/clients.ts`**

```ts
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { chainFor } from "../../chains";
import type { Config } from "../../config/env";

/** The platform/manager account (Factory owner + setAgentWallet caller). */
export function managerAccount(cfg: Config): PrivateKeyAccount {
  return privateKeyToAccount(cfg.platformPrivateKey);
}

export function publicClientFor(cfg: Config): PublicClient {
  return createPublicClient({ chain: chainFor(cfg.chainId, cfg.rpcUrl), transport: http(cfg.rpcUrl) });
}

export function managerWalletClient(cfg: Config): WalletClient {
  return createWalletClient({
    account: managerAccount(cfg),
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/clients.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/clients.ts backend/test/clients.test.ts
git commit -m "feat(backend): viem client factories for Arc (M3)"
```

### Task 3.2: `buildWalletSetTypedData` (pure EIP-712 builder)

**Files:**
- Create: `backend/src/adapters/arc/walletSet.ts`
- Test: `backend/test/walletSet.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/walletSet.test.ts`**

```ts
import { expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";

const operator = privateKeyToAccount(`0x${"2".repeat(64)}`);

const td = buildWalletSetTypedData({
  agentId: 0n,
  newWallet: operator.address,
  owner: "0x0000000000000000000000000000000000000001",
  deadline: 1_900_000_000n,
  chainId: 31337,
  registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
});

test("typed data matches the AgentWalletSet typehash field order", () => {
  expect(td.primaryType).toBe("AgentWalletSet");
  expect(td.domain).toMatchObject({ name: "AgentIdentity", version: "1", chainId: 31337 });
  expect(td.types.AgentWalletSet.map((f) => f.name)).toEqual(["agentId", "newWallet", "owner", "deadline"]);
});

test("a signature from newWallet recovers back to newWallet (ECDSA path the contract uses)", async () => {
  const sig = await operator.signTypedData(td);
  const recovered = await recoverTypedDataAddress({ ...td, signature: sig });
  expect(recovered.toLowerCase()).toBe(operator.address.toLowerCase());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/walletSet.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/adapters/arc/walletSet.ts`**

```ts
import type { Address, TypedDataDefinition } from "viem";

export interface WalletSetArgs {
  agentId: bigint;
  newWallet: Address; // == agentWallet == operator (the wallet that MUST sign)
  owner: Address; // current NFT owner (== manager after createEntity)
  deadline: bigint;
  chainId: number;
  registry: Address; // EIP-712 verifyingContract
}

/**
 * Build the EIP-712 AgentWalletSet typed data the registry verifies. The field order MUST match the
 * canonical typehash exactly:
 *   AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)
 *
 * The signature must be produced by `newWallet` (the bound wallet); the on-chain caller must be `owner`.
 *
 * Domain (name "AgentIdentity", version "1") matches the MockIdentityRegistry used in integration
 * tests. NOTE: confirm the LIVE registry's domain (EIP-5267 eip712Domain()) before the Arc-testnet
 * smoke test — a mismatch makes the real setAgentWallet revert with "bad signature".
 */
export function buildWalletSetTypedData(args: WalletSetArgs): TypedDataDefinition {
  return {
    domain: {
      name: "AgentIdentity",
      version: "1",
      chainId: args.chainId,
      verifyingContract: args.registry,
    },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: {
      agentId: args.agentId,
      newWallet: args.newWallet,
      owner: args.owner,
      deadline: args.deadline,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walletSet.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/walletSet.ts backend/test/walletSet.test.ts
git commit -m "feat(backend): pure EIP-712 AgentWalletSet typed-data builder (M3)"
```

### Task 3.3: anvil test harness + stack deployer

**Files:**
- Create: `backend/test/helpers/artifacts.ts`, `backend/test/helpers/anvil.ts`, `backend/test/helpers/stack.ts`
- Test: `backend/test/helpers/anvil.smoke.int.test.ts`

- [ ] **Step 1: Write `backend/test/helpers/artifacts.ts`**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";

// vitest runs with cwd = backend/, so Foundry out/ is one level up.
const OUT = resolve(process.cwd(), "..", "out");

export function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(resolve(OUT, `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}
```

- [ ] **Step 2: Write `backend/test/helpers/anvil.ts`**

```ts
import { type ChildProcess, spawn } from "node:child_process";

export interface AnvilHandle {
  rpcUrl: string;
  stop: () => void;
}

/** Spawn a local anvil and resolve once it is listening. Caller must stop() in afterAll. */
export function startAnvil(port = 8545): Promise<AnvilHandle> {
  return new Promise((resolvePromise, reject) => {
    const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rpcUrl = `http://127.0.0.1:${port}`;
    let settled = false;

    const onData = (buf: Buffer) => {
      if (!settled && buf.toString().includes("Listening on")) {
        settled = true;
        resolvePromise({ rpcUrl, stop: () => proc.kill("SIGTERM") });
      }
    };
    proc.stdout?.on("data", onData);
    // --silent suppresses stdout; fall back to a readiness poll via a short timer.
    const pollStart = Date.now();
    const poll = setInterval(async () => {
      if (settled) return clearInterval(poll);
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        if (res.ok) {
          settled = true;
          clearInterval(poll);
          resolvePromise({ rpcUrl, stop: () => proc.kill("SIGTERM") });
        }
      } catch {
        if (Date.now() - pollStart > 20_000) {
          clearInterval(poll);
          reject(new Error("anvil did not become ready in 20s"));
        }
      }
    }, 200);
    proc.on("error", (e) => !settled && reject(e));
  });
}
```

- [ ] **Step 3: Write `backend/test/helpers/stack.ts`**

```ts
import {
  type Address,
  type PublicClient,
  type WalletClient,
  getAddress,
} from "viem";
import { loadArtifact } from "./artifacts";

export interface DeployedStack {
  usdc: Address;
  registry: Address;
  impl: Address;
  factory: Address;
}

async function deploy(
  wallet: WalletClient,
  pub: PublicClient,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: constructor args vary by contract
  args: any[] = [],
): Promise<Address> {
  const { abi, bytecode } = loadArtifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args, account: wallet.account!, chain: wallet.chain });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`);
  return getAddress(receipt.contractAddress);
}

/**
 * Deploy the full stack to a local anvil: MockUSDC, MockIdentityRegistry, LegalManager impl,
 * and the real LegalManagerFactory(impl, registry, beaconOwner). Mirrors script/Deploy.s.sol but
 * against the mock registry so tests exercise the real Factory bytecode end-to-end.
 */
export async function deployStack(
  wallet: WalletClient,
  pub: PublicClient,
  beaconOwner: Address,
): Promise<DeployedStack> {
  const usdc = await deploy(wallet, pub, "MockUSDC");
  const registry = await deploy(wallet, pub, "MockIdentityRegistry");
  const impl = await deploy(wallet, pub, "LegalManager");
  const factory = await deploy(wallet, pub, "LegalManagerFactory", [impl, registry, beaconOwner]);
  return { usdc, registry, impl, factory };
}
```

- [ ] **Step 4: Write the integration smoke test `backend/test/helpers/anvil.smoke.int.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "./anvil";
import { deployStack } from "./stack";

// anvil default account #0
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

let anvil: AnvilHandle;
beforeAll(async () => (anvil = await startAnvil(8545)), 30_000);
afterAll(() => anvil?.stop());

test("anvil starts and the full stack deploys", async () => {
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: DEPLOYER, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, DEPLOYER.address);
  expect(stack.factory).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // Factory.beacon() is set in the constructor.
  const beacon = await pub.readContract({
    abi: (await import("../../src/abis/generated")).legalManagerFactoryAbi,
    address: stack.factory,
    functionName: "beacon",
  });
  expect(beacon).toMatch(/^0x[0-9a-fA-F]{40}$/);
}, 30_000);
```

- [ ] **Step 5: Run the integration smoke test**

Run (from `backend/`, anvil must be installed/on PATH): `npx vitest run test/helpers/anvil.smoke.int.test.ts`
Expected: PASS — anvil spawns, stack deploys, `beacon()` returns an address.

- [ ] **Step 6: Commit**

```bash
git add backend/test/helpers/artifacts.ts backend/test/helpers/anvil.ts backend/test/helpers/stack.ts backend/test/helpers/anvil.smoke.int.test.ts
git commit -m "test(backend): anvil harness + stack deployer (M3)"
```

### Task 3.4: `ArcAdapter.createEntity` (simulate + write + parse events)

**Files:**
- Create: `backend/src/adapters/arc/arcAdapter.ts`
- Test: `backend/test/arcAdapter.createEntity.int.test.ts`

- [ ] **Step 1: Write the failing integration test `backend/test/arcAdapter.createEntity.int.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilChain } from "../src/chains";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const ACCT = (i: number) =>
  privateKeyToAccount(
    [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ][i] as `0x${string}`,
  );

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
const manager = ACCT(0);
const guardian = ACCT(1).address;
const operator = ACCT(2).address;
const payout = ACCT(3).address;

beforeAll(async () => {
  anvil = await startAnvil(8546);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
}, 40_000);
afterAll(() => anvil?.stop());

test("createEntity registers, deploys, transfers NFT to manager, and returns ids from events", async () => {
  const res = await adapter.createEntity({
    manager: manager.address,
    guardian,
    operator,
    amendmentDelay: 3_600n,
    metadataURI: "file:///tmp/meta.json",
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    operatingAgreementHash: `0x${"ab".repeat(32)}`,
    treasury: { usdc: stack.usdc, payoutAddress: payout, cap: 1_000_000n, period: 2_592_000n, allowlistEnabled: false },
  });

  expect(res.agentId).toBe(0n); // registry assigns id 0 first
  expect(res.proxy).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(res.treasury).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // NFT now owned by manager; agentWallet still the factory (binding is a later step).
  expect((await adapter.ownerOf(0n)).toLowerCase()).toBe(manager.address.toLowerCase());
  expect((await adapter.getAgentWallet(0n)).toLowerCase()).toBe(stack.factory.toLowerCase());
}, 40_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/arcAdapter.createEntity.int.test.ts`
Expected: FAIL — cannot find `../src/adapters/arc/arcAdapter`.

- [ ] **Step 3: Write `backend/src/adapters/arc/arcAdapter.ts`** (createEntity + reads; setAgentWallet added in M4)

```ts
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseEventLogs,
} from "viem";
import { agentTreasuryAbi, iIdentityRegistryAbi, legalManagerAbi, legalManagerFactoryAbi } from "../../abis/generated";
import type { TreasuryConfig } from "../../types";

export interface ArcAdapterDeps {
  publicClient: PublicClient;
  managerWallet: WalletClient; // signs/sends as the manager (Factory owner)
  chainId: number;
  factory: Address;
  identityRegistry: Address;
}

export interface CreateEntityParams {
  manager: Address;
  guardian: Address;
  operator: Address;
  amendmentDelay: bigint;
  metadataURI: string;
  ein: string;
  formationDate: number;
  operatingAgreementHash: Hex;
  treasury: TreasuryConfig;
}

export interface CreateEntityResult {
  agentId: bigint;
  proxy: Address;
  treasury: Address;
  txHash: Hex;
}

export class ArcAdapter {
  constructor(private readonly d: ArcAdapterDeps) {}

  /**
   * Call factory.createEntity. The result ids are read back from the EntityCreated/TreasuryCreated
   * events (the on-chain source of truth) rather than from simulate, so a racing tx can't desync ids.
   * simulate is still used to surface reverts with a decoded reason before broadcasting.
   */
  async createEntity(p: CreateEntityParams): Promise<CreateEntityResult> {
    const args = [
      p.manager,
      p.guardian,
      p.operator,
      p.amendmentDelay,
      p.metadataURI,
      p.ein,
      BigInt(p.formationDate),
      p.operatingAgreementHash,
      {
        usdc: p.treasury.usdc,
        payoutAddress: p.treasury.payoutAddress,
        cap: p.treasury.cap,
        period: p.treasury.period,
        allowlistEnabled: p.treasury.allowlistEnabled,
      },
    ] as const;

    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.factory,
      abi: legalManagerFactoryAbi,
      functionName: "createEntity",
      args,
      account: this.d.managerWallet.account!,
    });
    const txHash = await this.d.managerWallet.writeContract(request);
    const receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });

    const events = parseEventLogs({ abi: legalManagerFactoryAbi, logs: receipt.logs });
    const created = events.find((e) => e.eventName === "EntityCreated");
    const treasuryEvt = events.find((e) => e.eventName === "TreasuryCreated");
    if (!created || !treasuryEvt) throw new Error("createEntity: EntityCreated/TreasuryCreated not emitted");

    return {
      // biome-ignore lint/suspicious/noExplicitAny: event args typed by viem; narrow at access
      agentId: (created.args as any).agentId as bigint,
      proxy: (created.args as any).proxy as Address,
      treasury: (treasuryEvt.args as any).treasury as Address,
      txHash,
    };
  }

  ownerOf(agentId: bigint): Promise<Address> {
    return this.d.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    }) as Promise<Address>;
  }

  getAgentWallet(agentId: bigint): Promise<Address> {
    return this.d.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    }) as Promise<Address>;
  }

  treasuryAvailable(treasury: Address): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "available",
    }) as Promise<bigint>;
  }

  legalStatus(proxy: Address): Promise<number> {
    return this.d.publicClient.readContract({
      address: proxy,
      abi: legalManagerAbi,
      functionName: "status",
    }) as Promise<number>;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/arcAdapter.createEntity.int.test.ts`
Expected: PASS — agentId 0, owner == manager, agentWallet == factory.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/arcAdapter.ts backend/test/arcAdapter.createEntity.int.test.ts
git commit -m "feat(backend): ArcAdapter.createEntity via events + reads (M3)"
```

---

## Milestone M4 — operator signer (Turnkey) + `setAgentWallet` binding

### Task 4.1: `OperatorSigner` interface + `LocalKeySigner`

**Files:**
- Create: `backend/src/adapters/turnkey/signer.ts`
- Test: `backend/test/signer.test.ts`

- [ ] **Step 1: Write the failing test `backend/test/signer.test.ts`**

```ts
import { expect, test } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";

test("LocalKeySigner exposes its address and signs AgentWalletSet typed data", async () => {
  const signer = new LocalKeySigner(`0x${"2".repeat(64)}`);
  const td = buildWalletSetTypedData({
    agentId: 0n,
    newWallet: signer.address,
    owner: "0x0000000000000000000000000000000000000001",
    deadline: 1_900_000_000n,
    chainId: 31337,
    registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  });
  const sig = await signer.signWalletSet(td);
  const recovered = await recoverTypedDataAddress({ ...td, signature: sig });
  expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/signer.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `backend/src/adapters/turnkey/signer.ts`**

```ts
import type { Address, Hex, TypedDataDefinition } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/**
 * The agent's operator key (the bound agentWallet). It must produce the EIP-712 AgentWalletSet
 * signature for setAgentWallet. It does NOT send transactions (no gas) — the manager does that.
 * v1 demo: LocalKeySigner. Production: TurnkeySigner (Task 4.3), same interface.
 */
export interface OperatorSigner {
  readonly address: Address;
  signWalletSet(typedData: TypedDataDefinition): Promise<Hex>;
}

export class LocalKeySigner implements OperatorSigner {
  private readonly account: PrivateKeyAccount;
  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }
  get address(): Address {
    return this.account.address;
  }
  signWalletSet(typedData: TypedDataDefinition): Promise<Hex> {
    return this.account.signTypedData(typedData);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/signer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/turnkey/signer.ts backend/test/signer.test.ts
git commit -m "feat(backend): OperatorSigner interface + LocalKeySigner (M4)"
```

### Task 4.2: `ArcAdapter.setAgentWallet` + full bind flow on anvil

**Files:**
- Modify: `backend/src/adapters/arc/arcAdapter.ts`
- Test: `backend/test/arcAdapter.bind.int.test.ts`

- [ ] **Step 1: Write the failing integration test `backend/test/arcAdapter.bind.int.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilChain } from "../src/chains";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";
import { mockIdentityRegistryAbi } from "../src/abis/generated";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let pub: ReturnType<typeof createPublicClient>;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]).address;
const operatorSigner = new LocalKeySigner(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;

beforeAll(async () => {
  anvil = await startAnvil(8547);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({ publicClient: pub, managerWallet: wallet, chainId: anvilChain.id, factory: stack.factory, identityRegistry: stack.registry });
  await adapter.createEntity({
    manager: manager.address, guardian, operator: operatorSigner.address, amendmentDelay: 3_600n,
    metadataURI: "file:///tmp/meta.json", ein: "STUB-NOT-FILED", formationDate: 0,
    operatingAgreementHash: `0x${"ab".repeat(32)}`,
    treasury: { usdc: stack.usdc, payoutAddress: payout, cap: 1_000_000n, period: 2_592_000n, allowlistEnabled: false },
  });
}, 40_000);
afterAll(() => anvil?.stop());

test("operator signs, manager sends -> getAgentWallet becomes the operator", async () => {
  const deadline = await adapter.walletSetDeadline();
  const td = buildWalletSetTypedData({ agentId: 0n, newWallet: operatorSigner.address, owner: manager.address, deadline, chainId: anvilChain.id, registry: stack.registry });

  // belt-and-suspenders: our off-chain digest must equal the registry's on-chain digest
  const onChainDigest = await pub.readContract({ address: stack.registry, abi: mockIdentityRegistryAbi, functionName: "walletSetDigest", args: [0n, operatorSigner.address, manager.address, deadline] });
  const { hashTypedData } = await import("viem");
  expect(hashTypedData(td)).toBe(onChainDigest);

  const signature = await operatorSigner.signWalletSet(td);
  await adapter.setAgentWallet({ agentId: 0n, newWallet: operatorSigner.address, deadline, signature });

  expect((await adapter.getAgentWallet(0n)).toLowerCase()).toBe(operatorSigner.address.toLowerCase());
}, 40_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/arcAdapter.bind.int.test.ts`
Expected: FAIL — `adapter.setAgentWallet`/`adapter.walletSetDeadline` are not functions.

- [ ] **Step 3: Add `setAgentWallet` + `walletSetDeadline` to `backend/src/adapters/arc/arcAdapter.ts`**

Add these imports/usages — `setAgentWallet` is called by the manager (owner); the `signature` is supplied by the operator. Insert the following methods into the `ArcAdapter` class (after `createEntity`):

```ts
  /**
   * Compute a safe deadline from CHAIN time (not local clock): block.timestamp + 30 min.
   * The registry requires now <= deadline <= now + 1h, so a chain-derived value avoids skew.
   */
  async walletSetDeadline(): Promise<bigint> {
    const block = await this.d.publicClient.getBlock({ blockTag: "latest" });
    return block.timestamp + 1_800n;
  }

  /** Bind the agent's wallet. Caller = manager (NFT owner); signature must be from `newWallet`. */
  async setAgentWallet(p: { agentId: bigint; newWallet: Address; deadline: bigint; signature: Hex }): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "setAgentWallet",
      args: [p.agentId, p.newWallet, p.deadline, p.signature],
      account: this.d.managerWallet.account!,
    });
    const txHash = await this.d.managerWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/arcAdapter.bind.int.test.ts`
Expected: PASS — off-chain digest equals on-chain digest; after bind, `getAgentWallet(0)` == operator.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/arcAdapter.ts backend/test/arcAdapter.bind.int.test.ts
git commit -m "feat(backend): ArcAdapter.setAgentWallet + full bind flow (M4)"
```

### Task 4.3: `TurnkeySigner` (enclave key) — implementation + env-gated live smoke

**Files:**
- Create: `backend/src/adapters/turnkey/turnkeySigner.ts`
- Test: `backend/test/turnkeySigner.live.test.ts`

> The `@turnkey/sdk-server` / `@turnkey/viem` APIs evolve. Before writing this task, run `npm install @turnkey/sdk-server@latest @turnkey/viem@latest` and **verify the client construction + account factory against current Turnkey docs** (carried design risk). The code below targets the documented `createAccount({ client, organizationId, signWith })` viem-account factory; adjust names if the SDK has changed.

- [ ] **Step 1: Install Turnkey deps**

Run (from `backend/`):

```bash
npm install @turnkey/sdk-server@latest @turnkey/viem@latest
```

- [ ] **Step 2: Write `backend/src/adapters/turnkey/turnkeySigner.ts`**

```ts
import type { Address, Hex, TypedDataDefinition } from "viem";
import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import type { OperatorSigner } from "./signer";

export interface TurnkeyConfig {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
  baseUrl: string;
}

/**
 * Operator signer backed by a Turnkey enclave key (non-custodial "infrastructure-mediated
 * self-custody"). Wraps a Turnkey-signed viem LocalAccount. The key never leaves the TEE; we only
 * obtain EIP-712 signatures for setAgentWallet. Provisioning (per-agent sub-org with the human
 * registrant as ROOT + delegated access) is documented in docs/turnkey-setup.md and performed out
 * of band in v1; here we sign with an already-provisioned key id (signWith).
 */
export class TurnkeySigner implements OperatorSigner {
  readonly address: Address;
  // biome-ignore lint/suspicious/noExplicitAny: viem LocalAccount returned by @turnkey/viem
  private readonly account: any;

  private constructor(address: Address, account: unknown) {
    this.address = address;
    this.account = account;
  }

  /** Build a signer for an existing Turnkey wallet/key (signWith = key id or address). */
  static async forKey(cfg: TurnkeyConfig, signWith: string): Promise<TurnkeySigner> {
    const turnkey = new Turnkey({
      apiBaseUrl: cfg.baseUrl,
      apiPublicKey: cfg.apiPublicKey,
      apiPrivateKey: cfg.apiPrivateKey,
      defaultOrganizationId: cfg.organizationId,
    });
    const account = await createAccount({
      client: turnkey.apiClient(),
      organizationId: cfg.organizationId,
      signWith,
    });
    return new TurnkeySigner(account.address as Address, account);
  }

  signWalletSet(typedData: TypedDataDefinition): Promise<Hex> {
    return this.account.signTypedData(typedData);
  }
}
```

- [ ] **Step 3: Write the env-gated live smoke test `backend/test/turnkeySigner.live.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { TurnkeySigner } from "../src/adapters/turnkey/turnkeySigner";

const RUN = !!process.env.TURNKEY_API_PRIVATE_KEY && !!process.env.TURNKEY_SIGN_WITH;

describe.skipIf(!RUN)("Turnkey live smoke", () => {
  test("a Turnkey enclave key signs AgentWalletSet and recovers to itself", async () => {
    const signer = await TurnkeySigner.forKey(
      {
        apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
        apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
        organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
        baseUrl: process.env.TURNKEY_BASE_URL ?? "https://api.turnkey.com",
      },
      process.env.TURNKEY_SIGN_WITH!,
    );
    const td = buildWalletSetTypedData({
      agentId: 0n,
      newWallet: signer.address,
      owner: "0x0000000000000000000000000000000000000001",
      deadline: 1_900_000_000n,
      chainId: 5042002,
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    });
    const sig = await signer.signWalletSet(td);
    expect((await recoverTypedDataAddress({ ...td, signature: sig })).toLowerCase()).toBe(signer.address.toLowerCase());
  }, 30_000);
});
```

- [ ] **Step 4: Verify the smoke test skips cleanly without creds, and typechecks**

Run (from `backend/`):

```bash
npx vitest run test/turnkeySigner.live.test.ts
npx tsc --noEmit
```

Expected: the live test is **skipped** (0 ran, 1 skipped) when `TURNKEY_*` env is unset; `tsc` passes. (With real creds + `TURNKEY_SIGN_WITH`, it runs and passes.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/turnkey/turnkeySigner.ts backend/test/turnkeySigner.live.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(backend): TurnkeySigner (enclave key) + env-gated live smoke (M4)"
```

---

## Milestone M5 — onboarding saga + CLI + Arc-testnet E2E

### Task 5.1: The onboarding saga (idempotent + resumable)

**Files:**
- Create: `backend/src/workflow/onboarding.ts`
- Test: `backend/test/onboarding.int.test.ts`

- [ ] **Step 1: Write the failing integration test `backend/test/onboarding.int.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilChain } from "../src/chains";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { migrate, openDatabase } from "../src/persistence/db";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { runOnboarding } from "../src/workflow/onboarding";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]).address;
const operatorSigner = new LocalKeySigner(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;

const spec = () =>
  parseAgentSpec({
    name: "Saga Agent",
    roles: { manager: manager.address, guardian },
    treasury: { payoutAddress: payout, spendingCapUsdc: "1000.00", spendingPeriod: "30d", allowlistEnabled: false },
    governance: { amendmentDelay: "1h" },
  });

beforeAll(async () => {
  anvil = await startAnvil(8548);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({ publicClient: pub, managerWallet: wallet, chainId: anvilChain.id, factory: stack.factory, identityRegistry: stack.registry });
  const db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "saga-docs-")));
}, 40_000);
afterAll(() => anvil?.stop());

test("full happy path: translate -> generate -> create -> bind, persisted and on-chain", async () => {
  const rec = await runOnboarding({ spec: spec(), idempotencyKey: "agent-A", repo, docStore, arc: adapter, operatorSigner, usdc: stack.usdc });
  expect(rec.status).toBe("bound");
  expect(rec.agentId).toBe("0");
  expect((await adapter.getAgentWallet(0n)).toLowerCase()).toBe(operatorSigner.address.toLowerCase());
  expect(repo.listEvents("agent-A").map((e) => e.step)).toEqual(["createEntity", "setAgentWallet"]);
}, 40_000);

test("resume is idempotent: re-running does NOT mint a second agentId", async () => {
  const before = await adapter.ownerOf(0n);
  const rec = await runOnboarding({ spec: spec(), idempotencyKey: "agent-A", repo, docStore, arc: adapter, operatorSigner, usdc: stack.usdc });
  expect(rec.agentId).toBe("0"); // same id, no new entity
  expect(await adapter.ownerOf(0n)).toBe(before);
  // still exactly one create + one bind event (no duplicates)
  expect(repo.listEvents("agent-A").filter((e) => e.step === "createEntity")).toHaveLength(1);
}, 40_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/onboarding.int.test.ts`
Expected: FAIL — cannot find `../src/workflow/onboarding`.

- [ ] **Step 3: Write `backend/src/workflow/onboarding.ts`**

```ts
import type { Address } from "viem";
import type { ArcAdapter } from "../adapters/arc/arcAdapter";
import { buildWalletSetTypedData } from "../adapters/arc/walletSet";
import type { OperatorSigner } from "../adapters/turnkey/signer";
import { computeOaHash, renderMetadata, renderOperatingAgreement } from "../oa/generator";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { AgentSpec } from "../policy/agentSpec";
import { assertOperatorDistinct, translate } from "../policy/translator";
import type { EntityRecord } from "../types";

export interface OnboardingDeps {
  spec: AgentSpec;
  idempotencyKey: string;
  repo: EntityRepository;
  docStore: DocumentStore;
  arc: ArcAdapter;
  operatorSigner: OperatorSigner;
  usdc: Address; // default USDC for the translator
}

/**
 * Onboarding saga. Idempotent + resumable: each step is skipped if the persisted status is already
 * past it. `createEntity` (which mints a NEW agentId) is NEVER re-run for an existing key — a key
 * with status 'created' or beyond reuses the stored agentId.
 */
export async function runOnboarding(d: OnboardingDeps): Promise<EntityRecord> {
  const key = d.idempotencyKey;
  let rec = d.repo.findByIdempotencyKey(key);

  // ── Step 1+2: translate (pure) + generate OA/metadata. Re-derivable; (re)write if not yet created.
  const r = translate(d.spec, { usdc: d.usdc });
  if (!rec || rec.status === "translating") {
    const operator = d.operatorSigner.address;
    assertOperatorDistinct(r, operator); // operator now known -> full distinctness check
    const resolved = { ...r, operator };
    const doc = renderOperatingAgreement(d.spec, resolved);
    const oaHash = computeOaHash(doc);
    const meta = renderMetadata(d.spec, resolved, oaHash);
    const docPut = d.docStore.put(`oa-${key}.md`, doc);
    const metaPut = d.docStore.put(`meta-${key}.json`, JSON.stringify(meta, null, 2));

    rec = {
      idempotencyKey: key,
      name: d.spec.name,
      status: "translating",
      manager: r.manager,
      guardian: r.guardian,
      operator,
      amendmentDelay: r.amendmentDelay.toString(),
      ein: r.legal.ein,
      formationDate: r.legal.formationDate,
      oaHash,
      metadataURI: metaPut.uri,
      docPath: docPut.path,
      treasuryConfig: r.treasury,
      agentId: null,
      proxy: null,
      treasury: null,
      createTxHash: null,
      bindTxHash: null,
      fundTxHash: null,
    };
    d.repo.upsert(rec);
  }

  // ── Step 4: createEntity (atomic on-chain). Skip if already created.
  if (rec.status === "translating") {
    const res = await d.arc.createEntity({
      manager: rec.manager,
      guardian: rec.guardian,
      operator: rec.operator!,
      amendmentDelay: BigInt(rec.amendmentDelay),
      metadataURI: rec.metadataURI!,
      ein: rec.ein,
      formationDate: rec.formationDate,
      operatingAgreementHash: rec.oaHash!,
      treasury: rec.treasuryConfig!,
    });
    rec = { ...rec, status: "created", agentId: res.agentId.toString(), proxy: res.proxy, treasury: res.treasury, createTxHash: res.txHash };
    d.repo.upsert(rec);
    d.repo.recordEvent(key, "createEntity", "created", res.txHash, JSON.stringify({ agentId: rec.agentId, proxy: rec.proxy, treasury: rec.treasury }));
  }

  // ── Step 5: bind wallet (operator signs, manager sends). Skip if already bound/funded.
  if (rec.status === "created") {
    const agentId = BigInt(rec.agentId!);
    const deadline = await d.arc.walletSetDeadline();
    const td = buildWalletSetTypedData({ agentId, newWallet: rec.operator! as Address, owner: rec.manager, deadline, chainId: chainIdFor(d), registry: registryFor(d) });
    const signature = await d.operatorSigner.signWalletSet(td);
    const txHash = await d.arc.setAgentWallet({ agentId, newWallet: rec.operator! as Address, deadline, signature });
    rec = { ...rec, status: "bound", bindTxHash: txHash };
    d.repo.upsert(rec);
    d.repo.recordEvent(key, "setAgentWallet", "bound", txHash, JSON.stringify({ agentWallet: rec.operator }));
  }

  return rec;
}

// The saga reads chainId/registry from the adapter so anvil (31337) and Arc (5042002) both work.
function chainIdFor(d: OnboardingDeps): number {
  return d.arc.chainId;
}
function registryFor(d: OnboardingDeps): Address {
  return d.arc.identityRegistry;
}
```

- [ ] **Step 4: Expose `chainId` + `identityRegistry` as readable fields on `ArcAdapter`**

In `backend/src/adapters/arc/arcAdapter.ts`, add public getters so the saga can read them. Insert into the class:

```ts
  get chainId(): number {
    return this.d.chainId;
  }
  get identityRegistry(): Address {
    return this.d.identityRegistry;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/onboarding.int.test.ts`
Expected: PASS (2 tests) — happy path reaches `bound`; resume reuses agentId 0 with no duplicate events.

- [ ] **Step 6: Commit**

```bash
git add backend/src/workflow/onboarding.ts backend/src/adapters/arc/arcAdapter.ts backend/test/onboarding.int.test.ts
git commit -m "feat(backend): idempotent/resumable onboarding saga (M5)"
```

### Task 5.2: Optional treasury funding step

**Files:**
- Modify: `backend/src/adapters/arc/arcAdapter.ts`, `backend/src/workflow/onboarding.ts`
- Test: `backend/test/fund.int.test.ts`

- [ ] **Step 1: Write the failing integration test `backend/test/fund.int.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilChain } from "../src/chains";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { mockUsdcAbi } from "../src/abis/generated";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const manager = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const guardian = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").address;
const operator = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").address;
const payout = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6").address;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let pub: ReturnType<typeof createPublicClient>;
let wallet: ReturnType<typeof createWalletClient>;
let treasury: `0x${string}`;

beforeAll(async () => {
  anvil = await startAnvil(8549);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({ publicClient: pub, managerWallet: wallet, chainId: anvilChain.id, factory: stack.factory, identityRegistry: stack.registry });
  const res = await adapter.createEntity({ manager: manager.address, guardian, operator, amendmentDelay: 3_600n, metadataURI: "file:///m", ein: "STUB", formationDate: 0, operatingAgreementHash: `0x${"ab".repeat(32)}`, treasury: { usdc: stack.usdc, payoutAddress: payout, cap: 1_000_000n, period: 2_592_000n, allowlistEnabled: false } });
  treasury = res.treasury;
  // mint USDC to the manager so it can fund
  await wallet.writeContract({ address: stack.usdc, abi: mockUsdcAbi, functionName: "mint", args: [manager.address, 5_000_000n], account: manager, chain: anvilChain });
}, 40_000);
afterAll(() => anvil?.stop());

test("fundTreasury transfers USDC to the treasury vault", async () => {
  await adapter.fundTreasury({ usdc: stack.usdc, treasury, amount: 2_000_000n });
  const bal = await pub.readContract({ address: stack.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [treasury] });
  expect(bal).toBe(2_000_000n);
}, 40_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/fund.int.test.ts`
Expected: FAIL — `adapter.fundTreasury` is not a function.

- [ ] **Step 3: Add `fundTreasury` to `backend/src/adapters/arc/arcAdapter.ts`**

Add the import for the ERC-20 ABI at the top (reuse the registry/treasury ABIs already imported; add the USDC ABI via the generated `iIdentityRegistryAbi` is wrong — use a minimal ERC-20 transfer ABI). Insert a local minimal ABI + method into the class file:

```ts
// near the top of arcAdapter.ts, after imports:
const erc20TransferAbi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;
```

```ts
  /** Optional v1 step: top up the treasury vault with ERC-20 USDC from the manager wallet. */
  async fundTreasury(p: { usdc: Address; treasury: Address; amount: bigint }): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      address: p.usdc,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [p.treasury, p.amount],
      account: this.d.managerWallet.account!,
    });
    const txHash = await this.d.managerWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
```

- [ ] **Step 4: Wire an optional fund step into the saga**

In `backend/src/workflow/onboarding.ts`, extend `OnboardingDeps` with `fundAmount?: bigint` and append, after the bind block:

```ts
  // ── Step 7 (optional): fund the treasury, then mark funded.
  if (d.fundAmount && d.fundAmount > 0n && rec.status === "bound") {
    const txHash = await d.arc.fundTreasury({ usdc: rec.treasuryConfig!.usdc, treasury: rec.treasury! as Address, amount: d.fundAmount });
    rec = { ...rec, status: "funded", fundTxHash: txHash };
    d.repo.upsert(rec);
    d.repo.recordEvent(key, "fundTreasury", "funded", txHash, JSON.stringify({ amount: d.fundAmount.toString() }));
  }
```

And add `fundAmount?: bigint;` to the `OnboardingDeps` interface.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/fund.int.test.ts`
Expected: PASS — treasury USDC balance is 2_000_000n.

- [ ] **Step 6: Commit**

```bash
git add backend/src/adapters/arc/arcAdapter.ts backend/src/workflow/onboarding.ts backend/test/fund.int.test.ts
git commit -m "feat(backend): optional treasury funding step (M5)"
```

### Task 5.3: CLI (`commander`) + CLI E2E against anvil

**Files:**
- Create: `backend/src/cli/index.ts`, `backend/src/cli/context.ts`
- Test: `backend/test/cli.int.test.ts`

- [ ] **Step 1: Write `backend/src/cli/context.ts` (wires config → deps; injectable for tests)**

```ts
import { config as loadDotenv } from "dotenv";
import type { Address } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { LocalKeySigner, type OperatorSigner } from "../adapters/turnkey/signer";
import { managerWalletClient, publicClientFor } from "../adapters/arc/clients";
import { type Config, loadConfig } from "../config/env";
import { FileDocumentStore } from "../persistence/documentStore";
import { migrate, openDatabase } from "../persistence/db";
import { SqliteEntityRepository } from "../persistence/entityRepository";

export interface CliContext {
  cfg: Config;
  repo: SqliteEntityRepository;
  docStore: FileDocumentStore;
  arc: ArcAdapter;
  operatorSigner: OperatorSigner;
}

/** Build the live context from env (.env loaded). Throws if FACTORY_ADDRESS/OPERATOR are missing. */
export function buildContext(): CliContext {
  loadDotenv();
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("FACTORY_ADDRESS is required (deploy first; see M0).");
  if (!cfg.operatorPrivateKey) throw new Error("OPERATOR_PRIVATE_KEY is required in v1 (or wire Turnkey).");

  const db = openDatabase(cfg.dbPath);
  migrate(db);
  const arc = new ArcAdapter({
    publicClient: publicClientFor(cfg),
    managerWallet: managerWalletClient(cfg),
    chainId: cfg.chainId,
    factory: cfg.factoryAddress as Address,
    identityRegistry: cfg.identityRegistry,
  });
  return {
    cfg,
    repo: new SqliteEntityRepository(db),
    docStore: new FileDocumentStore(cfg.docStoreDir),
    arc,
    operatorSigner: new LocalKeySigner(cfg.operatorPrivateKey),
  };
}
```

- [ ] **Step 2: Write `backend/src/cli/index.ts`**

```ts
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { usdToUnits } from "../policy/units";
import { parseAgentSpec } from "../policy/agentSpec";
import { runOnboarding } from "../workflow/onboarding";
import { type CliContext, buildContext } from "./context";

/** Build the commander program. `makeContext` is injectable so tests pass an anvil-backed context. */
export function buildCli(makeContext: () => CliContext = buildContext): Command {
  const program = new Command();
  program.name("legalbody").description("Onboard AI agents into on-chain legal bodies on Arc");

  program
    .command("create-entity")
    .requiredOption("-c, --config <path>", "agent.json path")
    .option("-i, --id <key>", "idempotency key (defaults to the agent name)")
    .option("-f, --fund <usd>", "optional: fund the treasury with this many USDC")
    .action(async (opts) => {
      const ctx = makeContext();
      const spec = parseAgentSpec(JSON.parse(readFileSync(opts.config, "utf8")));
      const idempotencyKey = opts.id ?? spec.name;
      const rec = await runOnboarding({
        spec,
        idempotencyKey,
        repo: ctx.repo,
        docStore: ctx.docStore,
        arc: ctx.arc,
        operatorSigner: ctx.operatorSigner,
        usdc: ctx.cfg.usdc,
        fundAmount: opts.fund ? usdToUnits(opts.fund) : undefined,
      });
      console.log(JSON.stringify({ idempotencyKey, status: rec.status, agentId: rec.agentId, proxy: rec.proxy, treasury: rec.treasury }, null, 2));
    });

  program
    .command("get-entity")
    .argument("<idOrKey>", "agentId or idempotency key")
    .action((idOrKey) => {
      const ctx = makeContext();
      const rec = ctx.repo.findByAgentId(idOrKey) ?? ctx.repo.findByIdempotencyKey(idOrKey);
      if (!rec) {
        console.error(`not found: ${idOrKey}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    });

  program
    .command("list-entities")
    .action(() => {
      const ctx = makeContext();
      const rows = ctx.repo.list().map((r) => ({ key: r.idempotencyKey, name: r.name, status: r.status, agentId: r.agentId }));
      console.log(JSON.stringify(rows, null, 2));
    });

  program
    .command("bind-wallet")
    .argument("<key>", "idempotency key")
    .action(async (key) => {
      const ctx = makeContext();
      const spec = (() => {
        const rec = ctx.repo.findByIdempotencyKey(key);
        if (!rec) throw new Error(`unknown entity: ${key}`);
        return rec;
      })();
      console.log(`re-running onboarding (idempotent) for ${spec.idempotencyKey} from status=${spec.status}`);
      // Re-running the saga resumes bind if needed; create is skipped when already created.
      console.log("note: provide the original agent.json via create-entity to resume; bind-wallet is a status echo in v1.");
    });

  program
    .command("fund-treasury")
    .argument("<key>", "idempotency key")
    .argument("<usd>", "USDC amount")
    .action(async (key, usd) => {
      const ctx = makeContext();
      const rec = ctx.repo.findByIdempotencyKey(key);
      if (!rec?.treasury || !rec.treasuryConfig) throw new Error(`entity ${key} has no treasury yet`);
      const txHash = await ctx.arc.fundTreasury({ usdc: rec.treasuryConfig.usdc, treasury: rec.treasury, amount: usdToUnits(usd) });
      ctx.repo.upsert({ ...rec, status: "funded", fundTxHash: txHash });
      console.log(JSON.stringify({ key, funded: usd, txHash }, null, 2));
    });

  return program;
}

// Entry point when run directly (tsx src/cli/index.ts ...).
if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli().parseAsync(process.argv).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 3: Write the CLI integration test `backend/test/cli.int.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilChain } from "../src/chains";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";
import { buildCli } from "../src/cli/index";
import type { CliContext } from "../src/cli/context";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { migrate, openDatabase } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { loadConfig } from "../src/config/env";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const manager = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const guardian = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").address;
const operatorKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const payout = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6").address;

let anvil: AnvilHandle;
let ctx: CliContext;
let agentJsonPath: string;

beforeAll(async () => {
  anvil = await startAnvil(8550);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, manager.address);
  const db = openDatabase(":memory:");
  migrate(db);
  const cfg = loadConfig({ ARC_TESTNET_RPC_URL: anvil.rpcUrl, ARC_CHAIN_ID: "31337", PLATFORM_PRIVATE_KEY: manager.address.padEnd(66, "0").replace("0x", "0x") === "" ? "" : `0x${"a".repeat(64)}`, USDC_ADDRESS: stack.usdc });
  ctx = {
    cfg: { ...cfg, usdc: stack.usdc },
    repo: new SqliteEntityRepository(db),
    docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "cli-docs-"))),
    arc: new ArcAdapter({ publicClient: pub, managerWallet: wallet, chainId: anvilChain.id, factory: stack.factory, identityRegistry: stack.registry }),
    operatorSigner: new LocalKeySigner(operatorKey),
  };
  agentJsonPath = join(mkdtempSync(join(tmpdir(), "cli-spec-")), "agent.json");
  writeFileSync(agentJsonPath, JSON.stringify({ name: "CLI Agent", roles: { manager: manager.address, guardian }, treasury: { payoutAddress: payout, spendingCapUsdc: "1000.00", spendingPeriod: "30d", allowlistEnabled: false }, governance: { amendmentDelay: "1h" } }));
}, 40_000);
afterAll(() => anvil?.stop());

test("create-entity drives the full saga to bound and list-entities shows it", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  const cli = buildCli(() => ctx);
  await cli.parseAsync(["node", "legalbody", "create-entity", "--config", agentJsonPath, "--id", "cli-A"]);
  await cli.parseAsync(["node", "legalbody", "list-entities"]);
  spy.mockRestore();

  expect(logs.join("\n")).toContain('"status": "bound"');
  expect(logs.join("\n")).toContain("cli-A");
  expect((await ctx.arc.getAgentWallet(0n)).toLowerCase()).toBe(new LocalKeySigner(operatorKey).address.toLowerCase());
}, 40_000);
```

> Note: the `PLATFORM_PRIVATE_KEY` in the test context is only used to satisfy `loadConfig` validation; the actual signer is the injected `ArcAdapter` (manager wallet) + `LocalKeySigner`. Simplify the `loadConfig(...)` call to `PLATFORM_PRIVATE_KEY: "0x" + "a".repeat(64)` for clarity.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli.int.test.ts`
Expected: PASS — CLI output contains `"status": "bound"` and `cli-A`; bound wallet == operator.

- [ ] **Step 5: Run the FULL suite + lint + typecheck**

Run (from `backend/`):

```bash
npx vitest run && npx biome check . && npx tsc --noEmit
```

Expected: all unit + integration tests pass; live tests skipped; biome clean; tsc clean. Fix any biome issues with `npx biome check --write .` and re-run.

- [ ] **Step 6: Commit**

```bash
git add backend/src/cli/index.ts backend/src/cli/context.ts backend/test/cli.int.test.ts
git commit -m "feat(backend): commander CLI + anvil E2E (M5)"
```

### Task 5.4: Arc-testnet scripted E2E (env-gated) + README/runbook

**Files:**
- Create: `backend/test/e2e.arc.live.test.ts`, `backend/README.md`

- [ ] **Step 1: Write the env-gated Arc-testnet E2E `backend/test/e2e.arc.live.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";
import { managerAccount, managerWalletClient, publicClientFor } from "../src/adapters/arc/clients";
import { loadConfig } from "../src/config/env";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { migrate, openDatabase } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { runOnboarding } from "../src/workflow/onboarding";

const RUN = process.env.ARC_E2E === "1";

describe.skipIf(!RUN)("Arc testnet E2E (live, costs testnet USDC gas)", () => {
  test("onboards a real agent end-to-end on Arc testnet", async () => {
    const cfg = loadConfig();
    if (!cfg.factoryAddress || !cfg.operatorPrivateKey || !cfg.guardianAddress) {
      throw new Error("set FACTORY_ADDRESS, OPERATOR_PRIVATE_KEY, GUARDIAN_ADDRESS");
    }
    const db = openDatabase(cfg.dbPath);
    migrate(db);
    const arc = new ArcAdapter({
      publicClient: publicClientFor(cfg),
      managerWallet: managerWalletClient(cfg),
      chainId: cfg.chainId,
      factory: cfg.factoryAddress,
      identityRegistry: cfg.identityRegistry,
    });
    const operatorSigner = new LocalKeySigner(cfg.operatorPrivateKey);
    // manager == the platform account derived from PLATFORM_PRIVATE_KEY
    const manager = managerAccount(cfg).address;
    const spec = parseAgentSpec({
      name: `E2E Agent ${process.env.ARC_E2E_TAG ?? "run"}`,
      roles: { manager, guardian: cfg.guardianAddress },
      treasury: { payoutAddress: cfg.guardianAddress, spendingCapUsdc: "10.00", spendingPeriod: "30d", allowlistEnabled: false },
      governance: { amendmentDelay: "1h" },
    });
    const rec = await runOnboarding({ spec, idempotencyKey: `e2e-${Date.now()}`, repo: new SqliteEntityRepository(db), docStore: new FileDocumentStore(cfg.docStoreDir), arc, operatorSigner, usdc: cfg.usdc });
    expect(rec.status).toBe("bound");
    expect((await arc.getAgentWallet(BigInt(rec.agentId!))).toLowerCase()).toBe(operatorSigner.address.toLowerCase());
  }, 120_000);
});
```

> Before running this against the LIVE registry, confirm its EIP-712 domain (call `eip712Domain()` if it implements EIP-5267, or read the verified source) and adjust `buildWalletSetTypedData`'s domain name/version if the live contract differs from the mock's `("AgentIdentity","1")`. A mismatch reverts with "bad signature".

- [ ] **Step 2: Verify it skips cleanly + typechecks**

Run (from `backend/`):

```bash
npx vitest run test/e2e.arc.live.test.ts
npx tsc --noEmit
```

Expected: skipped when `ARC_E2E` unset; tsc clean. To actually run: set `.env` (FACTORY_ADDRESS, OPERATOR_PRIVATE_KEY, GUARDIAN_ADDRESS, funded platform key) and `ARC_E2E=1 npx vitest run test/e2e.arc.live.test.ts`.

- [ ] **Step 3: Write `backend/README.md` (the operator runbook)**

```markdown
# Agent Legal Body — Backend ("the brain")

Framework-agnostic TypeScript backend that onboards an AI agent into an on-chain legal body on Arc:
generate operating agreement → register ERC-8004 identity → deploy + wire LegalManager + AgentTreasury
via the Factory (one atomic tx) → bind the agent wallet → persist. CLI-driven, fully tested.

## Prerequisites
- Node >= 20.18.2, npm. Foundry (forge/anvil) on PATH for integration tests.
- Contracts deployed to Arc testnet (see ../script/Deploy.s.sol and `addresses.arc-testnet.json`).

## Setup
    cp .env.example .env     # fill PLATFORM_PRIVATE_KEY, FACTORY_ADDRESS, GUARDIAN_ADDRESS, OPERATOR_PRIVATE_KEY
    npm install
    npm run gen:abis         # regenerate typed ABIs after any `forge build`

## Test
    npx vitest run           # unit + anvil integration (live tests skipped without creds)
    ARC_E2E=1 npx vitest run test/e2e.arc.live.test.ts   # live Arc testnet (spends gas)

## CLI
    npm run cli -- create-entity --config agent.example.json --id agent-1
    npm run cli -- create-entity --config agent.example.json --id agent-1 --fund 50.00
    npm run cli -- get-entity agent-1
    npm run cli -- list-entities
    npm run cli -- fund-treasury agent-1 25.00

## Roles (v1 demo)
- manager  = platform key (Factory owner; sends createEntity + setAgentWallet). PLATFORM_PRIVATE_KEY.
- guardian = human registrant address (pause/veto/rescue). GUARDIAN_ADDRESS.
- operator = agent's spending key; SIGNS the EIP-712 AgentWalletSet (bound as agentWallet).
             OPERATOR_PRIVATE_KEY in v1; Turnkey enclave key in production.

## Deferred (later specs)
MCP server, web wizard, ERC-8183 proof-of-life agent, Circle rails depth, Postgres/cloud, prod auth.

## Carried risks
- Circle KYC / user-of-record for an algorithmic LLC (the real production gate; mocked here).
- Arc work is TESTNET-era; mainnet unverified; via_ir bytecode re-review pending.
- Live registry EIP-712 domain must be confirmed before the live bind (see walletSet.ts note).
```

- [ ] **Step 4: Final full-suite verification**

Run (from `backend/`):

```bash
npx vitest run && npx biome check . && npx tsc --noEmit
```

Expected: green across unit + anvil integration; live/e2e skipped; lint + types clean.

- [ ] **Step 5: Commit**

```bash
git add backend/test/e2e.arc.live.test.ts backend/README.md
git commit -m "feat(backend): Arc-testnet E2E (env-gated) + backend runbook (M5)"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage** — every design section maps to tasks:
- §2 architecture / module table → M1 (skeleton, config, secrets, persistence) + each adapter milestone.
- §3 saga steps 1–7 → translate/generate (M2 + saga step 1–2), turnkey operator (M4.1/4.3 + saga), arc createEntity (M3.4 + saga step 4), bind (M4.2 + saga step 5), persist (M1.6 + saga), fund (M5.2).
- §4 persistence/secrets/config → M1.4–1.7.
- §5 roles → translator distinctness (M2.3) + saga wiring + README.
- §6 testing (unit/integration/adapter contract/E2E) → unit tests throughout, anvil int tests (M3.3+), env-gated live (M4.3, M5.4).
- §7 step 0 → M0.
- §8 milestones M0–M5 → this plan's M0–M5.
- §9 non-goals / §10 risks → enforced by scope + README "deferred"/"carried risks".

**2. Placeholder scan** — no "TBD"/"add error handling"/"similar to Task N". All code steps contain complete code; ops/live steps contain exact commands and are explicitly env-gated (not placeholders).

**3. Type consistency** — names verified consistent across tasks: `TreasuryConfig`, `EntityRecord`, `EntityStatus`, `translate`/`TranslateResult`/`assertOperatorDistinct`, `buildWalletSetTypedData`/`WalletSetArgs`, `OperatorSigner.signWalletSet`, `ArcAdapter.{createEntity,setAgentWallet,walletSetDeadline,fundTreasury,ownerOf,getAgentWallet,chainId,identityRegistry}`, `runOnboarding`/`OnboardingDeps`, `buildCli`/`buildContext`/`CliContext`. Generated-ABI export names (`legalManagerFactoryAbi`, `iIdentityRegistryAbi`, `legalManagerAbi`, `agentTreasuryAbi`, `mockIdentityRegistryAbi`, `mockUsdcAbi`) are consistent between `gen-abis.mts` and every importer.

**Known follow-ups (intentionally minimal in v1, not blockers):** the `bind-wallet` CLI command is a status echo — the saga's resume path (re-running `create-entity` with the same `--id`) is the real re-entry point for binding; a dedicated `bind-wallet` that reloads the persisted spec and resumes from `created` is a small, optional enhancement.
