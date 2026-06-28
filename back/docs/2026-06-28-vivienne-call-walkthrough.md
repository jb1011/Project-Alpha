# Circle call walkthrough — Vivienne (Product), 2026-06-29

> A run-of-show for a **product** audience (not deep tech). Goal: show what we're building on Circle's
> stack — especially the Agent Stack — with a live, real demo. Written 2026-06-28.

## The one-line pitch

> **We give an AI agent a real legal body — a Wyoming LLC — so it can hold a USDC treasury, transact on
> Arc, and act with limited liability under human-controlled guardrails. It's built entirely on Circle's
> stack.**

Why Circle should care: we **unlock a new customer segment for Circle's rails** — *governed,
legally-accountable agents*. The legal body is the trust/accountability layer on top of Circle's money
movement (USDC, Arc, Gateway, x402).

## Links & assets (have these open in tabs before the call)

- **Live product:** https://project-alpha-pi.vercel.app → the wizard + dashboard live at `/onboarding`.
- **Backend ("the brain"):** VPS `159.223.137.183:8789` (the wizard API + MCP server; not shown directly).
- **Explorer:** https://testnet.arcscan.app (Arc testnet, chain id 5042002). Faucet: https://faucet.circle.com.
- **Demo agent (real, funded):** `TestAgentMB_1` — agentId **842839**, treasury
  `0x9f01EF223BdB596625d8eE2E30F13A8aB527B0a5` (**real 3 USDC**, not paused).
