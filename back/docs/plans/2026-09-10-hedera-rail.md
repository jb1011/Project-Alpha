# Hedera Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Length note.** This file exceeds the 300-line guideline for written deliverables by Alex's decision on 2026-09-10: one file rather than three, because the repo already carries many plan documents and the three pull requests share one naming table and one test scaffold. The shared section below is literal code and commands defined once; tasks reference it by name with their own values, which the writing-plans rule allows. Per-pull-request boundaries stay visible as the three top-level phase sections, each opening with what must already be on `main` and ending with its own merge step, so the D27 cut line means dropping a section, not hunting through tasks.

**Goal:** Put Novi Corpus's governed x402 payments on Hedera testnet under "self-custody", sell a paid legal-standing check at `GET /verify/:publicId`, and make each company resolvable from Hedera through an ERC-8004 registration, an HCS-14 UAID and an HCS-11 profile, with the live demo run on HashScan as the definition of done.

**Architecture:** The backend gains a `hedera` config block, one nullable ledger column, seven entity columns, three MCP tools (`link_hedera_account`, `check_policy`, `report_payment`), a paid route built on `@x402/hono`, a profile route, and two scripts. A standalone package `back/hedera-client` holds the customer-side signer, the `provision`, `revoke`, `pay` and `demo-buyer` commands. Novi Corpus's server never signs a Hedera transaction; the client refuses on a `check_policy` deny and the guardian holds the on-chain leash.

**Tech Stack:** TypeScript, Hono 4, better-sqlite3, viem 2, zod 3, vitest 2, Biome 1.9 (backend); `@x402/core`, `@x402/hono`, `@x402/hedera`, `@x402/fetch` all pinned `2.25.0`; `@hiero-ledger/sdk@2.85.0` (client only, pinned by `@x402/hedera`); `@noble/curves@1.8.1`, `@noble/hashes@1.7.1`, `@scure/base@1.2.4`; `@modelcontextprotocol/sdk@1.29.0`.

**Spec:** `back/docs/design/2026-09-10-hedera-rail-design.md` (v4, D1 to D29; adversarially audited 2026-09-10, this plan corrected in the same pass). Read "Pre-cleared" and "Decided" before starting. Every D-number below refers to that table. Facts under "Pre-cleared" are citable without re-checking; anything not in the spec is this plan's to verify, and each such step says so.

## Global Constraints

