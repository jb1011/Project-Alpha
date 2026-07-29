# World Deepening — spec 3 (W9: accountable-only commerce)

Continues spec-world-2 (W7 attestation + W8 no-World-ID path, both shipped). Decision locked
with the user 2026-07-25 night: **the seller refuses to trade with agents no one answers for.**
Not a discount, not a free tier — World's track rules explicitly ban discount/free-trial framing,
and our own reference docs flagged that in week one. The framing is *authorization*: accountability
is a precondition of commerce; payment is still always required.

> The line: a company doesn't take money from a counterparty it can't identify. Neither do our
> agents. World proves someone answers for the buyer; Novi Corpus is how you hold them to it.

## Verified facts (fresh greps, 2026-07-25)

- `buildPaywall` (`seller.ts:112`) currently: AgentKit header present+valid → **served free**
  within allowance → else falls through to x402 payment. The free-serve branch is the part strict
  mode removes.
- `verifyAgentkitRequest` returns disjoint failure reasons we can map cleanly:
  `invalid-message:* | invalid-signature:*` and `not-human-backed` → refusal;
  `allowance-exhausted` (carries `humanId`, `used`) → rate; `authorized` → proceed. **No changes
  needed to this function.**
- **`tryIncrementUsage` is a LIFETIME counter** (`worldStore.ts:254`) — per (humanId, resource),
  no window. As a "rate cap" it would eventually 429 every human forever. W9.1 adds a window.
- Demo-seller AgentKit config is assembled at `main.ts:118` (`x402Demo.agentkit = {…}`) — the
  natural place to thread a policy flag from env.
- Nonce replay protection (SQLite single-use) and positive-only AgentBook caching are already in
  place and unchanged.
- The registered AgentBook wallet today is operator `0x6652…E51A` (Turnkey — we cannot export its
  key). `world-demo.mts` works around this by pre-caching the humanId for a stand-in key. **A
  live, fully-real demo needs one wallet we can sign with that is actually registered** → W9.0.

## Locked decisions

1. **Per-seller trust policy, not a global rewrite:** `trustPolicy: "open" | "accountable-only"`
   on `PaywallConfig`; env `X402_TRUST_POLICY` (default `open`) threaded at `main.ts:118`.
   `open` = today's behavior, byte-identical. The policy itself is product surface: a legal body
   chooses whom it trades with.
2. **Strict refusal is 403, never 402.** 402 means "pay me" — payment will not help an anonymous
   bot, and lying in a status code is bad agentic UX. The 403 body is a doorway, not a wall:
   ```json
   { "error": "human_backing_required",
     "detail": "this seller trades only with agents a verified human answers for",
     "how": { "register": "npx @worldcoin/agentkit-cli register <your-address>",
              "agentBook": "0xA23a…44dA", "chain": "world-chain" },
     "extensions": { "agentkit": { …the standard challenge… } } }
   ```
   (Challenge included so a capable agent can discover the proof format from the refusal itself.)
3. **Everyone pays.** In strict mode a valid human-backed proof unlocks the *right to buy* —
   flow continues into the normal x402 402→X-PAYMENT→serve path. The free-serve branch does not
   exist under `accountable-only`. Purest message, zero discount-framing exposure.
4. **Allowance → windowed per-human rate cap.** Over the cap → **429** (with `Retry-After` when
   computable), reason `rate-capped`. New env `WORLD_RATE_WINDOW_HOURS` (default 24). Windowing
   applies in BOTH modes (a reset can only ever grant more than today's lifetime counter, never
   less — safe for the existing W6 demo). One human backing fifty agents still gets one budget:
   the sybil property survives without any free service.
5. **Proof page runs without settlement by default.** The free legs (403 vs 402-challenge) prove
   the policy; the paid leg costs real testnet USDC per click, so it is opt-in and auth-gated.

## Tasks

### W9.0 — Register a demo signing key (USER, ~5 min, unblocks "fully real")
Generate a fresh keypair (I do), user runs `npx @worldcoin/agentkit-cli register <address>` and
scans once. Key goes in `.env` as `X402_PROOF_AGENT_KEY` (signs AgentKit messages only, holds no
funds; prod copy piped over ssh as usual, never rendered). Registration is permanent — AgentBook
has no revoke — so this key IS the demo asset for the booth. Verify with `lookupHuman` ≠ 0 before
building on it. (CLI relay was healthy 2026-07-25; if it 500s again, fall back to the stand-in
key pattern and LABEL the leg staged — never quietly.)

