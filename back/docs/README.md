# Documentation index

A map of every doc in this folder, with its status, so a new contributor knows what is **current**
vs. a **historical record** of completed work. Start with the root [README.md](../README.md), then this
index, then [backend/README.md](../backend/README.md).

Status legend: ✅ current · 📓 historical record (the work it plans/designs is done) · ⚖️ legal/research
(directional; validate with counsel) · ⚠️ partly superseded (see its top banner).

## Overview & spec
| Doc | Status | What it is |
|---|---|---|
| [SPEC.md](./SPEC.md) | ⚠️ | The original master spec — strategic context, landscape, design. Still useful, but its legal framing (Bayern/zero-member) and some wallet sections are superseded; see its top banners and the legal note below. |
| [POSITIONING.md](./POSITIONING.md) | ✅ | **Canonical positioning** — what the *real* innovation is. Separates copyable on-chain mechanics (caps/guardian/ERC-8004/8183 = table stakes) from the legal body (the moat). Read before writing any pitch/deck/grant. |
| [PROJECT_RECAP.md](./PROJECT_RECAP.md) | ✅ (FR) | Short project pitch / onboarding overview, in French. |
| [V2_HARDENING_BACKLOG.md](./V2_HARDENING_BACKLOG.md) | ✅ | Deferred production-hardening items (crash-safety, concurrency, replay, ops). None block the demo. |

## Design (architecture decisions)
| Doc | Status | What it is |
|---|---|---|
| [design/2026-06-16-nanopayments-x402-agent-design.md](./design/2026-06-16-nanopayments-x402-agent-design.md) | ✅ | **Hackathon (Lepton, Arc × Circle):** additive layer giving the live legal body a two-sided x402/Circle-Gateway nanopayment agent, governed by a policy-gated Payment Authority. Existing contracts/onboarding/signer unchanged. |
| [design/2026-06-08-wallet-and-treasury-architecture.md](./design/2026-06-08-wallet-and-treasury-architecture.md) | ✅ | The custody decision: non-custodial Turnkey signer + on-chain `AgentTreasury` (not a Circle custody wallet). The current source of truth for custody. |
| [design/2026-06-08-agent-treasury-vault-design.md](./design/2026-06-08-agent-treasury-vault-design.md) | ✅ | Design of the `AgentTreasury` vault (rolling cap + allowlist, guardian powers). |
| [design/2026-06-09-backend-onboarding-brain-design.md](./design/2026-06-09-backend-onboarding-brain-design.md) | ✅ | Design of the Phase-2 backend "brain" (modules, the law→code translator, the onboarding saga). |
| [design/2026-05-29-agent-legal-body-demo-design.md](./design/2026-05-29-agent-legal-body-demo-design.md) | 📓 | Earliest end-to-end demo design; useful context, partly overtaken by the 06-08/06-09 designs. |

## Plans (implementation plans)
| Doc | Status | What it is |
|---|---|---|
| [plans/2026-06-16-nanopayments-x402-agent-implementation.md](./plans/2026-06-16-nanopayments-x402-agent-implementation.md) | ✅ | Implementation plan for the [nanopayments x402 agent design](./design/2026-06-16-nanopayments-x402-agent-design.md). Phase 0 (Gateway/x402 spike) + Phase 1 (Payment Authority core) in full TDD detail; Phases 2–4 (buyer/seller, Claude agent, dashboard) as a post-spike roadmap. |
| [plans/2026-06-18-nanopayments-x402-phase2-implementation.md](./plans/2026-06-18-nanopayments-x402-phase2-implementation.md) | 📓 | Phase-2 implementation plan — **completed** (x402 signer adapter, funding bridge, buyer, seller, Payment Authority wiring, e2e harness). Records the 2026-06-18 wiring decisions (X-PAYMENT codec, self-hosted seller verify, governed top-up flow). |
| [plans/2026-05-29-smart-contract-layer.md](./plans/2026-05-29-smart-contract-layer.md) | 📓 | Phase-1 contract plan — **completed** (contracts built, audited, deployed). |
| [plans/2026-06-08-agent-treasury-vault.md](./plans/2026-06-08-agent-treasury-vault.md) | 📓 | `AgentTreasury` vault plan — **completed**. |
| [plans/2026-06-10-backend-onboarding-brain-implementation.md](./plans/2026-06-10-backend-onboarding-brain-implementation.md) | ✅ | Phase-2 backend plan — being executed; the brain is built (translator, OA gen, Arc adapter, Turnkey, saga, CLI), live Arc E2E pending. |
| [plans/2026-06-18-nanopayments-x402-phase3-implementation.md](./plans/2026-06-18-nanopayments-x402-phase3-implementation.md) | 📓 | Phase-3 implementation plan — **completed** (seller/settle 3A, in-process vendor 3B, tools/pricing 3C, Claude insight-agent loop 3D, demo CLI + live spike 3E). All 145 tests pass; live agent gated on `ANTHROPIC_API_KEY`. |

## Research (co-founder owned — legal + technical)
| Doc | Status | What it is |
|---|---|---|
| [research/RESEARCH_FINDINGS.md](./research/RESEARCH_FINDINGS.md) | ⚖️ | Source-verified research notes underpinning the spec (with corrections inline). |
| [research/LEGAL_OPERATIONS.md](./research/LEGAL_OPERATIONS.md) | ⚖️ | Legal operations playbook (formation, EIN, banking, per-registration runbook). See its top banner re: the resolved controller-of-record model. |
| [research/COMPETITIVE_LANDSCAPE.md](./research/COMPETITIVE_LANDSCAPE.md) | ⚖️ | Competitors + agentic-commerce field scan. |
| [research/STACK_REFERENCE.md](./research/STACK_REFERENCE.md) | ✅ | Circle + Arc engineering reference (endpoints, addresses, gotchas). |
| [research/2026-06-16-x402-gateway-spike-findings.md](./research/2026-06-16-x402-gateway-spike-findings.md) | ✅ | **Phase-0 spike findings (hackathon):** verified x402 EIP-3009 signing via the Turnkey signer + a real Circle Gateway batched settlement on Arc testnet. Records the `signX402()` seam, the `BatchEvmSigner` non-custodial path, and corrections (x402 on Arc via Circle's batching scheme; `GatewayClient` is only the raw-key convenience wrapper). |

## Runbooks (operator-triggered live operations)
| Doc | Status | What it is |
|---|---|---|
| [runbooks/2026-06-19-live-agent-run.md](./runbooks/2026-06-19-live-agent-run.md) | ✅ | **Live governed agent cycle (Arc testnet):** governed funding → agent buys data (settles) → simulated customer buys the answer (settles into the treasury) → real P&L. Operator-triggered only (`--settle`). |

## Audit
| Doc | Status | What it is |
|---|---|---|
| [audit/2026-06-09-internal-security-audit.md](./audit/2026-06-09-internal-security-audit.md) | 📓 | Internal security audit of the Phase-1 contracts (no Critical/High). |

## The legal model, in one line
A fully human-less ("Bayern / zero-member") entity is **legally foreclosed**; a named, KYC'd
natural-person **controller-of-record is mandatory** (triple-locked). The real model is
**human-controller + agent-bounded-operator** — which the architecture already implements. Where older
docs lead with the zero-member framing, treat it as origin/context, not the production claim.