- **Flag-gated.** `HEDERA_ENABLED` (`"1"` or `"true"`) turns everything on; off means no route, no tools, no config block, and every existing test unchanged.
- **Arc untouched.** No change to the Arc buyer path, its wire format, `buildPaywall`, or `EntityPaymentService.pay`. The one edit on the Arc payment path is a type widening in `policyGate.ts` (`payee` accepts a string), behaviour identical; the other shared files this plan touches (`legalBodies.ts`, `metadata.ts`, `ledger.ts`, `db.ts`, `server.ts`, `app.ts`, `main.ts`, `env.ts`) gain additions only, listed under File structure.
- **Prod is the demo target (D28).** PR 1 and PR 2 deploy to the VPS before the demo buyer runs; task 16 is required and precedes task 15. Pre-merge live checks run on a local backend against a locally onboarded throwaway entity (task 0 step 9); no production data leaves the box. How the deploys happen is Martin's pick from the design's "Asks of Martin, with options"; the fallback if no path is agreed by Friday 2026-09-12 evening is in D28.
- **The x402 bump is task 1 and gates everything.** `@x402/evm` to `^2.25.0`, add `@x402/core`, `@x402/hono`, `@x402/hedera` at `2.25.0`, drop `x402-fetch`. Full suite green before any Hedera code.
- **No `.env` is ever read by Claude or printed by a script.** Secrets reach a process only through `op run --env-file=<tpl> -- <command>`; `op run` masks matches in output. 1Password vault: **Novi Corpus**.
- **Testnet only.** `HEDERA_NETWORK` must be `testnet`; a config with any other value refuses to boot.
- **Names come from the naming table below.** No executor invents an env var, column, tool, route, module or package name.
- **One task, one commit,** message given in the task. Integration branch `hedera`, cut from `main` (D29, Martin's ask on 2026-09-11); the three pull requests (tasks 1 to 8, 9 to 12, 13 to 15) target `hedera`, never `main`, and merge with `gh pr merge --merge` (D20), never squash. The merge of `hedera` into `main` is a joint decision after 2026-09-16, as one pull request readable end to end. Docs stay on `main`. Each code PR goes to Martin with a 24-hour review window; after that, green CI and Alex's diff read, Alex self-merges (D29). Before each PR is opened, run `superpowers:requesting-code-review` on the branch against this plan.
- **CI covers `back/backend` only today.** Task 7 adds a `hedera-client` job to `.github/workflows/ci.yml`; until it is in, "CI green" says nothing about the client, and the client's three checks run locally before every client commit.
- **"Settled" is written only after a mirror-node read** (D13). No code path marks a Hedera row settled from a facilitator reply or an HTTP status.
- **Claims ceiling** (D9): the served body says "a registered legal body in good standing"; never "verified company", "KYC'd", "licensed".
- **Backend commands run in `back/backend`; client commands in `back/hedera-client`.** Checks before every commit: `npm run lint` (Biome, line width 100), `npm run typecheck`, `npm test`.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## How every task runs (defined once, literally; tasks reference these by name)

**The TDD loop.** Write the failing test, run it and see it fail for the stated reason, implement, run it green, run the three checks, commit. Test files sit under `back/backend/test/<area>/` and use `import { expect, test } from "vitest"`. Line anchors were re-verified on 2026-09-10 against `feat/hedera-rail` at `6d37398` (equal to `origin/hedera` `bea70d1` plus docs), 22 anchor groups, four corrected in place; if a quoted anchor line has moved, search for the quoted text; if the text is gone, stop and report.

**The shared test scaffold** is one file, created in task 2 and committed with it: `back/backend/test/helpers/hederaApp.ts`. Every route and MCP test in this plan imports it and passes its own values. Its content:

```ts
// test/helpers/hederaApp.ts — the one scaffold every Hedera test builds on.
import Database from "better-sqlite3";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import type { FormationSummary } from "../../src/formation/status";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import type { EntityRecord } from "../../src/types";

export const WEB = "https://www.novicorpus.test";
export const METADATA_BASE = "https://api.novicorpus.test";
export const PUBLIC_ID = "9f8003f5-4c70-435a-9980-9a54625691b7";
export const TREASURY = "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf"; // FormationE2E_1's, so a scaffold UAID equals the task 9 golden vector
export const PROXY = "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE";
export const TENANT = "0x000000000000000000000000000000000000000A";

/** The demo entity's shape, public on chain, verified controller absent unless overridden. */
export const entity = (over: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    idempotencyKey: `${TENANT}:FormationE2E_1`,
    name: "FormationE2E_1",
    status: "funded",
    manager: "0x0000000000000000000000000000000000000001",
    guardian: "0x0000000000000000000000000000000000000002",
    operator: null,
    amendmentDelay: "0",
    ein: "12-3456789",
    formationDate: 0,
    oaHash: null,
    metadataURI: `${METADATA_BASE}/metadata/${PUBLIC_ID}`,
    docPath: null,
    treasuryConfig: {
      usdc: "0x0000000000000000000000000000000000000002",
      payoutAddress: TREASURY,
      cap: 1_000_000_000n,
      period: 86_400n,
      allowlistEnabled: false,
    },
    agentId: "886257",
    proxy: PROXY,
    treasury: TREASURY,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: TENANT,
    walletProvider: "circle",
    publicId: PUBLIC_ID,
    ...over,
  }) as EntityRecord;

/** A real in-memory database with the demo entity seeded, plus the stores MCP tests need. */
export function hederaDb(over: Partial<EntityRecord> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const rec = entity(over);
  repo.upsert(rec);
  return { db, repo, rec, apiKeys: new SqliteApiKeyStore(db) };
}

/** The Arc reads a legal body needs, scripted. */
export const arcReads = (o: { status?: number; paused?: boolean; throws?: boolean } = {}) => ({
  legalStatus: async () => {
    if (o.throws) throw new Error("rpc down");
    return o.status ?? 0;
  },
  treasuryPaused: async () => {
    if (o.throws) throw new Error("rpc down");
    return o.paused ?? false;
  },
});

/** The app with the deps a Hedera test controls. Anything not listed is `undefined`, as in
 *  `test/api/legalBodies.test.ts` (the `as never` cast is that file's idiom). */
export function hederaApp(o: {
  repo: SqliteEntityRepository;
  apiKeys?: SqliteApiKeyStore;
  hedera?: unknown;
  legalBody?: unknown;
  worldId?: unknown;
  ens?: unknown;
  now?: () => number;
  formationSummary?: (companyId: string) => FormationSummary | null;
}) {
  return buildApiApp({
    webOrigin: WEB,
    jwtSecret: "s",
    chainId: 5042002,
    repo: o.repo,
    apiKeys: o.apiKeys,
    now: o.now ?? (() => 1_789_100_000_000), // 2026-09-10, the design date
    hedera: o.hedera,
    legalBody: o.legalBody ?? {
      resolver: { resolve: async () => ({ kind: "none" }) },
      chainReads: arcReads(),
      readBudget: new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      formationSummary: o.formationSummary,
      network: "testnet" as const,
    },
    worldId: o.worldId,
    ens: o.ens,
  } as never);
}

/** A scripted mirror node: each method answers from the script, and records its calls. */
export function fakeMirror(script: {
  account?: { account: string; keyHex: string | null; keyType: string | null; evmAddress: string | null } | null;
  tokenBalance?: bigint;
  transaction?: unknown[] | null;
}) {
  const calls: string[] = [];
  return {
    calls,
    account: async (id: string) => (calls.push(`account:${id}`), script.account ?? null),
    tokenBalance: async (id: string) => (calls.push(`balance:${id}`), script.tokenBalance ?? 0n),
    transaction: async (id: string) => (calls.push(`tx:${id}`), script.transaction ?? null),
    waitTransaction: async (id: string) => (calls.push(`wait:${id}`), script.transaction ?? null),
  };
}
```

A task says "scaffold with `hedera: {...}`, `worldId: {...}`" and shows only those values. MCP tests connect with `startMcpTestClient(app, apiKey)` from `test/mcp/helpers.ts:7` after inserting a key with `apiKeys` the way `test/mcp/pay.int.test.ts:61-80` does.

**The three checks, the commit, and the "do not proceed" idiom**, literally, run from `back/backend` (or `back/hedera-client` for task 7):

```bash
npm run lint && npm run typecheck && npm test 2>&1 | tail -5
# Expected last line: "Tests  <baseline + this task's new tests> passed". Anything else: stop.
git add <the files the task lists>
git commit -m "<the task's message>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Where a step says **Do not proceed if**, the executor stops, writes what it saw under "Records", and does not start the next step. **Expected output is literal:** each step states the exact string or shape to see. **LIVE** steps run under `op run --env-file=<tpl> -- <command>`, spend testnet USDC and HBAR only, and record every transaction id under "Records".

## Naming table (the only source of names)

| Kind | Name | Value or shape |
|---|---|---|
| Env, server | `HEDERA_ENABLED` | `"1"` or `"true"` (truthy-string transform, `env.ts:128-131` idiom) |
| Env, server | `HEDERA_NETWORK` | `testnet` (only accepted value) |
| Env, server | `HEDERA_FACILITATOR_URL` | `https://api.testnet.blocky402.com` |
| Env, server | `HEDERA_MIRROR_URL` | `https://testnet.mirrornode.hedera.com` |
| Env, server | `HEDERA_USDC_TOKEN_ID` | `0.0.429274` |
| Env, server | `HEDERA_PAYTO_ACCOUNT_ID` | `0.0.10412694` for the demo (D26) |
| Env, server | `HEDERA_VERIFY_PRICE_USDC` | default `0.001` → atomic `1000n` |
| Env, server, PR 3 | `NOVI_ATTESTATION_KEY` | 32-byte hex secp256k1 private key |
| Env, script only | `HEDERA_JSON_RPC_URL` | `https://testnet.hashio.io/api` (chain id 296) |
| Constant | `HEDERA_IDENTITY_REGISTRY` | `0x8004A818BFB912233c491871b3d84c89A494BD9e`, exported from `src/hedera/registry.ts`; the script and the metadata route import it; never an env var (audit C3) |
| Demo target (D28) | prod URLs | `https://www.novicorpus.com/backend` for the buyer's HTTP hops, `https://www.novicorpus.com/backend/mcp` for the three tools; the local backend is `http://127.0.0.1:8787` and serves pre-merge checks only |
| Env, script only | `HEDERA_OPERATOR_ACCOUNT_ID`, `HEDERA_OPERATOR_KEY` | `0.0.10412694` and its ECDSA key |
| Env, script only | `DEMO_GUARDIAN_KEY` | the demo entity's Arc guardian key |
| Config | `cfg.hedera` | `{ network: "testnet"; facilitatorUrl; mirrorUrl; usdcTokenId; payToAccountId; verifyPriceUsdc: string; verifyPriceAtomic: bigint; attestationKey?: Hex }` or `undefined` |
| CAIP-2 | Hedera network | `hedera:testnet` |
| CAIP-2 | Arc network | `` `eip155:${cfg.chainId}` `` (never a literal) |
| Column | `payments_ledger.network` | `TEXT` nullable; `NULL` = Arc (D5) |
| Index | `idx_payments_ledger_network_ref` | `UNIQUE (network, batch_ref) WHERE network IS NOT NULL` |
| Columns | `entities.*` | `hedera_account_id TEXT`, `hedera_agent_public_key TEXT`, `hedera_guardian_public_key TEXT`, `hedera_linked_at INTEGER`, `hedera_agent_id TEXT`, `hedera_register_tx TEXT`, `uaid TEXT` |
| Record fields | `EntityRecord` | `hederaAccountId`, `hederaAgentPublicKey`, `hederaGuardianPublicKey`, `hederaLinkedAt`, `hederaAgentId`, `hederaRegisterTx`, `uaid` (all `?: … \| null`) |
| MCP tools | | `link_hedera_account`, `check_policy`, `report_payment` |
| Routes | | `GET /verify/:publicId`, `GET /metadata/:publicId/profile` |
| Modules | backend | `src/hedera/mirror.ts`, `src/hedera/keyDecode.ts`, `src/hedera/policy.ts`, `src/hedera/attestation.ts`, `src/hedera/uaid.ts`, `src/api/routes/verify.ts`, `src/api/routes/profile.ts` |
| Dep on `ApiDeps` | `hedera?: HederaDeps` | `{ cfg: NonNullable<Config["hedera"]>; mirror: HederaMirror; ledger: PaymentLedger; spendAllowlistThreshold: bigint }` (the threshold copied from `cfg.spendAllowlistThreshold`, `env.ts:403`; audit B7) |
| Scripts | backend | `scripts/hedera-register-identity.mts`, `scripts/guardian-pause.mts` |
| Package | client | `back/hedera-client`, name `@novicorpus/hedera-client`, bin `novi-hedera`, commands `provision` (flag `--memo-only`), `link`, `revoke`, `pay`, `demo-buyer` |
| Script flags | `hedera-register-identity.mts` | `--entity <name|key>` (repeatable, local database), `--from-prod <publicId>` (repeatable, public endpoints), `--all-entities`, `--execute`, `--record --entity <id> --agent-id <n> --tx <hash> --uaid <uaid>` |
| Script flags | `guardian-pause.mts` | `pause|unpause`, `--entity <name|key>` (local database) or `--treasury <address>` (no database; the on-chain `guardian()` check is the only gate) |
| EIP-712 | domain | `{ name: "Novi Corpus Attestation", version: "1" }` (no `chainId`) |
| UAID | inputs (D10) | `registry=novicorpus`, `name=<entity.name>`, `version=1`, `protocol=mcp`, `nativeId=eip155:<cfg.chainId>:<treasury lowercased>`, `skills=[]`; params `uid=<agentId>`, `registry`, `proto`, `nativeId` |
| Demo entity checked (D18) | `FormationE2E_1` | `publicId 9f8003f5-4c70-435a-9980-9a54625691b7`, Arc agent id `886257`, treasury `0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf`, Martin's |
| Demo entity paying (D18) | `HederaDemo_1` | onboarded on prod in task 0 under Alex's wallet; `publicId` recorded there |
| Pre-merge entity (D28) | `HederaDemo_local` | onboarded on the local backend in task 0 step 9, same guardian key; the only entity task 8 touches; never registered on Hedera, never on prod |
| 1Password items | | `Hedera Testnet Treasury` (guardian on Hedera), `Hedera Spike Agent Key` (agent), new: `Hedera Platform Operator`, `Novi Corpus Attestation Key`, `Demo Guardian Key` |

## File structure

**Backend `back/backend` (modify):** `package.json`, `.env.example`, `src/config/env.ts`, `src/persistence/db.ts`, `src/persistence/entityRepository.ts`, `src/types.ts`, `src/payments/ledger.ts`, `src/payments/policyGate.ts`, `src/mcp/server.ts` (tools and `MCP_TOOL_DEP_KEYS`), `src/api/app.ts` (`ApiDeps.hedera`, mounts), `src/api/main.ts` (build `hedera` deps), `src/api/routes/legalBodies.ts` (export both limiters, add `chainReads` to `LegalBodyLookupDeps`, export `formationOf`), `src/api/routes/metadata.ts` (ungated `registrations[]`, `uaid`, `hedera` block), `README.md`, `docs/README.md` (index the two Hedera docs, task 15), `.github/workflows/ci.yml` (client job, task 7).

**Backend docs (create):** `docs/runbooks/hedera-demo.md` (task 15: the five legs, the prod URLs, the 1Password items by title only).

**Backend (create):** `src/hedera/mirror.ts` (REST reads and the tx-id form), `src/hedera/keyDecode.ts` (protobuf `Key` decoder), `src/hedera/policy.ts` (`PolicyInput` for a Hedera payment), `src/hedera/attestation.ts` (body builder, PR 3 adds signing), `src/hedera/uaid.ts` (canonical JSON, SHA-384, Base58), `src/api/routes/verify.ts`, `src/api/routes/profile.ts`, `scripts/hedera-register-identity.mts`, `scripts/guardian-pause.mts`, tests under `test/hedera/`, `test/api/`, `test/mcp/`, `test/config/`.

**Client `back/hedera-client` (create):** `package.json`, `tsconfig.json`, `.env.tpl`, `src/signer.ts`, `src/novi.ts` (MCP client), `src/pay.ts`, `src/mirror.ts`, `src/commands/provision.ts`, `src/commands/link.ts`, `src/commands/revoke.ts`, `src/commands/pay.ts`, `src/commands/demo-buyer.ts`, `src/cli.ts`, `test/signer.test.ts`, `test/pay.test.ts`.

## Schedule (the clock the D27 cut line runs on)

About 40 hours from Thursday 2026-09-11 to the deadline; the start-now note's 42-hour estimate less the design work already done. Hours are estimates; the stop condition is the literal expected line of the task named.

| Day | Tasks | Hours | Stop condition |
|---|---|---|---|
| Thu 2026-09-11 | 0, 1, 2, 3, 4 | 8 | Martin's deploy answer recorded; baseline suite green after the bump; decoder vectors green |
| Fri 2026-09-12 | 5, 6, 7, 8 | 9 | One paid `/verify` settled on HashScan from the local backend (the D27 line) |
| Sat 2026-09-13 | PR 1 review window, 9, 10 | 6 | `FormationE2E_1` and `HederaDemo_1` registered on Hedera with UAIDs |
| Sun 2026-09-14 | 11, 12, PR 2, 16 (both deploys) | 6 | Prod answers `/verify` with 402 and `/metadata/…/profile` with 200 |
| Mon 2026-09-15 | 13, 14, 15 | 7 | The five legs recorded against prod; PR 3 open |
| Tue 2026-09-16 | runbook, docs index, continuity README, video, submit | 4 | Submitted |

If Friday slips, D27 applies on Saturday morning. If no deploy path is agreed by Friday evening (D28), or Sunday's deploys fail, the D28 fallback (local backend owning every hop, tunnel URL) starts Sunday evening.

---

## Phase 0 — Preflight

### Task 0: Branch, demo entities, accounts, and the topology

**Files:** none committed except a Records line appended to this plan.

- [x] **Step 0: The asks to Martin (D28, D29), answered 2026-09-11.** Martin picked: deploys option 1 (he runs the box on the `hedera` integration branch; no SSH for Alex this week), data option 1 (nothing leaves the box), merge option 2 on `hedera` (24-hour review window, then Alex self-merges into `hedera`; the merge into `main` is decided together afterwards). He also asked for an Arc payment option on `/verify` (D30, after the hackathon) and for the Arc live x402 leg after the bump (task 1 step 4). The four brief questions still go out on Discord with the "self-custody" default.

- [ ] **Step 1: Branch state.** Run `git -C ~/Desktop/Solidity_Project_Files/arc-Circle/Project-Alpha-monorepo status --short && git log --oneline -1 && git fetch origin && git rev-list --count HEAD..origin/hedera`. Expected: empty status, HEAD `6d37398` or later, `0` behind. **Do not proceed if** behind: `git merge --ff-only origin/hedera` first and re-verify anchors in step 4 of "How every task runs".
- [ ] **Step 2: Baseline test count.** `cd back/backend && npx vitest run 2>&1 | tail -5`. Record the `Tests N passed` line in Records. Every later task compares against it.
- [ ] **Step 3: Demo entity is public on chain with a verified human.** `curl -s https://www.novicorpus.com/backend/transparency | python3 -c 'import sys,json; [print(e) for e in json.load(sys.stdin)["entities"] if e.get("publicId")=="9f8003f5-4c70-435a-9980-9a54625691b7"]'`. Expected: one line with `'status': 'funded'`, `'humanVerified': True`, `'agentId': '886257'`. Then `curl -s https://www.novicorpus.com/backend/legal-bodies/<treasury>` once the treasury is known from `/metadata/9f8003f5-…`'s `legalBody` block; expected `"standing":"active"`. **Do not proceed if** standing is not `active`: fall back to `TestBootstrapMB_1` (`061441c6-cc58-466b-b44f-5e627d823e09`) and update D18 in the design.
- [ ] **Step 4: Onboard the paying entity `HederaDemo_1` on prod (D18, D22).** `FormationE2E_1` was onboarded by Martin (confirmed by Alex 2026-09-10), so its tenant and guardian keys are not Alex's; `HederaDemo_1` does not exist on prod as of 2026-09-10 (16 entities, none by that name). Prod's `/config` says `formationPaymentRequired: false` and the doola environment is `sandbox`, so this costs nothing (pre-cleared). Generate a guardian key into 1Password as `Demo Guardian Key` (`private_key_hex`), and onboard a new entity through the dashboard or the API with that key's address as guardian and Alex's wallet as the tenant, custody `circle` (the platform default), name `HederaDemo_1`. Follow the sequence in `test/cli.int.test.ts` for the API calls. Expected: the entity reaches `funded` (not `bound`: `check_policy` reads `legalStatus` on the proxy and `paused` on the treasury, so both must exist), appears on `/transparency` with a `publicId`, and `curl -s https://www.novicorpus.com/backend/legal-bodies/<its treasury>` answers `"standing":"active"`. Record its `publicId`, treasury, guardian. This entity links the Hedera float account (task 8), owns the demo API key (task 8 locally, task 16 on prod), is registered on Hedera (task 10), carries the memo (task 12) and is paused in task 14; `FormationE2E_1` is the one `/verify` answers about. **Do not proceed to task 14 if** the guardian is a browser wallet with no exportable key: the fallback is to onboard a fresh demo entity through the API with a guardian key generated into 1Password (the `cli.int.test.ts` bootstrap flow shows the calls), and to re-run this step.
- [ ] **Step 5: USER TASK: 1Password items.** Alex creates, in vault **Novi Corpus**: `Hedera Platform Operator` with `account_id=0.0.10412694` and `private_key_hex` (the portal key, ECDSA), `Novi Corpus Attestation Key` with `private_key_hex` (generate: `node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"` and paste, never print again), `Demo Guardian Key` with `private_key_hex` from step 4. Expected: `op item get "Hedera Platform Operator" --vault "Novi Corpus" --fields label=account_id` prints `0.0.10412694`.
- [ ] **Step 6: LIVE: associate the spare account with USDC (D26).** In `back/hedera-client` after task 7 exists, or now from the spike folder: `op run --env-file=.env.tpl -- npx tsx src/01-associate.ts` with `TREASURY_ACCOUNT_ID`/`TREASURY_PRIVATE_KEY` pointed at the `Hedera Platform Operator` item in a copy of `.env.tpl`. Expected: `TOKENASSOCIATE SUCCESS`, and `curl -s https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10412694/tokens` lists `0.0.429274`. Record the consensus timestamp.
- [ ] **Step 7: HCS-11 memo form, answered 2026-09-10 (pre-cleared).** The spec at hol.org lists `https://{url}` as a valid `hcs-11:` reference; the standards SDK resolver (0.1.186) follows `hcs://`, `ipfs://` and `ar://` only. D11 stands for the demo; task 12 carries the HCS-1 inscription as an upgrade if time allows, and the README says which resolvers work. Nothing to run.
- [ ] **Step 8: Testnet reset check.** Open `https://status.hedera.com/` and look for a scheduled testnet reset between now and 2026-09-16 (the last reset was 2024-02-01; later scheduled ones were skipped). Expected: none scheduled. **If one is scheduled inside the window,** record the date and move every live step ahead of it.
- [ ] **Step 9: Local throwaway entity for pre-merge checks (D28).** Start the local backend with its own `DATA_DIR` (the default `./data`; nothing from production; the local env profile is the one `docs/runbooks/world-sandbox-testing.md` describes, `npm run api:sandbox`, so the World guardian gate is the sandbox one) and onboard `HederaDemo_local` through the same flow as step 4, guardian `Demo Guardian Key`, custody the platform default. Expected: `curl -s http://127.0.0.1:8787/transparency` lists `HederaDemo_local` as `funded` with a `publicId`, and `curl -s http://127.0.0.1:8787/legal-bodies/<its treasury>` answers `"standing":"active"`. Record its `publicId` and treasury. Task 8's live steps run against this entity; the prod entities are only touched after the deploy (task 16). If Martin chose the two-row export instead (design "Asks of Martin", row 2, option 2), import it with `sqlite3 ./data/legalbody.db < export.sql` and use `FormationE2E_1` in task 8 as well.
- [ ] **Step 10: Records.** Append under "Records" at the end of this plan: Martin's two answers with dates, baseline test count, both demo entities' `publicId`, treasury and guardian, the association transaction, the reset-check result.

---

## Phase 1 — Pull request 1: the rail

**Must already be on `hedera`:** the integration branch exists, cut from `main` after the 2026-09-11 docs PR, so it carries PR #120, PR #126, PR #127 and PR #128. Task 0 complete. Branch: `feat/hedera-rail`, rebased onto `hedera`; PR base `hedera`.
**Ends with:** task 8's merge step. If D27's cut line falls before task 8 completes, this phase still merges once task 6's live paid `/verify` is on HashScan; tasks 7 and 8 shrink to the `pay` command and the run.

### Task 1: The x402 bump

**Files:**
- Modify: `back/backend/package.json:38` (`"@x402/evm": "^2.15.0"`), `:45-46` (`x402`, `x402-fetch`)

**Interfaces:** Produces the packages every later task imports: `@x402/core@2.25.0`, `@x402/hono@2.25.0`, `@x402/hedera@2.25.0`, `@x402/evm@^2.25.0`.

- [ ] **Step 1:** `cd back/backend && npm install --save-exact @x402/core@2.25.0 @x402/hono@2.25.0 @x402/hedera@2.25.0 && npm install @x402/evm@^2.25.0 && npm uninstall x402-fetch`. Expected: no `ERESOLVE`; `npm ls @x402/core` shows a single `2.25.0` and `@circle-fin/x402-batching` deduped under it. **Do not proceed if** two copies of `@x402/core` appear: report the tree; the fallback is to leave `@x402/evm` at `^2.15.0` and accept the nested copy, and to say so in the commit message.
- [ ] **Step 2:** `ls node_modules/@hashgraph 2>/dev/null; ls node_modules/@hiero-ledger`. Expected: no `@hashgraph` directory; `@hiero-ledger/sdk` present.
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm test 2>&1 | tail -5`. Expected: the baseline `Tests N passed` line from task 0, unchanged. **Do not proceed if** any test fails: the Arc codec is the suspect; report the failing test names and stop.
- [ ] **Step 4: LIVE: the Arc x402 leg after the bump** (Martin's ask, 2026-09-11: `@circle-fin/x402-batching` resolves its `@x402/core` peer to the new version, and the unit suite stubs the facilitator). From the main checkout, whose `.env` the test reads itself: `LIVE_SETTLE=1 npx vitest run test/payments/settle.live.test.ts`. Expected: the suite runs (not skipped) and its settle assertion passes with a real Circle transfer id. **Do not proceed if** it fails or is skipped: pin `@x402/evm` back to `^2.15.0` so `@x402/core` nests, re-run, and say so in the commit message and Records.
- [ ] **Step 5: Commit.** `git add package.json package-lock.json` → `feat(hedera): bump x402 to 2.25, add core/hono/hedera, drop x402-fetch (task 1)`.

### Task 2: Config block, invariants, redaction, `.env.example`

**Files:**
- Modify: `src/config/env.ts` (schema after `:131`; `Config` type after the `world?` block closing at `:457`; value after the `world:` ternary ending `:720`; invariants block, add after `:1009`; `redact` at `:1180`, add beside `:1236`)
- Modify: `.env.example` (insert after line 178, before the `PUBLIC_API_URL` comment at `:180`)
- Create: `test/helpers/hederaApp.ts` (the shared scaffold, verbatim from "How every task runs")
- Test: `test/config/hedera.test.ts`

**Interfaces:** Produces `Config["hedera"]` as in the naming table, and `export type HederaConfig = NonNullable<Config["hedera"]>`.

- [ ] **Step 1: Failing test** `test/config/hedera.test.ts`:

```ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s",
  RPC_URL: "http://localhost:8545",
};
const ON = {
  ...BASE,
  HEDERA_ENABLED: "1",
  HEDERA_NETWORK: "testnet",
  HEDERA_FACILITATOR_URL: "https://api.testnet.blocky402.com",
  HEDERA_MIRROR_URL: "https://testnet.mirrornode.hedera.com",
  HEDERA_USDC_TOKEN_ID: "0.0.429274",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.10412694",
};

