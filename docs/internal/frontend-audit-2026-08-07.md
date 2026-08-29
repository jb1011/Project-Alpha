# Frontend audit — 2026-08-07

Scope: `interface/` (Next.js app) diffed against backend ground truth at HEAD `7efc1b4`; custody-related items re-checked after the Tier-0 P4 merge (`ceed8d5`, #80) landed the same day.
Goal: mainnet-ready, information-pure. **UI / artistic direction / color system explicitly out of scope — nothing here proposes visual changes.**

Context: landing components date from **June 23 – July 2**; the backend has since absorbed the S1–S5 security series, v2.5 batch 1 (trust dial, passkey credentialId), and the entire Tier-0 P1a–P1d custody stack + P2 live experiment. Only onboarding got a frontend update (Aug 5, custody selector). `back/docs/FRONTEND_INTEGRATION.md` (2026-06-22) is historical — do not use as spec.

---

## P0 — False or fabricated claims (truthfulness; fix first)

These are statements the product makes that are contradicted by the shipped code or are pure invention.

| # | Claim | Where | Reality |
|---|---|---|---|
| 1 | **"Live on Arc"** + pulsing live-dot | `interface/src/components/landing/Hero.tsx:18` | **DECISION (2026-08-07, user): keep as-is** — mainnet-ready posture, mainnet coming soon. Remaining task: resolve the internal contradiction with `Footer.tsx:96` ("Arc testnet · Simulation") and the onboarding chip ("Arc testnet") — pick one consistent line for product surfaces (e.g. "Mainnet coming soon") so the landing claim and the in-product disclosures don't fight each other. |
| 2 | **Fabricated stats**: "842 agents live", "$18.4M treasury volume", "12,400+ policy actions", "~8 min avg setup" | `Stats.tsx:3-21` | Hardcoded literals, no data source. Replace with real figures (backend has entities/jobs/runs counts), reframe as capability facts, or drop the section. |
| 3 | **Fabricated testimonial**: pull-quote by "Lena Whitfield, Co-founder · Novi Corpus" | `Wyoming.tsx:56-71` | Invented person. Remove or replace with a real attributable quote. |
| 4 | **"We can never move your keys or funds"** / "Non-custodial by design" absolutism | `Features.tsx:13-17`, `AgentCTA.tsx:20,56`, `Footer.tsx:52-55`, `HowItWorks.tsx:8` | Circle "Novi-managed" custody (platform holds operator hot keys in Circle MPC) is not just an option — since P4 (#80) it is the **recommended default** in the wizard. Also treasury funding is backend/platform-wallet-initiated (`FundStep.tsx:79-91`). Landing must reflect the custody *choice*, with Novi-managed as the default path. |
| 5 | **"Rules… enforced on-chain, not in software"** | `Features.tsx:18-23` | Per-tx cap, allowlist-threshold, trust dial are software-enforced by the payment authority; the dashboard says so honestly (`AgentDashboard.tsx:388-394`: "not guaranteed if the backend is compromised"; `AgentSettings.tsx:296-297`). Landing should mirror the dashboard's honest two-tier framing: on-chain period cap = hard backstop, software gate re-checked against fresh on-chain state. |
| 6 | **"Two signatures total"** / "You sign only twice" | `AgentCTA.tsx:26-30`, `onboarding/Stepper.tsx:78-79` | Actual: SIWE sign-in + passkey ceremony + one guardian tx **per allowlist address** (`DeployStep.tsx:260-264`), and funding needs **no** user signature (backend-funded). |
| 7 | **"Six steps from passkey to live agent"** | `HowItWorks.tsx:70-79`, `AgentCTA.tsx:46` | Wizard has **7** steps (`onboarding/types.ts:55-64`; "Step n of 7"). HowItWorks is missing the two new steps (Accountable human / World ID, Key custody) and still describes the old flow. |
| 8 | **Step 04 "You sign the transfer yourself — Novi Corpus can never move your funds"** | `HowItWorks.tsx:35` | `FundStep.tsx:79-91`: "The backend transfers USDC from the platform wallet…". Direct contradiction. |
| 9 | **"Testnet faucet available"** | `HowItWorks.tsx:36` | No faucet exists anywhere in the UI or backend. |
| 10 | **"Recover the full treasury back to your wallet"** | `Features.tsx:36-41` | Emergency withdraw sweeps to the **payout address**, not the guardian wallet (`AgentSettings.tsx:217,403`). |
| 11 | **Fake MCP connection in onboarding**: "connected · live validation", endpoint `mcp.novicorpus.xyz/agent-policy`, "Schema-valid" badge, "Simulate agent proposal" applying a canned `SAMPLE_PROPOSAL` ("Atlas Treasury Bot", two fake allowlist addresses) | `ConfigureStep.tsx:35-46,389-398,420,457` | **DECISION (2026-08-07, user): point the frontend at the real MCP onboarding flow.** The backend has one live: `POST /bootstrap-connection` (tenant-wide key + 15-min link code) → agent calls `claim_connection` → `onboard_agent` with `passkeyId` → poll `get_entity`; `/agents/connect` (`BootstrapAgent.tsx`) already drives it. Rework the wizard's "agent self-config" mode to hand off to / embed that flow (real link code, real MCP URL from the server, real `GET /schema/agent-spec.json` validation via the never-called `fetchAgentSchema`), and delete `SAMPLE_PROPOSAL` + the simulated status strings. |
| 12 | **Fake terminal transcripts** with invented numbers: "Caps $500/tx · $2,500/day · 12h timelock", fake OA hash `0x7d3a…f8c2`, "Treasury funded · 1,000.00 USDC", "agent connected to mcp.novicorpus.xyz" | `Hero.tsx:85-128`, `CLIShowcase.tsx:96-134` | Fine as illustrative *if* framed as example output and consistent with real defaults/limits (backend: MAX_TREASURY_FUND 25 USDC/call, 100/tenant — "1,000.00 USDC funded" is impossible). "Turnkey vault provisioned" (`Hero.tsx:88`) is only one of two custody paths now. |

## P1 — Backend truth the frontend doesn't tell (feature drift)

1. **Custody choice is invisible on the landing page.** P1d shipped a full custody selector (`CustodyStep.tsx`) and dashboard badge (`AgentDashboard.tsx:191-202`), but every landing mention is Turnkey-only ("Turnkey vault", `Hero.tsx:88`, `Features.tsx:13-17`, `HowItWorks.tsx:8`). Landing should present the two-path story: **Novi-managed (Circle MPC smart account, gasless) — the recommended default since Tier-0 P4 (#80, 2026-08-07)** — vs Passkey-rooted (Turnkey, sovereign). P4 also added public `GET /config` (`walletProviderDefault`, `circleCustodyAvailable`), which the custody step already probes to disable the Novi-managed card on deployments that can't serve it; "Early access" copy is retired. The Hero terminal's "Turnkey vault provisioned" line is therefore doubly stale — it names the *non-default* path.
2. **The real MCP story is shipped but unsold.** Landing sells the *simulated* self-config demo, while the actual differentiator — connect Claude Code/Cursor/11 clients via `/agents/connect`, capability ladder read<earn<spend<provision, `claim_connection` → `onboard_agent` bootstrap, per-entity scoped keys — is live and never mentioned on the landing page.
3. **Landing omits shipped features entirely**: World ID accountable-human step (Wyoming natural-person requirement — a strong narrative), ENS agent names (`<publicId>.novicorpus.eth`, ENSIP-25 bidirectional), ERC-8183 jobs + reputation, x402 payments + buyer trust dial, the standing-float ceiling / S2 story.
3b. **`/proof` page — DECISION (2026-08-07, user): retire from production; replace with an explainer.** `/proof` is a hackathon-pitch surface (flag-gated `x402-demo/proof-run`; backend docs mark the seller-side "accountable-only" policy demo-only). Retiring it loses only the showcase, not the capability — the agentkit wrapper fronts every real x402 buy, and AgentBook reads power the production trust dial and the dashboard "human-backed" chip. Replace with a customer-facing **"How proof of personhood works"** page: World ID verification at onboarding, the nullifier model (what we store / never store), AgentBook human-backing on payments, guardian accountability chain. See also the World/Doola content section below.
4. **Standing exposure under-rendered**: backend returns `standing{operatorEoa, pocketEoa, gateway, total, ceiling}`; dashboard reads only `.ceiling` (`AgentDashboard.tsx:129`). The number the ceiling exists to bound (`total`) is never shown. Both `standing` and `legalActive` are nullable (degraded reads) — render "—", never 0.
5. **No UI for the Circle funding bridge**: `POST /entities/:id/fund-pocket` (bridge_legs saga, real tx hashes) is MCP-only; design doc notes no interface renderer exists. At minimum the dashboard could show pocket/float state.
6. **`rootPasskeyId` (v2.5 #67) has no UI consumer** — guardian passkey recorded at birth, emitted on every `EntityView`, never displayed (natural fit: agent settings / account page).
7. **AgentBook `reason` field dropped**: backend distinguishes `not registered` vs `no-operator-yet`; frontend type omits `reason` (`client.ts:265`), so a still-provisioning agent shows as unregistered.
8. **`spendingPeriod: "24h"` hardcoded** in `lib/api/spec.ts:39` while `AgentSettings` allows arbitrary periods → generated operating agreement silently diverges from live policy. Either expose period in the wizard or derive agreement text from live state.
9. **Passkey copy is mostly fixed but check path-awareness**: `WelcomeStep` already reframed the passkey as guardian anchor + "root-capable" (good); `HowItWorks` step 00 still says the passkey creates the key vault unconditionally.
10. **Trust dial**: settings UI has all three tiers (good). Landing/marketing never mentions it; also seller-side "accountable-only" is demo-only per backend docs — don't market it as production.

## P1b — Partner-stack content: World and Doola (user-requested, 2026-08-07)

The user wants the frontend to talk more about **World** and **Doola** and how their stacks are used.

**World — everything below is shipped and can be described truthfully today:**
- **World ID proof of personhood** at onboarding (`GuardianStep`): Wyoming DAO LLC needs a natural person; one unique human per account, sybil-resistant (nullifier stored, never name/document/face). Orb or NFC-passport credential.
- **Identity Check age step-up** (`/guardian` page): document-grade "over 18" attestation for formation-readiness — we learn exactly one extra bit.
- **AgentBook (World Chain)**: live "does a verified human answer for this wallet" reads — powers the buyer trust dial tier "verified sellers only" and the dashboard "human-backed" chip.
- **World agentkit**: fronts every real x402 buy so sellers can see an accountable buyer.
- Placement: the new proof-of-personhood explainer page (replacing `/proof`) is the natural home for the deep dive; the landing needs at least a section/mention. Note the frontend already links `world.org/world-id` and support articles — reuse that tone.

**Doola — no code or copy exists anywhere in the repo yet.** Doola outreach is an active mainnet-readiness track (formation/compliance partner for the Wyoming LLC filings). Frontend content is **blocked on partnership status**: what Doola will actually do (filing, registered agent, annual reports?) must come from the user before any copy is written. Placeholder-free rule applies — don't invent the integration. Candidate placements once real: HowItWorks step 02 (operating agreement/formation), Wyoming section, and the (currently dead) footer links if a formation/legal page is built.

## P2 — Mainnet-readiness config (env hygiene)

The backend itself is **testnet-only** (chain hardcoded 5042002, Circle enum `ARC-TESTNET`; mainnet lands in Tier-0 P4) — so true "mainnet ready" for the frontend means *parametrized and env-clean*, not switched.

- `interface/src/app/backend/[[...path]]/route.ts:5` — proxy fallback **`http://159.223.137.183:8789`**: plaintext HTTP to a bare IP baked into source; every browser request incl. `Authorization: Bearer <JWT>` traverses it. Must come from env, https, and fail loudly if unset in production.
- `lib/api/config.ts:3` — `SIWE_DOMAIN` defaults to `localhost`; unset in prod ⇒ **every login fails** (backend verifies domain).
- `lib/api/config.ts:5-7` — `NEXT_PUBLIC_MANAGER_ADDRESS` is **dead**: backend force-overwrites `roles.manager`/`roles.guardian` (`onboard.ts`). Remove the env + the field from the submitted spec.
- `app/layout.tsx:16` — `metadataBase: "https://novicorpus.example"` placeholder domain in OG metadata.
- Testnet hardcodes needing env-parametrization: chain id/RPC/explorer defaults (`lib/chain.ts`), non-overridable wagmi fallback RPC `arc-testnet.drpc.org` (`Web3Provider.tsx:16`), `sepolia.app.ens.domains` link (`AgentDashboard.tsx:261`), `.novicorpus.eth` suffix hardcoded (`AgentDashboard.tsx:541` — backend derives from `ENS_PARENT_NAME`; can diverge), Sepolia-first ENS fallback commented "for the hackathon" (`lib/ens.ts:8-10`).
- No `.env`/`.env.local` exists in `interface/` — every default above is currently live.
- Client-side constants that should be server-driven: 15-min link-code TTL (`BootstrapAgent.tsx:17-20`), age fallback `18` (`GuardianRecord.tsx:173`, `TenantRecord.tsx:106`), period floor 3600s (`AgentSettings.tsx:143`).
- Overriding `NEXT_PUBLIC_API_URL` to an absolute backend URL bypasses the proxy and breaks on CORS (backend allows only `authorization`/`content-type`; the proxy forwards `x-payment`/`agentkit`/`mcp-*`). Keep the proxy pattern.

## P3 — Dead links, dead code, unused surface

- **Dead anchors**: `#docs` ×4 (Nav, CLIShowcase, Footer ×2 — "MCP docs" button included), Footer `#status`, `#about`, `#manifesto`, `#customers`, `#careers`, `#press`, `#legal`, `#privacy`, `#terms`, `#compliance`, Pricing `#contact`. Three social icons `href="#"`. `Features.tsx:92-100` "Learn more →" is a `<div>` on all six cards. Decide: build the pages, point at real destinations, or remove the links.
- **Dead components**: `landing/Pricing.tsx` (182 lines, unrendered — asserts invented "$299 formation / $99 yr" pricing; decide keep-or-kill), `onboarding/steps/DashboardStep.tsx` (unimported).
- **Dead API client fns**: `healthCheck`, `fetchAgentSchema`, `worldIdRequest`, `worldIdStatus`, `getJob` (`lib/api/client.ts:62,142,241,252,257`). `fetchAgentSchema` should be *used* (see P0-11); the World headless pair matches a real backend flow but the browser uses IDKit — delete or wire.
- **Backend routes with no UI**: `POST /api-keys` (keys only mintable via connection/bootstrap), `POST /entities/:id/jobs` ("jobs are created outside the dashboard" — intentional?), `GET /metadata/:publicId` (never fetched; dashboard string-parses `metadataURI` instead).
- Type drift (harmless today): `walletProvider`/`rootPasskeyId` required in backend views, optional in FE `types.ts`; `JobView.ownerTenantId` missing; `worldIdAttestVerify` typed `unknown` though backend returns `{status, minAge, credential}`.
- Local-storage fallbacks can render stale as live: dashboard cap/per-tx fall back to persisted onboarding config (`AgentDashboard.tsx:118-125`); allowlist row reads client `config`, not chain (`:378-385`) while Settings does read on-chain.
- `JobsReputationCard.tsx:41` polls every 5s with no visibility gating (dashboard poll is gated — v2.5 item 3).

## Suggested sequencing

1. **Truth pass (P0)** — pure copy edits + removing fabrications; no layout change. "Live on Arc" stays (decision above); align footer/onboarding chips with the mainnet-coming-soon line. One PR.
2. **Landing feature-parity rewrite (P1 1–3 + P1b World section)** — same sections/visual system, new content: custody choice, real MCP story, World ID/ENS/jobs/trust-dial. One PR.
3. **Real MCP self-config in the wizard (P0-11 decision)** — replace the simulation with the live bootstrap-connection / claim_connection / onboard_agent flow + real schema validation. One PR.
4. **Proof-of-personhood explainer page** — retire `/proof` from production nav/links, ship the customer-facing explainer (World deep-dive lives here). One PR.
5. **Data honesty (P1 4–8)** — standing total, agentbook reason, period field. One PR.
6. **Env hygiene (P2)** — env-var sweep + prod fail-loudly. One PR; unblocks real mainnet flip when backend P4 lands.
7. **Cleanup (P3)** — dead links/code decisions (needs user call on Pricing + footer pages).
8. **Doola content** — blocked on partnership status; write only what's real.

## Decisions log

- 2026-08-07: keep "Live on Arc" (mainnet-ready posture); wizard MCP mode → real backend MCP onboarding; retire `/proof`, replace with proof-of-personhood explainer; expand World + Doola storytelling (Doola blocked on partnership facts).