### W9.1 — Seller trust policy (backend, ~60–75 min)
- `env.ts`: `X402_TRUST_POLICY` enum default `open`; `WORLD_RATE_WINDOW_HOURS` int default 24.
- `worldStore.tryIncrementUsage`: read `updated_at`; if older than the window, reset the counter
  (`used = 1`, not `used + 1`). Return `{allowed, used, resetAt?}` so 429 can carry `Retry-After`.
- `seller.ts` strict branch, mapping `verifyAgentkitRequest` outcomes:
  - no header / `invalid-*` / `not-human-backed` → **403** per decision 2;
  - `allowance-exhausted` → **429** `rate-capped` (+ humanId headers);
  - `authorized` → set `X-AGENTKIT-HUMAN` + `X-AGENTKIT-AUTHORIZATION` and **fall through to the
    x402 payment path** (no free serve). Paid 200s keep the headers + `humanBacked: true` so the
    accountability is visible on the receipt.
  - `open` mode: no behavioral change (tests must prove this).
- Tests (extend `test/world/sellerGate.test.ts`): strict-bot-403 body shape (has `how` +
  `extensions.agentkit`), strict-registered-no-payment-402, strict-registered-paid-200 (mock
  settle), rate-cap-429 + window reset, replay still refused, open-mode snapshot unchanged.

### W9.2 — `/proof` page (interface + one backend route, ~60–75 min)
- Backend `GET /x402-demo/proof-run` (mounted only with the demo seller; in-process throttle
  ~1 run/5s): executes against the REAL paywall in strict mode with two identities —
  a throwaway bot key and `X402_PROOF_AGENT_KEY` — and returns a JSON transcript:
  `[{actor:"bot", status:403, reason}, {actor:"agent", status:402, humanId, rate:{used,limit}}]`.
  No settlement. `POST /x402-demo/proof-run {settle:true}` (authed, tenant session) adds the real
  paid leg via the existing payment path and returns the settlement id.
- Interface `/proof`: public page, instrument grammar, no wallet providers needed for the free
  run. Banner: *"This seller trades with accountable agents only."* Two panels — **AN ANONYMOUS
  BOT** → red `403 REFUSED — no one answers for this agent` with the remediation body shown;
  **A NOVI CORPUS AGENT** → its AgentBook humanId (truncated), then amber `402 INVOICE — cleared
  to buy` with the rate counter. "Run again" replays live. Signed-in users see the "Run with real
  settlement (0.01 USDC)" button; it appends the green `200 SERVED — settlement <id>` line.
- This page is the submission artifact: a judge can watch the policy work without us present.

### W9.3 — AgentBook visibility + registration from the dashboard (STRETCH)
- Cheap half (~15 min, do it): dashboard identity card gains an **AgentBook** chip — live
  `lookupHuman(operator)` through the existing cache: `✓ human-backed` / `not registered`.
  Every agent page then shows the World integration at a glance.
- Expensive half (VERIFY-FIRST, likely post-hackathon): "Register" QR flow in-product. The CLI's
  relay API is undocumented for us — extract the endpoint + payload from `@worldcoin/agentkit-cli`
  source (npm tarball) BEFORE writing any code, same discipline as W7.2. Until then the chip's
  "not registered" state links to the CLI one-liner.

## Non-goals
- No discount/free-tier of any kind, in code or copy (World DQ list).
- No changes to `verifyAgentkitRequest`, the nonce store, or the buyer wrapper.
- No flipping prod to `accountable-only` as part of the merge — separate deliberate env change,
  same two-step ritual as every other flag (deploy inert, then flip).
- No un-registration story: AgentBook is permanent by design — that asymmetry (they can't revoke;
  our guardian can pause/claw back) is the pitch, not a bug to fix.

## Sequencing + budget (user has ~5h; writeup/video still at ZERO)
1. W9.0 scan (5 min, user) → 2. W9.1 (~75 min, tests green) → 3. W9.2 (~75 min, screenshot both
   panels) → 4. W9.3 cheap half (~15 min) → **HARD STOP ≈ 3h in: submission writeup + video get
   the rest.** W9.3 QR flow explicitly deferred unless everything above lands early. If W9.0's
   relay is down, skip to W9.1 immediately — strict mode's bot-403 legs are fully real without it.

## Demo beat (booth / video, ~40s)
Open `/proof`. "This agent economy has a rule ours enforces: we don't trade with agents no one
answers for." Click Run — bot: **REFUSED**, and the refusal itself tells it how to become
accountable. Agent: humanId from a live World Chain read → **cleared to buy** → (button) pays
0.01 USDC from its governed treasury → **SERVED**. "World proves someone answers for the agent.
The treasury, the caps, the clawback — that's us. Accountability first; then, and only then,
commerce."