test("flag off -> cfg.hedera undefined, other config unchanged", () => {
  expect(loadConfig(BASE).hedera).toBeUndefined();
});
test("flag on and whole -> block with 1000n atomic default price", () => {
  const h = loadConfig(ON).hedera;
  expect(h?.network).toBe("testnet");
  expect(h?.verifyPriceAtomic).toBe(1000n);
  expect(h?.payToAccountId).toBe("0.0.10412694");
});
test("flag on and partial -> refuses to boot naming the missing var", () => {
  const { HEDERA_PAYTO_ACCOUNT_ID: _omit, ...partial } = ON;
  expect(() => loadConfig(partial)).toThrow(/HEDERA_PAYTO_ACCOUNT_ID/);
});
test("HEDERA_NETWORK other than testnet refuses", () => {
  expect(() => loadConfig({ ...ON, HEDERA_NETWORK: "mainnet" })).toThrow(/testnet/);
});
test("attestation key equal to the platform key refuses; redacted otherwise", () => {
  expect(() => loadConfig({ ...ON, NOVI_ATTESTATION_KEY: BASE.PLATFORM_PRIVATE_KEY })).toThrow(
    /NOVI_ATTESTATION_KEY/,
  );
  const cfg = loadConfig({ ...ON, NOVI_ATTESTATION_KEY: `0x${"3".repeat(64)}` });
  expect((redact(cfg).hedera as { attestationKey?: string }).attestationKey).toBe("REDACTED");
});
```

Run `npx vitest run test/config/hedera.test.ts`. Expected: FAIL, `hedera` is `undefined` in the "whole" case.

- [ ] **Step 2: Schema.** After `env.ts:131` add:

```ts
  HEDERA_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  HEDERA_NETWORK: z.string().optional(),
  HEDERA_FACILITATOR_URL: z.string().url().optional(),
  HEDERA_MIRROR_URL: z.string().url().optional(),
  HEDERA_USDC_TOKEN_ID: z.string().regex(/^0\.0\.\d+$/).optional(),
  HEDERA_PAYTO_ACCOUNT_ID: z.string().regex(/^0\.0\.\d+$/).optional(),
  HEDERA_VERIFY_PRICE_USDC: z.string().default("0.001"),
  NOVI_ATTESTATION_KEY: privKeySchema.optional(),
```

- [ ] **Step 3: Type.** After the `world?` block (`:457`) add:

```ts
  /** Hedera rail (design 2026-09-10). Present only when HEDERA_ENABLED and the block is whole. */
  hedera?: {
    network: "testnet";
    facilitatorUrl: string;
    mirrorUrl: string;
    usdcTokenId: string;
    payToAccountId: string;
    verifyPriceUsdc: string;
    verifyPriceAtomic: bigint;
    /** PR 3: signs /verify. Absent = the route serves the unsigned body. */
    attestationKey?: Hex;
  };
```

and beside the other exported types: `export type HederaConfig = NonNullable<Config["hedera"]>;`

- [ ] **Step 4: Value.** After the `world:` ternary (`:720`) add `hedera: buildHedera(e),` and define above `loadConfig` (the parsed-schema type in this file is inferred from `EnvSchema` at `:45`; name the parameter with `z.infer<typeof EnvSchema>` or the alias the file already uses):

```ts
function buildHedera(e: Env): Config["hedera"] {
  if (!e.HEDERA_ENABLED) return undefined;
  const required = {
    HEDERA_NETWORK: e.HEDERA_NETWORK,
    HEDERA_FACILITATOR_URL: e.HEDERA_FACILITATOR_URL,
    HEDERA_MIRROR_URL: e.HEDERA_MIRROR_URL,
    HEDERA_USDC_TOKEN_ID: e.HEDERA_USDC_TOKEN_ID,
    HEDERA_PAYTO_ACCOUNT_ID: e.HEDERA_PAYTO_ACCOUNT_ID,
  };
  for (const [name, value] of Object.entries(required))
    if (!value)
      throw new Error(
        `Invalid config: HEDERA_ENABLED is on but ${name} is missing — the Hedera block is all-or-nothing (design 2026-09-10 D5)`,
      );
  if (e.HEDERA_NETWORK !== "testnet")
    throw new Error(
      `Invalid config: HEDERA_NETWORK=${e.HEDERA_NETWORK} — this build is testnet only (design 2026-09-10 Global Constraints)`,
    );
  return {
    network: "testnet",
    facilitatorUrl: e.HEDERA_FACILITATOR_URL as string,
    mirrorUrl: (e.HEDERA_MIRROR_URL as string).replace(/\/+$/, ""),
    usdcTokenId: e.HEDERA_USDC_TOKEN_ID as string,
    payToAccountId: e.HEDERA_PAYTO_ACCOUNT_ID as string,
    verifyPriceUsdc: e.HEDERA_VERIFY_PRICE_USDC,
    verifyPriceAtomic: usdToUnits(e.HEDERA_VERIFY_PRICE_USDC),
    attestationKey: e.NOVI_ATTESTATION_KEY,
  };
}
```

(`Env` is whatever name the parsed-schema type carries in this file; match it.)

- [ ] **Step 5: Invariants.** After the settle-submitter block closes (`:1009`) add a block that runs whenever `cfg.hedera?.attestationKey` is set: compare `privateKeyToAccount(key).address.toLowerCase()` against `platform`, against every entry of a `signingKeys` list built exactly like `:966-973` (hoist that list above both blocks so it is declared once), and against `cfg.formation?.payment.submitterKey`. Each collision throws `Invalid config: NOVI_ATTESTATION_KEY is the ${name} — the attestation key signs statements and holds no other role on this box (design 2026-09-10 D6)`.
- [ ] **Step 6: Redaction.** In `redact` add `hedera: cfg.hedera ? { ...cfg.hedera, verifyPriceAtomic: cfg.hedera.verifyPriceAtomic.toString(), attestationKey: cfg.hedera.attestationKey ? "REDACTED" : undefined } : undefined,`.
- [ ] **Step 7: `.env.example`.** After line 178 insert a commented block, one line per var from the naming table's server rows, with the sentence: `# Hedera rail (design 2026-09-10). Testnet only. The operator key lives with the scripts, never here.`
- [ ] **Step 8: The shared scaffold.** Create `test/helpers/hederaApp.ts` with the exact content shown under "How every task runs". It must pass `npm run typecheck` now, before any test uses it (the `as never` cast keeps it compiling as `ApiDeps` grows in tasks 5 and 6).
- [ ] **Step 9:** Run the test file: PASS, 5 tests. Then the three checks. Expected suite: baseline plus 5.
- [ ] **Step 10: Commit.** → `feat(hedera): HEDERA_* config block, attestation-key invariants, redaction, shared test scaffold (task 2)`.

### Task 3: Persistence: ledger `network`, entity columns, repository