- **Arcscan proof artifacts** (pre-open these tabs — zero-risk "this really works on Circle's Arc"):
  - **USDC through Circle Gateway** (gatewayMint): `https://testnet.arcscan.app/tx/0xbce3463db186fd555686dda645af433d25b10842e6cbd545aa5fa75bf9b8c992`
  - **x402 settlement via Circle's BatchFacilitator** — transfer id `83f306bc-cfc8-4860-b4ae-82ddd5c5b7e3`
    (verify `isValid:true`, settle `success`, 0.01 USDC debited on Arc).
  - **ERC-8004 IdentityRegistry:** `0x8004A818BFB912233c491871b3d84c89A494BD9e` (the agent's on-chain identity).
  - **Our LegalManagerFactory:** `0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902` (our contracts, live on Arc).
  - **ERC-8183 job contract:** `0x0747EEf0706327138c69792bF28Cd525089e4583`.

## Run of show (~10 min)

| # | Show | What she sees | Circle hook |
|---|---|---|---|
| 1 | **Landing page** (`/`) | "A real legal body for an AI agent" | Built on Circle's stack |
| 2 | **Onboard an agent** (`/onboarding`) | Sign in + passkey → set **USDC caps** + guardian → a generated **Wyoming LLC operating agreement** → **on-chain deploy** (live tx links) → **fund the treasury** in USDC | **USDC** treasury, **Arc** deploy, non-custodial **Wallets** (Turnkey), **ERC-8004** identity |
| 3 | **The dashboard** | **Real treasury balance** + a **real on-chain guardian freeze** (click *Pause* → wallet signs → agent frozen on-chain) | A human safety brake over Circle's rails |
| 4 | **Proof on Arcscan** | The gatewayMint tx + the x402 settle + the agent identity + our factory | "Real USDC, really moved, on Circle's Arc" — the credibility close |
| 5 | **The agent earns & spends** (x402) | The governed nanopayment loop — agent buys data via x402, sells an answer, P&L into the treasury (shown via terminal / Arcscan today) | **x402 + Gateway** nanopayments in **USDC** |
| 6 | **Forward look** | "It's also an **MCP server** — an agent can onboard/manage its legal body by chatting in Claude. And **x401** (Circle + Proof) is the identity layer we plug in next." | Circle's agentic direction |

### Act details

**Act 2 — Onboard (the core product story, ~3–4 min).** Do it live on the deployed site with your demo
wallet (it must be on Arc testnet with a little USDC for gas). The story to narrate: *"A human sets the
agent's spending rules — in USDC — and those rules become both the on-chain limits and the legally
operative terms of a real Wyoming LLC. Code = contract."* The deploy step shows real Arc tx hashes
(clickable to Arcscan): ERC-8004 identity registration, treasury + governance deployment, agent-key bind.
Then fund the treasury with ~2–3 USDC.

**Act 3 — The dashboard + the guardian freeze (the signature moment, ~1–2 min).** The dashboard now shows
the **real** treasury balance and on-chain state (not mocked). Then: *"The human can freeze the agent
instantly."* Click **Pause agent** → your wallet signs a real transaction → the agent is paused on-chain
(`treasury.pause()`), and its autonomous spending is blocked. This is the trust story made tangible. Resume
to restore.

**Act 4 — Proof on Arcscan (~1–2 min).** Open the pre-loaded tabs. Lead with the **gatewayMint tx** (real
USDC moved through Circle's Gateway on Arc) and the **x402 settlement** (our payload accepted by Circle's
own facilitator). Then the **agent identity** on the ERC-8004 registry and **our factory** contract. The
point: *none of this is a mock — real USDC has moved through Circle's Gateway on Arc, settled via x402, and
a real agent identity is registered.*

**Act 5 — The agent transacting (~2 min, optional-live).** The most Circle-relevant capability: the agent
**earns USDC by selling insight and pays for data via x402 nanopayments**, every payment policy-gated by the
treasury caps. Built end-to-end; today it's shown via a terminal run + the Arcscan settlement artifacts
(the in-product activity view is the next build). If the live `agent ask` run is staged (funded keys +
Anthropic key), run it; otherwise narrate over the proven Arcscan transfer.

## The Circle stack we use (a quick map for a Circle PM)

- **USDC** — the agent's treasury + the native gas token on Arc.
- **Arc** — the chain everything deploys + settles on (sub-second finality, USDC gas).
- **Gateway** — instant USDC settlement for the agent's payments (proven on-chain).
- **x402** (+ Circle's batching scheme) — how the agent pays/gets paid per request; interop proven against
  Circle's own BatchFacilitator.
- **Wallets / non-custodial signing** — per-agent Turnkey vault (guardian passkey + delegated sign-only key).
- **ERC-8004 / ERC-8183** — Arc's agentic-commerce standards: on-chain agent identity, reputation, and jobs.

## What to lead with (risk management)

1. **Lead with the live onboarding + the real dashboard + the guardian freeze** — all real, all low-risk.
2. **Then the Arcscan proof artifacts** — zero risk, undeniable, on Circle's Arc.
3. **Treat the live `agent ask` x402 run as "if staged"** — otherwise show its Arcscan settlement + narrate.
   Don't gate the demo on a first-ever live nanopayment run.

## Pre-call checklist

- [ ] Demo wallet on **Arc testnet** with a little **USDC** for gas (faucet: faucet.circle.com).
- [ ] The honest dashboard verified + on the live site (or preview) — real balance renders, **Pause** signs
      + flips state. (See `back/docs/plans/2026-06-28-honest-dashboard.md`.)
- [ ] Decide the demo agent: onboard a **fresh** one live (best story), with `TestAgentMB_1` (3 USDC) as a
      pre-funded backup.
- [ ] Arcscan proof tabs pre-opened (the gatewayMint tx + the x402 transfer + the identity registry + the factory).
- [ ] (Optional) the live `agent ask` env staged if you want the x402 loop live.

## The framing that lands

You're **not** rebuilding Circle's rails. You're building the **legal + governance layer on top of them** —
turning Circle's USDC/Arc/Gateway/x402 into something a *legally accountable, human-controlled* agent can
safely use. That's a new customer segment for Circle, and the moat (the legal body) is the piece x401/x402
still can't provide.
