# Implementation plan: the legal-body check (design 2026-09-10)

Branch `feat/legal-body-check` from main. Backend only. TDD per task, Opus implementer per task,
Opus reviewer per task, controller rulings in the SDD ledger. Commit subjects given per task.

## Task 1 — `resolveLegalBody` and the repository lookup by payer
Files: `src/payments/legalBody.ts` (new), `src/persistence/entityRepository.ts` (+`findByPocketAddress`),
`src/payments/sellerTrust.ts` (refactor `verifyLegalBody` onto the resolver), `src/api/main.ts`
(build the resolver deps once: repo, `legalStatus`, `treasuryPaused` — the same three the buyer dial
uses), tests `test/payments/legalBody.test.ts`, `test/persistence/entityRepository.test.ts`
(+pocket lookup), existing `test/payments/sellerTrust.test.ts` unchanged and green.
Rules: D1, D2, D8. `findByPocketAddress` matches case-insensitively (`COLLATE NOCASE`; stored
pockets are not uniformly lowercased). Only public on-chain entities resolve to `body`, by the
`listPublicOnChain` rule verbatim — `proxy` and `treasury` set, status ∈ {`created`, `bound`,
`funded`} — so `failed` is excluded (amended from "`status` ≥ `created`"; ledger ruling T1-R2).
Commit: `feat(legal-body): one resolver for "a Novi legal body in good standing", keyed by payer or treasury`.

## Task 2 — public lookup `GET /legal-bodies/:address`
Files: `src/api/routes/legalBodies.ts` (new), `src/api/app.ts` (mount + CORS `*` + public list),
`src/api/main.ts` (deps: resolver, formation summary, links base url, `TokenBucket(30,1)`),
tests `test/api/legalBodies.test.ts`.
Rules: D3, D7, D8. Response exactly as the design; 400 on a bad address; the 15 s memo holds
definitive answers only; `network` from the entity's chain config as the AgentBook status route does.
Commit: `feat(legal-body): public lookup, rate-limited, answers only what the chain says`.

## Task 3 — seller policy `legal-bodies-only` and the demo routes
Files: `src/config/env.ts` (enum value), `src/payments/seller.ts` (branch + refusal shape + header),
`src/api/routes/x402Demo.ts` (`legal-bodies-wall` pinned policy, `legal-bodies-run` two legs),
tests: the real files are `test/world/sellerGate.test.ts` (+11 policy cases),
`test/api/x402Demo.route.test.ts` (+4 run legs) and `test/config/x402Demo.test.ts` (+1, pinning the
three-value enum) — not the `test/payments/` and `test/api/x402Demo.test.ts` paths named above.
Rules: D4, D5, D7, D8. The existing `accountable-only` behaviour and the configured prod wall are
untouched; the pinned wall ignores `X402_TRUST_POLICY`.
Commit: `feat(x402): legal-bodies-only seller policy, a pinned demo wall and the two refusal legs`.

## Task 4 — the drop-in checker and the integration doc
Files: `src/payments/legalBodyAgentBook.ts` (new, no backend imports), `test/payments/legalBodyAgentBook.test.ts`
(fake `fetch` + fake agentBook: both yes → id; human no → null; body inactive/unknown/404/network
error → null), `back/docs/integrations/agentkit-legal-body-check.md` (verify the hooks factory name
against `node_modules/@worldcoin/agentkit-core`; show the swap, the lookup contract, D7 wording, the
spoofing note from §4).
Commit: `feat(legal-body): a copy-ready AgentKit checker that asks both questions, and how to plug it in`.

## Task 5 — runbook and the deploy note
Files: `back/docs/runbooks/legal-body-check.md` (curl legs for §6 acceptance, the pinned demo urls,
what to record for the video), plus the design §8 corrections, these plan amendments and one
paragraph in the integration doc. `.env.example` landed with Task 3, not here. No env change is
needed on the box: the pinned wall carries its own policy.
Commit: `docs(legal-body): runbook, acceptance legs, deploy note`.

## Verification (CI-exact, every task)
`cd back/backend && npm run lint && npm run typecheck && npx vitest run`.

## Deferred
- **T1-R3** — delete the legacy narrow `legalBodies` deps path in `sellerTrust.ts` (production-dead
  once main.ts hands over the resolver) and retarget its 9 tests onto the resolver. Kept out of this
  PR to keep it focused.
- **T2-R7** — the lookup's `network` reads `agentBook.network` in `main.ts`; it should read
  `cfg.arcNetwork ?? "testnet"` directly. The value is correct today (both derive from the same
  config); the risk is a future redefinition of AgentBook's World Chain `network` field.
- npm publish of the checker; interface surfaces; the World-side attestation slot (feedback doc).