**Files:**
- Modify: `src/persistence/db.ts` (after the `entities` `public_id` block at `:719-720`; after `payments_ledger` indexes at `:346-347` add the migration in `migrate`, next to `:837-855` idiom)
- Modify: `src/payments/ledger.ts:19-48`
- Modify: `src/types.ts:36-112` (`EntityRecord`), `src/persistence/entityRepository.ts` (`Row` at `:91`, `toRecord` at `:160-209`, `INSERT_COLUMNS`/`INSERT_VALUES` at `:266-290`, the `ON CONFLICT ... SET` list, `toRow`)
- Test: `test/persistence/hederaColumns.test.ts`, `test/payments/ledgerNetwork.test.ts`

**Interfaces:** Produces `PaymentLedger.recordSettledOnNetwork(entityKey, payee, amount, network, ref): number` (throws on a duplicate `(network, ref)`), `EntityRepository.setHederaLink(key, { accountId, agentPublicKey, guardianPublicKey, linkedAt })`, `EntityRepository.setHederaIdentity(key, { agentId, registerTx, uaid })`, and the seven `EntityRecord` fields.

- [ ] **Step 1: Failing tests.** `ledgerNetwork.test.ts`: insert two settled Hedera rows with different refs → both present; the same ref twice → second throws `/UNIQUE/`; `recordAuthorized` still works with `network` `NULL` and `runningPending` counts it. `hederaColumns.test.ts`: `migrate` twice on one db is idempotent; `upsert` an entity, `setHederaLink`, `findByPublicId` returns the four link fields; `setHederaIdentity` returns the three identity fields; an entity never linked returns `null` for all seven.
- [ ] **Step 2: Migration** in `migrate`, after the `formation_payments` block:

```ts
  // Hedera rail (design 2026-09-10 D5, D24): network is NULL for every Arc row, so a mainnet
  // flip never mislabels history; the partial unique index is what makes a reported Hedera
  // transaction id count once.
  const ledgerCols = (
    db.prepare("PRAGMA table_info(payments_ledger)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!ledgerCols.includes("network")) db.exec("ALTER TABLE payments_ledger ADD COLUMN network TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ledger_network_ref ON payments_ledger(network, batch_ref) WHERE network IS NOT NULL",
  );
  for (const [col, type] of [
    ["hedera_account_id", "TEXT"],
    ["hedera_agent_public_key", "TEXT"],
    ["hedera_guardian_public_key", "TEXT"],
    ["hedera_linked_at", "INTEGER"],
    ["hedera_agent_id", "TEXT"],
    ["hedera_register_tx", "TEXT"],
    ["uaid", "TEXT"],
  ] as const)
    if (!cols.includes(col)) db.exec(`ALTER TABLE entities ADD COLUMN ${col} ${type}`);
```

(`cols` is the `entities` column list already built at `:692`; place this block after it.)

- [ ] **Step 3: Ledger.** Add to `PaymentLedger`:

```ts
  /** A Hedera payment reported by the agent and CONFIRMED on the mirror node (design D13). */
  recordSettledOnNetwork(
    entityKey: string,
    payee: string,
    amount: bigint,
    network: string,
    ref: string,
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO payments_ledger (entity_key, payee, amount, status, batch_ref, network, created_at, settled_at) VALUES (?, ?, ?, 'settled', ?, ?, ?, ?)",
      )
      .run(entityKey, payee, amount.toString(), ref, network, nowSeconds(), nowSeconds());
    return Number(info.lastInsertRowid);
  }
```

No read helper: nothing in this build consumes Hedera ledger rows (design Non-goals; audit C18). Task 8 step 6 reads the row with `sqlite3`.

- [ ] **Step 4: Types and repository.** Add the seven optional nullable fields to `EntityRecord` after `oaAmendmentExecutableAt` (`types.ts:111`), the seven snake-case columns to `Row`, seven lines to `toRecord` in the `?? null` style of `:191-196`, the columns to `INSERT_COLUMNS`, `INSERT_VALUES` (as `@hedera_account_id` …) and the `ON CONFLICT` set list, and the two methods:

```ts
  setHederaLink(
    key: string,
    link: { accountId: string; agentPublicKey: string; guardianPublicKey: string; linkedAt: number },
  ): void {
    this.db
      .prepare(
        "UPDATE entities SET hedera_account_id=?, hedera_agent_public_key=?, hedera_guardian_public_key=?, hedera_linked_at=?, updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=?",
      )
      .run(link.accountId, link.agentPublicKey, link.guardianPublicKey, link.linkedAt, key);
  }

  setHederaIdentity(key: string, id: { agentId: string; registerTx: string; uaid: string }): void {
    this.db
      .prepare(
        "UPDATE entities SET hedera_agent_id=?, hedera_register_tx=?, uaid=?, updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=?",
      )
      .run(id.agentId, id.registerTx, id.uaid, key);
  }
```

Add both signatures to the `EntityRepository` interface the class implements.

- [ ] **Step 5:** Tests green; three checks; suite = baseline + 5 + new tests. **Do not proceed if** `test/entityRepository.test.ts` fails: the `ON CONFLICT` list is the usual culprit.
- [ ] **Step 6: Commit.** → `feat(hedera): ledger network column, entity hedera columns, repository setters (task 3)`.

### Task 4: Mirror node client and the key decoder

**Files:**
- Create: `src/hedera/mirror.ts`, `src/hedera/keyDecode.ts`
- Test: `test/hedera/mirror.test.ts`, `test/hedera/keyDecode.test.ts`

**Interfaces:** Produces

```ts
export interface MirrorAccount { account: string; keyHex: string | null; keyType: string | null; evmAddress: string | null }
export interface MirrorTransfer { tokenId: string; account: string; amount: bigint }
export interface MirrorTransaction { transactionId: string; name: string; result: string; consensusTimestamp: string; tokenTransfers: MirrorTransfer[] }
export class HederaMirror {
  constructor(baseUrl: string, fetchImpl?: typeof fetch);
  account(id: string): Promise<MirrorAccount | null>;
  tokenBalance(id: string, tokenId: string): Promise<bigint>;          // 0n when not associated
  transaction(txId: string): Promise<MirrorTransaction[] | null>;      // all records under one id, null when not indexed
  waitTransaction(txId: string, opts: { timeoutMs: number; intervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<MirrorTransaction[] | null>;
}
export function mirrorTxId(id: string): string;  // "0.0.7162784@1788998489.006924053" -> "0.0.7162784-1788998489-006924053"; passes the dashed form through
export type DecodedKey =
  | { kind: "single"; keyHex: string }
  | { kind: "threshold"; threshold: number; keys: DecodedKey[] }
  | { kind: "list"; keys: DecodedKey[] };
export function decodeHederaKey(hex: string): DecodedKey;
```

- [ ] **Step 1: Failing tests.** `mirror.test.ts` with a fake `fetch` returning canned JSON: `mirrorTxId` both forms; `account` maps `key._type`/`key.key`/`evm_address`; `tokenBalance` reads `tokens[0].balance` and returns `0n` for `{ tokens: [] }`; `transaction` returns `null` on 404 and maps `token_transfers[].amount` to `bigint`; `waitTransaction` polls with injected `sleep` until non-null and returns `null` after `timeoutMs`. `keyDecode.test.ts` pins these five golden vectors (hand-built 2026-09-10 from the Hedera protobuf `Key` layout and re-derived in the audit; keys `A`, `B`, `C` are the compressed public keys of private keys `0x11…11`, `0x22…22`, `0x33…33`, re-derived with `@noble/curves`). Export `A`, `B`, `C` and the five vectors from the test file so task 5 imports them:

```ts
export const A = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
export const B = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
export const C = "023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1";
export const SINGLE = `3a21${A}`;
export const ONE_OF_TWO = `2a4e0801124a0a233a21${A}0a233a21${B}`;
export const TWO_OF_TWO = `324a0a233a21${A}0a233a21${B}`;
export const ONE_OF_THREE = `2a730801126f0a233a21${A}0a233a21${B}0a233a21${C}`;
export const THRESHOLD_TWO = `2a4e0802124a0a233a21${A}0a233a21${B}`;
test("single ECDSA key", () => expect(decodeHederaKey(SINGLE)).toEqual({ kind: "single", keyHex: A }));
test("1-of-2 threshold", () =>
  expect(decodeHederaKey(ONE_OF_TWO)).toEqual({
    kind: "threshold", threshold: 1,
    keys: [{ kind: "single", keyHex: A }, { kind: "single", keyHex: B }],
  }));
test("plain two-key list is 2-of-2", () =>
  expect(decodeHederaKey(TWO_OF_TWO)).toEqual({ kind: "list", keys: [{ kind: "single", keyHex: A }, { kind: "single", keyHex: B }] }));
test("1-of-3 threshold decodes with three members", () =>
  expect(decodeHederaKey(ONE_OF_THREE)).toMatchObject({ kind: "threshold", threshold: 1 }) &&
  expect((decodeHederaKey(ONE_OF_THREE) as { keys: unknown[] }).keys).toHaveLength(3));
test("2-of-2 threshold decodes with threshold 2", () =>
  expect(decodeHederaKey(THRESHOLD_TWO)).toMatchObject({ kind: "threshold", threshold: 2 }));
```

Layout, for the reader: `2a` is field 5 (`ThresholdKey`) wire type 2; `08 01` its `threshold`; `12 <len>` its `KeyList`; each `0a 23 3a 21 <33 bytes>` is one `Key` holding field 7 (`ECDSA_secp256k1`); `32` is field 6 (`KeyList`) at the top level.

