# Autonomous Agent Proof-of-Life — ERC-8183 Job, USDC Settlement & ERC-8004 Reputation on Arc

**Date:** 2026-06-30 · **Network:** Arc testnet (chainId `5042002`) · **Asset:** USDC (native)

## Summary

An agent onboarded into our protocol as an **on-chain legal entity** — with a governed USDC treasury
(a Wyoming-DAO-LLC mapped to an `AgentTreasury` contract) — **autonomously completed a real job on the
ERC-8183 job market, was paid in USDC, and earned on-chain reputation on the ERC-8004 registry**, with
every agent-side action **signed non-custodially by the agent's own Turnkey vault key**.

This is the full Circle / Arc agent stack working end-to-end on a single agent:

> **Identity (ERC-8004)  →  Escrowed job (ERC-8183)  →  USDC settlement  →  Reputation (ERC-8004)**

The run completed cleanly on the **first live attempt**, terminal status **`reputed`**.

## The agent (the legal body)

| | |
|---|---|
| Name | **TestAgentMB_1** |
| On-chain identity (ERC-8004 agentId) | **842839** |
| Governed treasury (`AgentTreasury`) | [`0x9f01EF22…B0a5`](https://testnet.arcscan.app/address/0x9f01EF223BdB596625d8eE2E30F13A8aB527B0a5) |
| Guardian (human controller — pause / veto) | `0x172B7952…BB02` |
| Operator (the agent's signer) | [`0xE38cA1e5…Ab55`](https://testnet.arcscan.app/address/0xE38cA1e5D5ac9d9A609eA1ed20e70d60F6AcAb55) |
| Custody | **Non-custodial** — operator is a per-agent **Turnkey** enclave key; no human or platform holds it |

The agent acts as the **provider** in the job. Two distinct, independent parties play the other roles —
a **client** that posts and funds the job, and an **evaluator** that confirms completion and records
feedback — because the ERC-8183/8004 contracts require the completer and the rater to be neither the
client nor the agent itself. This separation is what makes the settlement and the reputation
**trustworthy rather than self-asserted**.

## The loop

```
 pending ─▶ created ─▶ funded ─▶ submitted ─▶ completed ─▶ reputed
            client     client    AGENT         evaluator    evaluator
          createJob   approve+   submit        complete     giveFeedback
          setBudget*    fund    (work done)  (USDC settles  (ERC-8004
          (*AGENT)              to the AGENT)   reputation)
```

The **AGENT's** actions (`setBudget`, `submit`) are signed by its Turnkey vault key — visible on-chain as
transactions *from* the operator address `0xE38c…`. The agent never holds or exposes a private key; the
enclave signs within the policy of its governed treasury.

## On-chain evidence (all verified `status = success`)

| Step | Signed by | Tx (arcscan) | Block |
|---|---|---|---|
| `createJob` | client `0xb43c…703b` | [`0x4efb4ca5…`](https://testnet.arcscan.app/tx/0x4efb4ca58c7fa692fdef1c69edb3ce94044c6837cb630906510e10ed7384a715) | 49515747 |
| `fund` (escrow 0.10 USDC) | client `0xb43c…703b` | [`0xb765960a…`](https://testnet.arcscan.app/tx/0xb765960a8937a43fcc4d8e8a2f688500ad9bdf8b9ef4fb0120fbbe770d4dfa11) | 49515778 |
| `submit` (**the agent**) | operator `0xE38c…Ab55` | [`0x1c294935…`](https://testnet.arcscan.app/tx/0x1c2949351c84274b8606cd689c36bcf5097950a01c744b7e375a0a061e404177) | 49515789 |
| `complete` (USDC settles to agent) | evaluator `0xD27e…20f8` | [`0xd797a3b5…`](https://testnet.arcscan.app/tx/0xd797a3b531991b6d042a7e55db4ef5c5e1934ecb750c0b2f0334728c029e86c6) | 49515799 |
| `giveFeedback` (reputation) | evaluator `0xD27e…20f8` | [`0x1c36523f…`](https://testnet.arcscan.app/tx/0x1c36523f7c387bc791147c1d58daaf9ada2658a8d045835dafd454ceca006a6b) | 49515810 |

**Job ID:** `144629` on the ERC-8183 contract.

## Economic result

The agent **earned real USDC**:

| | USDC |
|---|---|
| Operator balance before | 0.795256 |
| Operator balance after | 0.892160 |
| **Net earned** | **+0.096904** |

The agent received the **0.10 USDC** escrow on `complete` and paid only ~0.0031 USDC in gas for its own
provider transactions (Arc settles gas in USDC) — a **net profit of ~0.097 USDC** — and now carries an
**on-chain reputation record** for agentId 842839 that any counterparty can independently verify.

## Why it matters

- **The agent can *earn*, not just *spend*.** Combined with its governed treasury, the agent is a
  two-sided, self-sustaining economic actor.
- **Portable, verifiable identity + reputation.** The agentId and the feedback live on **public Arc
  registries**, not in our database — so *any* counterparty, marketplace, or service can verify who the
  agent is and check its track record before transacting. That is the basis of an actual agent economy.
- **Trust without prior relationship.** Reputation recorded by an independent evaluator is the on-chain
  analog of a credit score. Stacked on a real legal body with a KYC-able human controller, the agent is
  **legally accountable *and* on-chain reputable**.
- **Governed and non-custodial throughout.** Every agent action is signed by the agent's own Turnkey
  enclave key, within the policy of its on-chain treasury (caps, guardian pause, allowlist) — the
  legal-body governance is never bypassed.

## Contracts & network

| | Address |
|---|---|
| ERC-8004 Identity Registry | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| ERC-8183 Job | [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) |
| ERC-8004 Reputation Registry | [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://testnet.arcscan.app/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| USDC (native, Arc) | `0x3600000000000000000000000000000000000000` |
| Network | Arc testnet, chainId `5042002`, explorer `testnet.arcscan.app` |

## Verify it yourself

Open any tx link above on `testnet.arcscan.app` and confirm: the job was created and funded by the
client, **submitted by the agent's own operator address** `0xE38c…`, completed by an independent
evaluator with USDC moving to the agent, and a reputation entry recorded for agentId **842839**. No
trust in us required — the chain is the proof.

---

*Implementation: backend job saga `back/backend/src/jobs/runJob.ts` (states `pending → created → funded →
submitted → completed → reputed`), ERC-8183/8004 adapters under `back/backend/src/adapters/arc/`. Run
mirrors the gated harness `back/backend/test/jobs.arc.live.test.ts`.*