- [ ] **Step 2: `keyDecode.ts`.** A 60-line protobuf reader: varint tag, wire type 2 length-delimited only. `Key` fields: `5` = `ThresholdKey { 1: uint32 threshold; 2: KeyList keys }`, `6` = `KeyList { 1: repeated Key }`, `7` = `bytes ECDSA_secp256k1`, `2` = `bytes ed25519` (decode as `single` too, tagged in `keyHex` by length 64). Any other field number throws `unsupported key field ${n}`. Comment at the top: why hand-written (design D24: the server keeps its Hedera surface to REST and never constructs SDK transaction objects; `@hiero-ledger/sdk` is in `node_modules` only as `@x402/hedera`'s dependency and is not imported by `src/`; the mirror node returns key lists only as protobuf hex).
- [ ] **Step 3: `mirror.ts`.** Paths: `/api/v1/accounts/${id}`, `/api/v1/accounts/${id}/tokens?token.id=${tokenId}`, `/api/v1/transactions/${mirrorTxId(txId)}`. A non-200 other than 404 throws `mirror ${path} -> ${status}`. `waitTransaction` loops `transaction()` until non-null or `now() - start >= timeoutMs`, sleeping `intervalMs` (default `sleep` = `setTimeout` promise).
- [ ] **Step 4:** Tests green; three checks. **Commit** → `feat(hedera): mirror node client and protobuf key decoder with golden vectors (task 4)`.

### Task 5: The three MCP tools

**Files:**
- Create: `src/hedera/policy.ts`
- Modify: `src/payments/policyGate.ts:4` (`payee?: Address` → `payee?: string`), `src/api/app.ts` (`ApiDeps`, add `hedera?: HederaDeps` beside `legalBody?` at `:218`), `src/mcp/server.ts` (`McpToolDeps` `:57-104` add `hedera?`, `MCP_TOOL_DEP_KEYS` `:122-153` add `"hedera"`, three `registerTool` calls after `onboard_agent` which ends before `:1272`)
- Modify: `src/api/main.ts` (build `hedera` beside `legalBody` at `:215`; pass it in the `buildApiApp` call that starts at `:754` and closes at `:880`)
- Test: `test/mcp/hedera.int.test.ts`

**Interfaces:** Consumes task 3 and 4. Produces on `ApiDeps`: `hedera?: { cfg: HederaConfig; mirror: HederaMirror; ledger: PaymentLedger; spendAllowlistThreshold: bigint }` (`export interface HederaDeps` in `src/hedera/policy.ts`; the threshold is copied from `cfg.spendAllowlistThreshold` in `main.ts`, the same value `entityPayment.ts:216` forwards for Arc), and

```ts
export async function hederaPolicyInput(args: {
  entity: EntityRecord; amount: bigint; payee: string;
  reads: LegalBodyChainReads; mirror: HederaMirror; usdcTokenId: string;
  perTxCap?: bigint; allowlistEnabled: boolean; threshold?: bigint;
}): Promise<PolicyInput>
```

which sets `available` = float balance (D14), `runningPending = 0n` (D8), `isAllowed = false` (D15), `legalActive` and `paused` from the Arc reads.

- [ ] **Step 1: Failing test.** Scaffold: `const { db, repo, rec, apiKeys } = hederaDb();` then `hederaApp({ repo, apiKeys, hedera: { cfg: HEDERA_CFG, mirror: fakeMirror({...}), ledger: new PaymentLedger(db), spendAllowlistThreshold: 1_000_000_000n }, legalBody: { ...defaults, chainReads: arcReads({ paused }) } })` and `startMcpTestClient(app, apiKey)`, where `HEDERA_CFG = { network: "testnet", facilitatorUrl: "https://f.test", mirrorUrl: "https://m.test", usdcTokenId: "0.0.429274", payToAccountId: "0.0.10412694", verifyPriceUsdc: "0.001", verifyPriceAtomic: 1000n }`. Cases, each a `client.callTool({ name, arguments })` and a `JSON.parse(result.content[0].text)`:
  - `link_hedera_account` with a mirror account whose key is `ONE_OF_TWO` and `publicKey = A` → `{ ok: true, accountId, guardianPublicKey: B }` and the entity row carries the four fields; with `SINGLE` → `{ ok: false, reason: "not-a-1-of-2-list" }`; with `TWO_OF_TWO` → same reason; with `ONE_OF_THREE` → same reason (three members); with `THRESHOLD_TWO` → same reason (threshold 2); with a 1-of-2 list whose second member is a 32-byte ed25519 key (build it as `2a4d080112490a233a21${A}0a221220${"ab".repeat(32)}`: field 2 inside the second `Key`, list length 73, threshold-key length 77) → same reason (design D24: ECDSA members only); with `ONE_OF_TWO` and `publicKey = "03" + "ff".repeat(32)` → `{ ok: false, reason: "public-key-not-in-list" }`; a second call with the same values → `{ ok: true }`; with different values → `{ ok: false, reason: "already-linked" }`. Import the vectors from `test/hedera/keyDecode.test.ts`.
  - `check_policy` before any link → `{ ok: false, reason: "not-linked" }`; linked, paused on Arc → `paused`; linked, `allowlistEnabled: true` on the treasury config → `not-allowlisted`; linked, allowlist off, `spendAllowlistThreshold: 500n` in the deps and amount `1000` → `over-threshold-needs-allowlist` (D15: `isAllowed` is always false on Hedera, so the threshold rule fails closed above it; the scaffold's default threshold is deliberately high); linked, balance `500n`, amount `1000` → `over-cap`; linked, balance `5000n`, amount `1000` → `{ ok: true, available: "5000" }`.
  - `report_payment` with a mirror transaction `SUCCESS` carrying `{ tokenId: usdc, account: linkedAccount, amount: -1000n }` and `{ account: payee, amount: 1000n }` → `{ status: "settled", ledgerId }`; the same `transactionId` again → `{ status: "settled", duplicate: true }` and no second row; result `INVALID_SIGNATURE` with `tokenTransfers: []` (the shape the mirror node returns for the spike's failed transfer, pre-cleared) → `{ status: "failed", reason: "INVALID_SIGNATURE" }` and a `failed` row; mirror returns `null` throughout → `{ status: "pending" }` and no row; wrong payee → `{ status: "failed", reason: "transfer-mismatch" }`; right payee, amount `999n` against a reported `1000` → `transfer-mismatch` too.
  - Every tool with an id owned by another tenant → `isError: true`, text `not found`.
- [ ] **Step 2: `policy.ts`** implementing `HederaDeps` and `hederaPolicyInput` as specified; `legalActive` is `(await reads.legalStatus(proxy)) === 0`, `paused` is `reads.treasuryPaused(treasury)`, both inside the same try as `readStanding` (`payments/legalBody.ts:85-99`); a failed read yields `legalActive: false` (fail closed, D8 spirit).
- [ ] **Step 3: Tools** in `server.ts`, after `onboard_agent`, each starting with the `pay` tool's guard lines (`:514-517`) and `if (!deps.hedera) return { content: [{ type: "text", text: "hedera unavailable" }], isError: true };`:

```ts
  server.registerTool(
    "link_hedera_account",
    {
      title: "Link a Hedera float account",
      description:
        "Record this entity's self-custodied Hedera float account. The account must carry a 1-of-2 key list of the guardian and the agent; the agent's public key must be one of the two.",
      inputSchema: { id: z.string(), accountId: z.string(), publicKey: z.string() },
    },
    async ({ id, accountId, publicKey }) => {
      // guards as in `pay`
      const acct = await deps.hedera.mirror.account(accountId);
      if (!acct?.keyHex) return json({ ok: false, reason: "account-not-found-or-hollow" });
      const key = decodeHederaKey(acct.keyHex);
      // Design D24: threshold 1, exactly two members, both compressed ECDSA (33 bytes = 66 hex chars).
      if (
        key.kind !== "threshold" ||
        key.threshold !== 1 ||
        key.keys.length !== 2 ||
        key.keys.some((k) => k.kind !== "single" || k.keyHex.length !== 66)
      )
        return json({ ok: false, reason: "not-a-1-of-2-list" });
      const pub = publicKey.toLowerCase();
      const singles = key.keys.map((k) => (k as { keyHex: string }).keyHex.toLowerCase());
      if (!singles.includes(pub)) return json({ ok: false, reason: "public-key-not-in-list" });
      const guardian = singles.find((k) => k !== pub) as string;
      if (rec.hederaAccountId) {
        const same = rec.hederaAccountId === accountId && rec.hederaAgentPublicKey === pub;
        return json(same ? { ok: true, accountId, guardianPublicKey: rec.hederaGuardianPublicKey } : { ok: false, reason: "already-linked" });
      }
      repo.setHederaLink(id, { accountId, agentPublicKey: pub, guardianPublicKey: guardian, linkedAt: Math.floor(Date.now() / 1000) });
      return json({ ok: true, accountId, guardianPublicKey: guardian });
    },
  );
```

`json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] })`. `check_policy` takes `{ id, payee, amountUsdc, network }`, validates `amountUsdc` exactly as `pay` does (`:518-529`), refuses `network !== "hedera:testnet"` with `unsupported-network`, returns `not-linked` without a `hederaAccountId`, then `evaluatePolicy(await hederaPolicyInput({...}))` with `perTxCap: rec.perTxCap ?? undefined`, `allowlistEnabled: rec.treasuryConfig?.allowlistEnabled ?? false`, `threshold: deps.hedera.spendAllowlistThreshold` (it rides on `HederaDeps`; nothing else on `McpToolDeps` changes), and answers `{ ok: true, available }` or the decision. `report_payment` takes `{ id, payee, amountUsdc, network, transactionId, idempotencyKey }` (`idempotencyKey` is accepted for symmetry with `pay` and is not consulted: the partial unique index governs, D5; say so in the tool description): `waitTransaction(transactionId, { timeoutMs: 10_000, intervalMs: 1_000 })` (D16); `null` → `pending`; the `CRYPTOTRANSFER` record with `result !== "SUCCESS"` → `failed` with the result string and `recordAuthorized`+`markFailed` is NOT used, instead a direct `failed` insert helper `recordFailedOnNetwork` (add it to the ledger beside `recordSettledOnNetwork`, same shape, status `'failed'`, no unique conflict since `batch_ref` is the tx id and the partial index covers `failed` rows too, so a failed id also counts once); `SUCCESS` → find one transfer `{ tokenId === usdcTokenId, account === rec.hederaAccountId, amount === -amount }` and one `{ account === payee, amount === amount }`, else `failed` with `transfer-mismatch`; then `recordSettledOnNetwork`, catching the `UNIQUE` error as `{ status: "settled", duplicate: true }`.

- [ ] **Step 4: Wiring.** `main.ts`: `const hedera = cfg.hedera ? { cfg: cfg.hedera, mirror: new HederaMirror(cfg.hedera.mirrorUrl), ledger: new PaymentLedger(db), spendAllowlistThreshold: cfg.spendAllowlistThreshold } : undefined;` and `hedera,` in the `buildApiApp` object. `transport.ts` needs nothing: the key list copies it.
- [ ] **Step 5:** Tests green; three checks. `MCP_TOOL_DEP_KEYS` fails to compile until `"hedera"` is listed: that is the expected first typecheck failure. **Commit** → `feat(hedera): link_hedera_account, check_policy, report_payment MCP tools (task 5)`.

### Task 6: `GET /verify/:publicId`, unsigned, paid on Hedera

**Files:**
- Create: `src/api/routes/verify.ts`, `src/hedera/attestation.ts`
- Modify: `src/api/routes/legalBodies.ts` (export `createClientLimiter(deps): (c) => TokenBucket` built from the closure at `:141-166` and the shared bucket beside it as `sharedReadBudget(deps): TokenBucket`, reusing both in place, audit C9), `src/api/app.ts:325` (mount after `mountLegalBodyRoutes`), `src/api/main.ts` (nothing new; `hedera` and `legalBody` deps already pass)
- Test: `test/api/verify.route.test.ts`

**Interfaces:** Produces `mountVerifyRoutes(app, deps: ApiDeps): void` (returns early without `deps.hedera` or `deps.legalBody`), and

```ts
export interface AttestationBody {
  subject: { publicId: string; name: string; agentId: string | null; registry: string; treasury: string; uaid: string | null };
  standing: "active" | "inactive" | "unknown";
  formation: { filed: boolean; einIssued: boolean; status: string; environment: string } | null;
  controller: { humanVerified: boolean; credential: string | null };
  legalBody: { oaHash: string | null; manifestVersion: number | null };
  issuedAt: string; expiresAt: string;
}
export async function buildAttestation(entity: EntityRecord, deps: { lookup: LegalBodyLookupDeps; worldId?: ApiDeps["worldId"]; chainId: number; identityRegistry: string; now: () => number }): Promise<AttestationBody>
```

- [ ] **Step 1: Failing test.** Scaffold: `hederaDb()` then `hederaApp({ repo, hedera: { cfg: HEDERA_CFG, mirror: fakeMirror({}), ledger, spendAllowlistThreshold: 1_000_000_000n }, worldId: { store: { findByTenant: () => ({ credential: "orb", nullifier: "n", verifiedAt: 1, environment: "production" }) }, cfg: { action: "guardian-verification" } } })`. `HTTPFacilitatorClient` has no `fetch` option (pre-cleared), so stub the global with `vi.stubGlobal("fetch", …)` in `beforeEach` and restore it in `afterEach`. The stub answers three paths on `HEDERA_CFG.facilitatorUrl`: `GET /supported` → `{ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.7162784" } }], extensions: [], signers: { "hedera:*": ["0.0.7162784"] } }` (the middleware fetches it at mount, and `ExactHederaScheme` copies `extra.feePayer` into every requirement from it; without this the mount throws), `POST /verify` and `POST /settle` as each case says. Decode the 402 with `decodePaymentRequiredHeader` from `@x402/core/http` (or the equivalent export the `.d.ts` shows): in v2 the requirements travel in the `PAYMENT-REQUIRED` header and the JSON body is `{}` (pre-cleared).
  - flag off (`hedera` undefined) → `GET /verify/<uuid>` is 404.
  - unknown `publicId` → 404 with `{ error: "not_found" }` and **no** `PAYMENT-REQUIRED` header, and the stub saw only `/supported`.
  - known entity not public on chain (`status: "pending"`) → 404 likewise.
  - known, no payment header → 402; the decoded header's `accepts[0]` matches `{ scheme: "exact", network: "hedera:testnet", payTo: "0.0.10412694", asset: "0.0.429274", amount: "1000", extra: { feePayer: "0.0.7162784" } }`; the body is `{}`.
  - the per-client limiter exhausted → 429 before any 402; the shared bucket exhausted → 429 likewise.
  - a malformed `PAYMENT-SIGNATURE` header (not base64 JSON) → 402 and the stub never saw `/verify`.
  - facilitator `verify` returns `{ isValid: false, invalidReason: "x" }` for a well-formed header → 402 and no body fields from the attestation.
  - facilitator `verify` valid and `settle` `{ success: true, transaction: "0.0.7162784@1788998489.006924053", network: "hedera:testnet" }` → 200, body has `subject.publicId`, `standing: "active"`, `controller.humanVerified: true` when the World store has a verification, `expiresAt` 300 s after `issuedAt`, no `signature` field yet, and header `PAYMENT-RESPONSE` present.
  - facilitator `settle` `{ success: false, errorReason: "transaction_failed" }` → 402 and no attestation body.
- [ ] **Step 2: `attestation.ts`** building `AttestationBody` from `lookup.resolver`'s `readStanding` (call `readStanding(deps.lookup.chainReads, proxy, treasury)`; add `chainReads: LegalBodyChainReads` to `LegalBodyLookupDeps` in `legalBodies.ts` and pass `arc` for it in `main.ts:852-878`), `lookup.formationSummary` via the `formationOf` shape at `legalBodies.ts:185-196` (lift that function to an export), `worldId.store.findByTenant` as `metadata.ts:55-69` does (`humanVerified: gv.credential !== "waiver"`), and `entity.oaHash`/`oaManifestVersion`.
- [ ] **Step 3: `verify.ts`:**

```ts
export function mountVerifyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const h = deps.hedera;
  const lb = deps.legalBody;
  if (!h || !lb) return;
  const limiter = createClientLimiter(deps);
  const shared = sharedReadBudget(deps);
  const facilitator = new HTTPFacilitatorClient({ url: h.cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register("hedera:*", new ExactHederaScheme());
  const routes: RoutesConfig = {
    "GET /verify/:publicId": {
      accepts: {
        scheme: "exact",
        network: "hedera:testnet",
        payTo: h.cfg.payToAccountId,
        price: { amount: h.cfg.verifyPriceAtomic.toString(), asset: h.cfg.usdcTokenId },
      },
      description: "Novi Corpus legal-standing check: is this a registered legal body in good standing?",
      mimeType: "application/json",
    },
  };
  // Layer 1: limiter and the 404 guard, BEFORE any 402 is issued (design D9).
  app.use("/verify/:publicId", async (c, next) => {
    if (!limiter(c).take() || !shared.take())
      return c.json({ error: "rate_limited", message: "try again in a few seconds" }, 429);
    const publicId = c.req.param("publicId");
    const ent = UUID.test(publicId) ? deps.repo.findByPublicId(publicId) : undefined;
    if (!ent || !isPublicOnChain(ent)) return c.json({ error: "not_found" }, 404);
    c.set("verifyEntity", ent);
    await next();
  });
  // Layer 2: the x402 middleware (402, verify, settle; discards our body on a failed settle).
  // syncFacilitatorOnStart stays at its default (true): with false the middleware never
  // initializes and every request answers 500 (design Pre-cleared, audit B8).
  app.use("/verify/:publicId", paymentMiddleware(routes, server));
  // Layer 3: the handler.
  app.get("/verify/:publicId", async (c) => {
    const ent = c.get("verifyEntity") as EntityRecord;
    const body = await buildAttestation(ent, { lookup: lb, worldId: deps.worldId, chainId: deps.chainId, identityRegistry: deps.ens?.identityRegistry ?? "", now: deps.now ?? Date.now });
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
```

The mount fetches the facilitator's `/supported` once (a background promise; a failure there is retried on the first request by the middleware's own `initializeHttpServer`), which is why every route test stubs that path. Declare `verifyEntity` in the app's `Variables` type or use `c.set` with a cast; pick whichever keeps `typecheck` green. Register the mount at `app.ts` after `:325`: `mountVerifyRoutes(app, deps);`.

- [ ] **Step 4:** Tests green; three checks. **Commit** → `feat(hedera): GET /verify/:publicId paid on hedera:testnet through @x402/hono, unsigned body (task 6)`.

### Task 7: The client package

**Files:**
- Create: everything under `back/hedera-client/` listed in File structure.
- Test: `back/hedera-client/test/signer.test.ts`, `test/pay.test.ts`

**Interfaces:** Produces the `novi-hedera` commands and, for task 8 and 15, `createNoviClient({ mcpUrl, apiKey }): { checkPolicy, reportPayment, linkHederaAccount }`, `custodyAgnosticSigner(accountId, pub, rawSign)`, `localRawSigner(privHex)`, `payFetchFor({ signer, novi, entityId }): typeof fetch`.

- [ ] **Step 1: Scaffold.** `package.json`: `{ "name": "@novicorpus/hedera-client", "private": true, "type": "module", "bin": { "novi-hedera": "src/cli.ts" }, "scripts": { "test": "vitest run", "lint": "biome check .", "typecheck": "tsc --noEmit" }, "dependencies": { "@x402/core": "2.25.0", "@x402/fetch": "2.25.0", "@x402/hedera": "2.25.0", "@hiero-ledger/sdk": "2.85.0", "@noble/curves": "1.8.1", "@noble/hashes": "1.7.1", "@modelcontextprotocol/sdk": "1.29.0", "tsx": "^4.23.13" }, "devDependencies": { "vitest": "^2.1.0", "@biomejs/biome": "^1.9.0", "typescript": "^5.6.0" } }`. Copy `back/backend/biome.json` and a minimal `tsconfig.json` (`"module": "NodeNext"`, `"strict": true`). `.env.tpl` with `op://` references: `TREASURY_ACCOUNT_ID`, `TREASURY_PRIVATE_KEY` (item `Hedera Testnet Treasury`), `AGENT_ACCOUNT_ID`, `AGENT_PRIVATE_KEY` (item `Hedera Spike Agent Key`), `NOVI_MCP_URL` (`http://127.0.0.1:8787/mcp` for task 8, `https://www.novicorpus.com/backend/mcp` for the demo, D28), `NOVI_API_KEY` (item `Novi Corpus Demo API Key`, created in task 8 locally and re-minted on prod in task 16), `NOVI_ENTITY_ID` (`HederaDemo_local`'s id for task 8, `HederaDemo_1`'s for the demo), `NOVI_PROFILE_URL` (`HederaDemo_1`'s own profile URL, task 12), `HEDERA_MIRROR_URL`, `USDC_TOKEN_ID=0.0.429274`. Confirm `npm install` reports no `@hashgraph/sdk`. Add a `hedera-client` job to `.github/workflows/ci.yml` mirroring the backend job (`working-directory: back/hedera-client`, `npm ci`, typecheck, lint, test), gated on the same paths filter idiom with `back/hedera-client/**` (audit U4).
- [ ] **Step 2: Failing tests.** `signer.test.ts` is the spike's step 0 as a test: build `const signer = custodyAgnosticSigner("0.0.10450558", pub, localRawSigner("0x" + "11".repeat(32)))`, call `signer.createPartiallySignedTransferTransaction({ scheme: "exact", network: "hedera:testnet", payTo: "0.0.10412694", asset: "0.0.429274", amount: "1000", extra: { feePayer: "0.0.7162784" }, ... })` (a method on `ClientHederaSigner`, not a package export, pre-cleared), decode the base64 with `Transaction.fromBytes`, and assert `PublicKey.verifyTransaction` is true and the signature equals the one `tx.sign(PrivateKey)` produces on an identical transaction. `pay.test.ts`: `payFetchFor` with a fake `novi.checkPolicy` returning `{ ok: false, reason: "paused" }` → the wrapped fetch rejects with an error matching `/policy denied: paused/` (the SDK wraps it as `Failed to create payment payload: Payment creation aborted: policy denied: paused`, pre-cleared) before any signing (assert the signer was never called); with `{ ok: true }` and a fake 402/200 server → `reportPayment` is called with the `transaction` from the decoded `PAYMENT-RESPONSE`, and is retried once when it answers `pending`.
- [ ] **Step 3: `signer.ts`** = the spike's `localRawSigner` and `custodyAgnosticSigner` verbatim (`hedera-signer-spike/src/lib.ts:20-50`; the spike's type-only `PublicKey` import from `@x402/hedera` is not a real export there, import the type from `@hiero-ledger/sdk`), `RawSign` exported, plus the doc comment "A1/A2 adapters implement `RawSign` against Turnkey raw-payload or a KMS; nothing else changes."
- [ ] **Step 4: `novi.ts`:** an MCP client (`Client` + `StreamableHTTPClientTransport` with `authorization: Bearer <apiKey>`, exactly `back/backend/test/mcp/helpers.ts:14-17`) exposing the three tools as typed functions that parse `content[0].text` as JSON.
- [ ] **Step 5: `pay.ts`:**

```ts
export function payFetchFor(o: { signer: ClientHederaSigner; novi: NoviClient; entityId: string; fetchImpl?: typeof fetch }) {
  const client = new x402Client().register("hedera:*", new ExactHederaScheme(o.signer));
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    const verdict = await o.novi.checkPolicy({ id: o.entityId, payee: r.payTo, amountUsdc: r.amount, network: r.network });
    if (!verdict.ok) return { abort: true, reason: `policy denied: ${verdict.reason}` };
  });
  const paid = wrapFetchWithPayment(o.fetchImpl ?? fetch, client);
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await paid(input, init);
    const hdr = res.headers.get("PAYMENT-RESPONSE");
    if (hdr) {
      const s = decodePaymentResponseHeader(hdr);
      if (s.success && s.transaction) await reportUntilSettled(o.novi, o.entityId, s, res);
    }
    return res;
  };
}
```

`reportUntilSettled` calls `reportPayment` with `{ id, payee, amountUsdc, network: "hedera:testnet", transactionId: s.transaction, idempotencyKey: s.transaction }` (payee and amount from the requirements the hook saw, kept in a closure) up to 3 times, 4 seconds apart, while the answer is `pending`. The abort surfaces as a thrown error from `wrapFetchWithPayment` (pre-cleared); the command layer catches it, prints `policy denied: <reason>` and exits 2, so leg 3 of the demo shows the refusal and no HashScan link. A refused settlement (402 with `PAYMENT-RESPONSE` `success: false`) is not reported and never reaches the ledger; the README says so (design Component 7).

- [ ] **Step 6: Commands.** `provision`: generate or read the agent key (spike `02-hollow-account.ts`), transfer 1 USDC from the treasury item to the agent's EVM alias, wait for the account on the mirror, then set the 1-of-2 key list (spike `04-keylist.ts` `list` branch) **without any payment in between**, then set the memo `hcs-11:<NOVI_PROFILE_URL>` when that env var is present, then print `accountId` and `publicKey` and the exact `link_hedera_account` call; `provision --memo-only` skips to the memo step on the existing `AGENT_ACCOUNT_ID`. **Do not proceed if** the key-list update on the still-hollow account fails with anything but `SUCCESS`: fall back to a 0.001 USDC self-transfer signed by the agent key to complete the account, retry, and record which order worked (design component 7). `link`: calls `linkHederaAccount` with `NOVI_ENTITY_ID`, `AGENT_ACCOUNT_ID` and the agent public key, prints the JSON answer. `revoke`: the spike's `rotate` branch. `pay <url>`: `payFetchFor` and print status, body head, and the HashScan link. `demo-buyer`: task 15.
- [ ] **Step 7:** `npm test`, `npm run lint`, `npm run typecheck` in the client. **Commit** → `feat(hedera-client): signer, MCP policy client, paying fetch with check_policy hook, provision/revoke/pay commands (task 7)`.

### Task 8: LIVE: the rail end to end, then pull request 1

**Files:** `back/backend/README.md` (a "Hedera rail" section: the flag, the three tools, D2 and D15 said plainly, the run below), this plan's Records.

- [ ] **Step 1:** Start the backend locally with the flag on (D28; its database holds `HederaDemo_local` from task 0 step 9): `cd back/backend && op run --env-file=.env.hedera.tpl -- npm run api` where `.env.hedera.tpl` is a copy of the deployment's template with the `HEDERA_*` server values from the naming table (`HEDERA_PAYTO_ACCOUNT_ID=0.0.10412694`). Expected boot line includes `hedera: { network: 'testnet'` and `attestationKey: undefined`, and `curl -s http://127.0.0.1:8787/legal-bodies/<HederaDemo_local treasury>` answers `"standing":"active"`.
- [ ] **Step 2:** Create an API key for `HederaDemo_local`'s tenant (Alex's wallet on the local backend) with `spend` capability through the existing `/api-keys` flow (the `cli.int.test.ts` sequence), store it in 1Password as `Novi Corpus Demo API Key` (field `local`). Expected: `whoami` over MCP returns Alex's tenant. This key exists only in the local database; task 16 mints the prod one into the same item (field `prod`).
- [ ] **Step 3:** `cd back/hedera-client && op run --env-file=.env.tpl -- npx tsx src/cli.ts provision`. Expected last lines: `account 0.0.<new> key ThresholdKey(1 of 2)` and the printed link call. Record the account id and the two transaction ids.
- [ ] **Step 4:** Link: `op run … -- npx tsx src/cli.ts link` (a thin command that calls `linkHederaAccount`). Expected: `{"ok":true,"accountId":"0.0.<new>","guardianPublicKey":"03afcd…"}`.
- [ ] **Step 5:** Pay: `op run … -- npx tsx src/cli.ts pay http://127.0.0.1:8787/verify/<HederaDemo_local publicId>`. Expected: `HTTP 200`, body starting `{"subject":{"publicId":"<HederaDemo_local publicId>`, `settlement: OK https://hashscan.io/testnet/transaction/0.0.7162784@…`, then `report_payment -> settled`. Open the HashScan link: `CRYPTOTRANSFER SUCCESS`, 0.001 USDC to `0.0.10412694`. Record the transaction id and a screen capture at once: this is the D27 line and the evidence if Blocky402 is down later (audit U3). **Do not proceed if** the report stays `pending` after three tries: read the mirror node by timestamp, fix `mirrorTxId`, and rerun. **If Blocky402 answers 5xx or times out on every try,** run the facilitator locally from `@x402/hedera`'s `x402Facilitator` with the spare account as fee payer (the start-now note's fallback), point `HEDERA_FACILITATOR_URL` at it, and record that the settlement was self-facilitated.
- [ ] **Step 6:** `sqlite3 ./data/legalbody.db "select network, status, batch_ref, amount from payments_ledger order by id desc limit 1"`. Expected: `hedera:testnet|settled|0.0.7162784@…|1000`.
- [ ] **Step 7:** README section (no key material, no 1Password field values, item titles only; the repo is public, audit U9); three checks; `superpowers:requesting-code-review` on the branch; **commit** → `docs(hedera): README section for the rail, live run recorded (task 8)`. Then `git push -u origin feat/hedera-rail` and `gh pr create --title "feat(hedera): the rail — self-custody payments on Hedera testnet, /verify unsigned (PR 1 of 3)" --body-file <a body listing tasks 1–8, the HashScan links, D1/D2/D15 in one paragraph each, and the AI-attribution line>`, reviewer Martin. **Merge step (ends phase 1):** D29: Martin has 24 hours; after that, CI green and Alex's diff read, `gh pr merge --merge --delete-branch` (D20), then `git checkout -b feat/hedera-identity origin/hedera`.

---

## Phase 2 — Pull request 2: portable identity (branch `feat/hedera-identity`)

**Must already be on `hedera`:** pull request 1 merged with `--merge`; `cfg.hedera`, the entity columns, `setHederaIdentity`, `HederaMirror`, and `/verify` all present. Branch: `feat/hedera-identity` from `origin/hedera`; PR base `hedera`.
**Ends with:** task 12's merge step. Under D27, this phase shrinks to tasks 9 and 10 (registration plus UAID) and merges without the profile route or the memo.

### Task 9: UAID derivation with a pinned golden vector

**Files:**
- Create: `src/hedera/uaid.ts`; Test: `test/hedera/uaid.test.ts`
- Modify: `package.json` (add `@scure/base@1.2.4`, `@noble/hashes` if not already transitive; pin exact)

**Interfaces:** Produces `canonicalizeAgentData(input: CanonicalAgentData): { normalized: CanonicalAgentData; canonicalJson: string }`, `deriveUaid(input: CanonicalAgentData, params: { uid: string }): string`, `uaidInputsFor(entity: EntityRecord, chainId: number): CanonicalAgentData` (D10), `parseUaidNativeId(uaid: string): string | null`.

- [ ] **Step 1: Golden vector, already generated (2026-09-10)** with `@hashgraphonline/standards-sdk@0.1.186`, `new HCS14Client().createUaid(input, { uid: "886257", proto: "mcp" })` (`proto` must be passed explicitly; the SDK's default params carry only `uid`, `registry` and `nativeId`), and cross-checked by an independent SHA-384 + Base58 implementation in the same script:

```
input:         { registry: "novicorpus", name: "FormationE2E_1", version: "1", protocol: "mcp",
                 nativeId: "eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf", skills: [] }
canonicalJson: {"skills":[],"name":"FormationE2E_1","nativeId":"eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf","protocol":"mcp","registry":"novicorpus","version":"1"}
uaid:          uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk;uid=886257;registry=novicorpus;proto=mcp;nativeId=eip155:5042002:0x92ae7c6b6eb9470d7e01f8feb352714bd80a7aaf
```

- [ ] **Step 2: Failing test:** canonical JSON equals the string above exactly (key order `skills,name,nativeId,protocol,registry,version`; `registry` and `protocol` lowercased; `nativeId` trimmed and lowercased by **our** `uaidInputsFor`, not by `canonicalizeAgentData`, mirroring the SDK); `deriveUaid` equals the UAID above; `parseUaidNativeId` returns the CAIP-10; a renamed entity yields a different id.
- [ ] **Step 3: `uaid.ts`:** SHA-384 from `@noble/hashes/sha2` (`sha384`), Base58 from `@scure/base` (`base58`), the canonicalization copied line for line from the SDK's `canonical.ts` (the reason for not importing it in the file's top comment: the SDK depends on `@hashgraph/sdk`, two Hedera SDK stacks). Params string `uid=…;registry=…;proto=…;nativeId=…` in that order (SDK `did.ts` `buildParamString`).
- [ ] **Step 4:** Tests green; three checks; **commit** → `feat(hedera): HCS-14 UAID derivation, canonicalization matching the standards SDK, golden vector (task 9)`.

### Task 10: ERC-8004 registration on Hedera testnet

**Files:**
- Create: `scripts/hedera-register-identity.mts`; Test: `test/hedera/registerIdentity.test.ts` (the pure part)
- Create: `src/hedera/registry.ts` with `registerOnHedera(o: { publicClient, walletClient, registry: Address, metadataURI: string }): Promise<{ agentId: string; txHash: Hex }>`

**Interfaces:** Consumes `iIdentityRegistryAbi` (`src/abis/generated.ts:10`, `register(string metadataURI) returns (uint256 agentId)`), `deriveUaid`, `repo.setHederaIdentity`.

- [ ] **Step 1: Failing test** for `registerOnHedera` with fake viem clients: `simulateContract` returns `{ result: 12n, request }`, `writeContract` returns a hash, `waitForTransactionReceipt` returns `status: "success"` → `{ agentId: "12", txHash }`; receipt `reverted` → throws `register reverted`.
- [ ] **Step 2: `registry.ts`:** `simulateContract({ address: registry, abi: iIdentityRegistryAbi, functionName: "register", args: [metadataURI], account })` → `writeContract(request)` → `waitForTransactionReceipt`. The agent id is the simulate result (the ABI carries no event to parse).
- [ ] **Step 3: Script** `scripts/hedera-register-identity.mts --entity <name|key> [--entity …] | --all-entities [--execute]` and `--record --entity <id> --agent-id <n> --tx <hash> --uaid <uaid>`, idiom `scripts/sweep-standing-float.mts:1-40`: `loadConfig()` for `dbPath` and `chainId`; script-only env `HEDERA_JSON_RPC_URL`, `HEDERA_OPERATOR_KEY` read from `process.env` and refused if missing; the registry address is `HEDERA_IDENTITY_REGISTRY` exported from `src/hedera/registry.ts` (audit C3); viem chain object `{ id: 296, name: "hedera-testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }`; for each named entity with `metadataURI` and no `hederaAgentId`: dry-run prints the metadata URI and the UAID; `--execute` registers, derives the UAID with `uaidInputsFor(entity, cfg.chainId)` and `uid = entity.agentId`, calls `setHederaIdentity`, prints `hashscan.io/testnet/transaction/<txHash>` and the exact `--record` line to run on the box. `--all-entities` is refused without `--execute --yes` and prints the count first (audit C17: 16 entities on prod, other tenants' included). `--record` writes the three values with `setHederaIdentity` and no chain call, for the box (D28). `--from-prod <publicId>` (repeatable) takes the entity from prod's public endpoints instead of the local database, which under D28 never holds the prod rows: `GET https://www.novicorpus.com/backend/metadata/<publicId>` for the metadata URI (the URL itself) and the `legalBody` block, `/transparency` for `name`, `treasury` and `agentId`; it registers with that URI, derives the UAID from those values, and prints the `--record` line. It refuses to run without `--execute` against anything but `www.novicorpus.com`.
- [ ] **Step 4: LIVE.** `op run --env-file=.env.register.tpl -- npx tsx scripts/hedera-register-identity.mts --from-prod 9f8003f5-4c70-435a-9980-9a54625691b7 --from-prod <HederaDemo_1 publicId> --execute` (the operator key's EVM alias equals the account's `evm_address`, pre-cleared, so the write spends `0.0.10412694`'s HBAR). Expected, twice: `registered agentId=<n> tx=0x… uaid=uaid:aid:…` and a `--record …` line. Record both, and hand the two `--record` lines to task 16. The first test in step 1 also covers `--from-prod` with a stubbed `fetch`: the UAID it derives for `FormationE2E_1`'s public values equals the task 9 golden vector.
- [ ] **Step 5:** Three checks; **commit** → `feat(hedera): ERC-8004 registration on Hedera testnet, identity script, UAID stored (task 10)`.

### Task 11: The profile route and the metadata cross-links

**Files:**
- Create: `src/api/routes/profile.ts`; Test: `test/api/profile.route.test.ts`
- Modify: `src/api/routes/metadata.ts:35-42` (ungate `registrations[]`), add `uaid` and `hedera` blocks before `:96`; `src/api/app.ts` mount after the metadata mount at `:321`

- [ ] **Step 1: Failing tests.** `/metadata/:publicId` with ENS unset and `hederaAgentId` set → `registrations` has one entry `{ agentId, agentRegistry: "eip155:296:0x8004a818…" }`; with both → two entries, Arc first; `uaid` present when set; `hedera: { accountId, verifyUrl, profileUrl }` present when linked. `/metadata/:publicId/profile` → 200 JSON with `version: "1.0"`, `type: 1`, `display_name: entity.name`, `uaid`, `aiAgent: { type: 1, capabilities: [], model: "novi-corpus-legal-body" }`, `properties: { legalBody: { standing?: never }, verifyUrl, metadataUrl, registrations }` (no standing, the profile is static; the claims ceiling applies to `properties.description`: "a registered legal body; check standing at verifyUrl"); 404 when no `uaid`; `Cache-Control: public, max-age=300`.
- [ ] **Step 2:** Implement; the Hedera registry address for `registrations[]` is the `HEDERA_IDENTITY_REGISTRY` constant imported from `src/hedera/registry.ts` (a public address; never `process.env`, never `Config`; audit C3). The `hedera.verifyUrl` and `profileUrl` are built from the same base the metadata links use (`links.metadataBase`), so on prod they are prod URLs (D28).
- [ ] **Step 3:** Tests; three checks; **commit** → `feat(hedera): HCS-11 profile route, metadata registrations ungated, uaid and hedera blocks (task 11)`.

### Task 12: Memo link from `provision`, then pull request 2

- [ ] **Step 1:** In the client, `provision` reads `NOVI_PROFILE_URL` and sets the account memo `hcs-11:<url>` (`AccountUpdateTransaction().setAccountMemo`, signed by the agent key and the guardian as the key-list update was). The URL is `HederaDemo_1`'s own profile, `https://www.novicorpus.com/backend/metadata/<HederaDemo_1 publicId>/profile`: an HCS-11 memo describes its own account, and `FormationE2E_1` has no Hedera account (audit C7; D23 is how a buyer reaches `FormationE2E_1`'s profile). HTTPS is a valid reference in the spec and the standards SDK resolver does not follow it (pre-cleared); **if Monday 2026-09-15 has slack,** add `provision --inscribe`: inscribe the profile JSON as one HCS-1 file from the operator account and set the memo to `hcs://1/<topicId>` so SDK-based agents resolve it too; say which memo is live in Records and the README.
- [ ] **Step 2: LIVE.** `provision --memo-only` on the linked account, with `NOVI_PROFILE_URL` set to `HederaDemo_1`'s profile. Expected on the mirror node: `"memo": "hcs-11:https://www.novicorpus.com/backend/metadata/<HederaDemo_1 publicId>/profile"`. (The URL answers 404 until task 16's second deploy; that is expected on Sunday morning and checked again in task 16.)
- [ ] **Step 3:** README paragraph "Resolving a Novi Corpus company from Hedera" (D23, the three hops, and which resolvers follow an HTTPS memo). `superpowers:requesting-code-review` on the branch. **Commit** → `feat(hedera-client): provision sets the HCS-11 memo; docs for resolution (task 12)`. **Merge step (ends phase 2):** push, `gh pr create` with title "feat(hedera): portable identity, ERC-8004 on Hedera, UAID, HCS-11 profile (PR 2 of 3)", reviewer Martin, then D29 (24 hours, CI green, Alex's diff read, `gh pr merge --merge --delete-branch`), then `git checkout -b feat/hedera-attest origin/hedera`.

---

## Phase 3 — Pull request 3: the signed attestation and the demo (branch `feat/hedera-attest`)

**Must already be on `hedera`:** pull requests 1 and 2 merged with `--merge` and deployed to the VPS by Martin from `hedera` (task 16); `HederaDemo_1` linked on prod (task 16 step 1) and both demo entities registered with UAIDs (task 10); `NOVI_ATTESTATION_KEY` and `Demo Guardian Key` in 1Password (task 0). Branch: `feat/hedera-attest` from `origin/hedera`; PR base `hedera`.
**Ends with:** task 15's merge step. Under D27, task 13 is dropped and task 15 runs the five legs against the unsigned `/verify`; the video shows that. Task order inside this phase: 13, 14, 16 (the deploys, if not already done on Sunday), 15.

### Task 13: EIP-712 signature on `/verify`

**Files:**
- Modify: `src/hedera/attestation.ts` (add `signAttestation`), `src/api/routes/verify.ts` (sign when `cfg.attestationKey` is set), `src/api/routes/metadata.ts` (add `attestor` address to the `hedera` block)
- Test: extend `test/api/verify.route.test.ts`, add `test/hedera/attestation.test.ts`

**Interfaces:** Produces `ATTESTATION_DOMAIN = { name: "Novi Corpus Attestation", version: "1" } as const`, `ATTESTATION_TYPES` (one primary type `LegalBodyAttestation` whose fields are the flattened body: `publicId string, agentId string, treasury address, uaid string, standing string, formationStatus string, formationEnvironment string, humanVerified bool, oaHash bytes32, manifestVersion uint256, issuedAt uint256, expiresAt uint256`), `signAttestation(body, key): Promise<{ attestor: Address; signature: Hex }>`, `verifyAttestation(body, attestor, signature): Promise<boolean>`.

- [ ] **Step 1: Failing test:** sign with `privateKeyToAccount(key).signTypedData`, verify with viem `verifyTypedData` → true; flip `standing` → false; `verifyAttestation` on the body a test route call returned → true.
- [ ] **Step 2:** Implement; the route adds `attestor` and `signature` when the key is present, and `issuedAt`/`expiresAt` are serialised as unix seconds strings in the typed data and ISO strings in the JSON body (state both in the body: `issuedAt`, `issuedAtUnix`, `expiresAt`, `expiresAtUnix`). Null mapping into the typed data, applied identically by `signAttestation` and `verifyAttestation` and stated in the README (design Component 3, audit C12): `oaHash null` → `0x` + 64 zeros, `manifestVersion null` → `0`, `uaid null` → `""`, `agentId null` → `""`. Add one test: a body with all four null signs and verifies, and flipping `oaHash` from the zero sentinel to any other value fails verification.
- [ ] **Step 3:** Tests; three checks; **commit** → `feat(hedera): EIP-712-signed legal-standing attestation on /verify (task 13)`.

### Task 14: The guardian pause script (D22)

**Files:** Create `scripts/guardian-pause.mts`; Test: `test/hedera/guardianPause.test.ts` for the pure address check.

- [ ] **Step 1:** Script `pause|unpause --entity <name|key> | --treasury <address>`: `loadConfig()`, find the entity in the local database or take the treasury address as given (under D28 the demo entity lives on prod, so the demo uses `--treasury`), read `guardian()` from the treasury with `publicClientFor(cfg)` and `agentTreasuryAbi` (`src/abis/generated.ts:8`), refuse unless `privateKeyToAccount(process.env.DEMO_GUARDIAN_KEY).address` equals it (`guardian key does not match on-chain guardian`), then `walletClientForKey(cfg, key).writeContract({ address: treasury, abi: agentTreasuryAbi, functionName: mode })` and wait for the receipt; print `paused()` after.
- [ ] **Step 2: LIVE round trip:** `op run --env-file=.env.guardian.tpl -- npx tsx scripts/guardian-pause.mts pause --treasury <HederaDemo_1 treasury>` (the paying entity, whose guardian key is `Demo Guardian Key`; `FormationE2E_1`'s guardian is Martin's, and the buyer's refusal comes from `check_policy` on the payer, D18, audit B1) → `paused: true`; `check_policy` over prod MCP for `HederaDemo_1` (PR 1 is deployed by then, task 16 step 1) → `{ ok: false, reason: "paused" }`; `unpause` → `paused: false`. Record both hashes.
- [ ] **Step 3:** **Commit** → `feat(hedera): guardian pause/unpause script for the demo (task 14)`.

### Task 15: The demo buyer and the definition of done

**Files:** `back/hedera-client/src/commands/demo-buyer.ts`, `back/backend/README.md` (demo section), `back/docs/runbooks/hedera-demo.md` (new), `back/docs/README.md` (index), Records.

- [ ] **Step 1:** `demo-buyer <uaid>`: `parseUaidNativeId` → `GET https://www.novicorpus.com/backend/legal-bodies/<address>` (the base comes from `NOVI_API_BASE`, prod for the demo, D28) → follow `links.metadata` → read `hedera.profileUrl` and `hedera.verifyUrl` → `payFetchFor(...)` on `verifyUrl` → print `standing`, `humanVerified`, `attestor`, and `verifyAttestation(...)` result, plus the HashScan link. `NOVI_MCP_URL` and `NOVI_API_KEY` in `.env.tpl` point at prod and the prod key (task 16).
- [ ] **Step 2: LIVE against prod, the five legs, recorded in order:**
  1. `demo-buyer uaid:aid:…` (`FormationE2E_1`'s UAID) → `HTTP 200 … signature valid: true … settlement OK <hashscan>`.
  2. `guardian-pause.mts pause --entity HederaDemo_1` → `paused: true`.
  3. `demo-buyer` again → `policy denied: paused` and **no** HashScan link.
  4. `guardian-pause.mts unpause --entity HederaDemo_1`, then `revoke` (guardian rotates the agent key out) → `SUCCESS`.
  5. `demo-buyer` again → `HTTP 402`, `PAYMENT-RESPONSE … transaction_failed`, HashScan shows `CRYPTOTRANSFER INVALID_SIGNATURE` under the facilitator's account.
  **Do not call this done if** any leg differs from its expected line. Record all five with transaction ids and a screen capture each.
- [ ] **Step 3:** README demo section with the five commands and expected lines; `docs/runbooks/hedera-demo.md` (the five legs, the prod URLs, the 1Password item titles, the D28 fallback, which resolvers follow the memo; audit U6); add both Hedera docs and the runbook to `docs/README.md` (audit U8). `superpowers:requesting-code-review` on the branch. **Commit** → `feat(hedera-client): demo buyer; live five-leg run recorded; demo runbook (task 15)`. **Merge step (ends phase 3):** push, `gh pr create` with title "feat(hedera): signed /verify attestation, guardian script, demo buyer (PR 3 of 3)", reviewer Martin, then D29. The continuity README and the video follow on `main`, outside this plan.

---

## Phase 4 — Required deploys, and the swappable task

### Task 16 (required, Sunday 2026-09-14, before task 15): PR 1 and PR 2 on the VPS, deployed by Martin from `hedera` (D28, D29)
Martin runs the box on the `hedera` branch (his answer of 2026-09-11); Alex hands him the values and checks the result. Env changes follow `docs/runbooks/doola-deploy.md`.
- [ ] **Step 1: PR 1 deploy.** Alex sends Martin the server-row `HEDERA_*` values from the naming table (all public constants) in the PR 1 description; Martin adds them to the VPS `.env`, checks out `hedera`, restarts. Expected: `curl -sI https://www.novicorpus.com/backend/verify/9f8003f5-4c70-435a-9980-9a54625691b7 | head -1` → `HTTP/2 402` and the response carries a `PAYMENT-REQUIRED` header. Then Alex mints the prod demo API key for `HederaDemo_1`'s tenant through `/api-keys` and updates the 1Password item `Novi Corpus Demo API Key` (field `prod`); `link` from the client against `NOVI_MCP_URL=https://www.novicorpus.com/backend/mcp`. Expected: `{"ok":true,...}` and the mirror node shows the float account's 1-of-2 list.
- [ ] **Step 2: PR 2 deploy.** Martin restarts on the new build; on the box he runs the two `--record` lines Alex puts in the PR 2 description (`npx tsx scripts/hedera-register-identity.mts --record --entity … --agent-id … --tx … --uaid …`, no key needed). Expected: `curl -s https://www.novicorpus.com/backend/metadata/9f8003f5-…` shows two `registrations[]` entries and a `uaid`; `curl -s https://www.novicorpus.com/backend/metadata/<HederaDemo_1 publicId>/profile` → 200 with `uaid`; the mirror node's memo on the float account points at that profile URL.
- [ ] **Step 3: PR 3 deploy (Monday, before leg 1).** `NOVI_ATTESTATION_KEY` reaches the VPS `.env` from 1Password by Martin over SSH (Alex shares the item to him in 1Password, never through chat); restart. Expected: a paid `/verify` answer carries `attestor` and `signature`, and the boot dump shows `attestationKey: 'REDACTED'`.
**Do not run task 15 against prod if** any expected line above differs; apply the D28 fallback instead and say so in Records.

### Task 17 (swappable, only if the team picks a server-side custody): the `rawSign` adapter
Add `hedera:testnet` to `EntityPaymentService.pay` as a branch that builds `custodyAgnosticSigner` (moved from the client into `src/hedera/signer.ts`) with `rawSign` bound to Turnkey raw-payload signing (`adapters/turnkey`) or a KMS; provisioning moves to `workflow/onboarding.ts:254` beside the Circle branch; `link_hedera_account` becomes a no-op. Everything else in this plan stands.

---

## Self-review

- **Spec coverage.** Goal 1 → tasks 1 to 8. Goal 2 → tasks 9 to 12. Goal 3 → tasks 13 to 15. D5 → task 2 and 3. D6 → task 2. D8, D14, D15 → task 5. D9 → tasks 6 and 13. D10 → task 9. D11 → tasks 11 and 12. D13, D16 → task 5. D17, D18 → task 15 and task 0. D19 → task 10. D20, D29 → tasks 8, 12, 15. D21 → superseded by D28. D22 → task 14. D23 → task 15 and README. D24 → tasks 4 and 5. D25 → task 6 in PR 1. D26 → task 0 step 6. D27 → the executor applies it on Saturday morning: skip task 12's inscription upgrade and task 13, keep task 15 against the unsigned body. D28 → task 0 steps 0 and 9, task 8 step 1, task 16, task 15. Components 1 to 7 map to tasks 2, 3, 6, 5, 9 to 11, 14, 7. Files-touched baseline is the File structure above. The 2026-09-10 audit's findings are traced in the design's last section; every plan change carries its finding id inline.
- **Placeholders.** Every code step shows code or an exact command and expected line. The facts the v3 plan could not verify (402 field names and where they travel, whether the client abort throws, the HCS-11 memo form, the operator alias) are now pre-cleared in the design. The one remaining fallback is the key-list update order on a hollow account in task 7 step 6.
- **Type consistency.** `HederaMirror`, `decodeHederaKey`, `DecodedKey` and the five vectors (task 4) are what task 5 imports; `recordSettledOnNetwork`, `recordFailedOnNetwork`, `setHederaLink`, `setHederaIdentity` (task 3, with the failed variant added in task 5) are the names the tools call; `HederaDeps` with `spendAllowlistThreshold` (task 5) is what `verify.ts` reads as `deps.hedera`; `createClientLimiter` and `sharedReadBudget` (task 6) are the two `legalBodies.ts` exports; `HEDERA_IDENTITY_REGISTRY` (task 10) is what task 11 imports; `buildAttestation`/`AttestationBody` (task 6) is what task 13 signs and task 15 verifies; `uaidInputsFor`, `deriveUaid`, `parseUaidNativeId` (task 9) are what tasks 10, 11 and 15 call; `payFetchFor`, `createNoviClient`, `custodyAgnosticSigner`, `localRawSigner` (task 7) are what tasks 8, 12 and 15 use.

## Records

_(appended by the executor as tasks complete: baseline test count, demo entity treasury and guardian, transaction ids per live step, golden UAID vector, the HCS-11 answer)_

## Execution handoff

Plan complete and saved to `back/docs/plans/2026-09-10-hedera-rail.md`. Two execution options:

1. **Subagent-driven (recommended):** a fresh subagent per task, coordinator review between tasks, Alex reads every diff before a push.
2. **Inline execution:** tasks executed in this session with checkpoints.
