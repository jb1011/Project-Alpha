# Documentation index

Every document in this folder, grouped by topic, with what it is and when it last changed. Start
with the [root README](../../README.md) and [back/README.md](../README.md), then come here.

**Status:** *Guide* and *Reference* are meant to be read today. *Runbook* is a live operation,
run by a person. *Done* is the design or plan of work that has shipped: it records why things are
the way they are, and later changes may have moved past it. *Record* is the log of one run or one probe.

Some designs and plans are kept in the team's private repository, including everything written
since mid-September 2026 (for example the bring-your-own legal body).

## Guides

How to connect to, build on or integrate with Novi Corpus.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [AUDIT_CONTEXT.md](./AUDIT_CONTEXT.md) | Guide | 2026-10-21 | For security reviewers: scope, build and test, privileged roles, intended behaviours that may look risky, dependencies, prior reviews. |
| [BYOA_INTEGRATION.md](./BYOA_INTEGRATION.md) | Guide | 2026-10-21 | Bring your own agent: connect an existing agent over MCP or REST, the capability ladder, and every MCP tool. |
| [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md) | Guide | 2026-10-21 | How the web app talks to the backend for onboarding: sign-in, World ID, passkey, company, onboard, poll, fund. |
| [integrations/agentkit-legal-body-check.md](./integrations/agentkit-legal-body-check.md) | Guide | 2026-10-09 | Asking AgentKit's "is there a human?" and Novi's "is there a legal body?" in one call. |

## Contracts and the legal body

The on-chain layer: legal manager, treasury, factory, and how they were tested and audited.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [design/2026-05-29-agent-legal-body-demo-design.md](./design/2026-05-29-agent-legal-body-demo-design.md) | Done | 2026-06-23 | The first end-to-end design; context for everything after it. |
| [plans/2026-05-29-smart-contract-layer.md](./plans/2026-05-29-smart-contract-layer.md) | Done | 2026-06-23 | Plan for the contract layer (LegalManager, factory). |
| [design/2026-06-08-agent-treasury-vault-design.md](./design/2026-06-08-agent-treasury-vault-design.md) | Done | 2026-06-23 | Design of the AgentTreasury: rolling cap, allowlist, guardian powers. |
| [plans/2026-06-08-agent-treasury-vault.md](./plans/2026-06-08-agent-treasury-vault.md) | Done | 2026-06-23 | Plan for the AgentTreasury. |
| [audit/2026-06-09-internal-security-audit.md](./audit/2026-06-09-internal-security-audit.md) | Done | 2026-06-23 | Internal security audit of the first contract layer. |
| [plans/2026-06-30-contracts-security-pass-plan.md](./plans/2026-06-30-contracts-security-pass-plan.md) | Done | 2026-06-30 | Plan for the static-analysis security pass. |
| [audit/2026-06-30-contracts-security-pass.md](./audit/2026-06-30-contracts-security-pass.md) | Done | 2026-07-02 | The static-analysis security pass and its findings. |
| [plans/2026-07-13-live-registry-fork-tests.md](./plans/2026-07-13-live-registry-fork-tests.md) | Done | 2026-07-20 | Fork tests against the live Arc ERC-8004 registry. |

## Backend and onboarding

The backend that runs onboarding, custody of the agents' wallets and company formation.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [design/2026-06-09-backend-onboarding-brain-design.md](./design/2026-06-09-backend-onboarding-brain-design.md) | Done | 2026-06-23 | The backend's modules, the law to code translator and the onboarding saga. |
| [plans/2026-06-10-backend-onboarding-brain-implementation.md](./plans/2026-06-10-backend-onboarding-brain-implementation.md) | Done | 2026-06-23 | Plan for the backend and the onboarding saga. |
| [design/2026-06-19-per-agent-turnkey-vault-design.md](./design/2026-06-19-per-agent-turnkey-vault-design.md) | Done | 2026-06-23 | A Turnkey wallet per agent, provisioned at onboarding. |
| [plans/2026-06-19-per-agent-turnkey-vault-implementation.md](./plans/2026-06-19-per-agent-turnkey-vault-implementation.md) | Done | 2026-06-23 | Plan for the per-agent Turnkey wallet. |
| [plans/2026-06-20-per-agent-vault-live-test.md](./plans/2026-06-20-per-agent-vault-live-test.md) | Done | 2026-06-23 | Live provisioning test of the per-agent wallet. |
| [plans/2026-06-21-grant-backend-roadmap.md](./plans/2026-06-21-grant-backend-roadmap.md) | Done | 2026-06-23 | The backend roadmap written for the Circle grant (tracks A, B, C). |
| [design/2026-06-21-onboarding-wizard-api-design.md](./design/2026-06-21-onboarding-wizard-api-design.md) | Done | 2026-06-23 | The wizard's REST API (track A). |
| [plans/2026-06-21-onboarding-wizard-api-implementation.md](./plans/2026-06-21-onboarding-wizard-api-implementation.md) | Done | 2026-06-23 | Plan for the wizard's REST API. |
| [design/2026-08-01-v25-batch1.md](./design/2026-08-01-v25-batch1.md) | Done | 2026-08-01 | v2.5 batch 1: per-agent trust, the legal-bodies tier, server efficiency, guardian linkage. |
| [design/2026-07-04-public-metadata-uri-design.md](./design/2026-07-04-public-metadata-uri-design.md) | Done | 2026-09-09 | A public HTTPS metadata URI for each agent. |
| [plans/2026-07-04-public-metadata-uri.md](./plans/2026-07-04-public-metadata-uri.md) | Done | 2026-07-04 | Plan for the public metadata URI. |

## Payments

x402 payments, Circle Gateway, funding and the governed nanopayment agent.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [research/2026-06-16-x402-gateway-spike-findings.md](./research/2026-06-16-x402-gateway-spike-findings.md) | Record | 2026-06-23 | Spike findings: x402 and Circle Gateway on Arc testnet. |
| [plans/2026-06-16-nanopayments-x402-agent-implementation.md](./plans/2026-06-16-nanopayments-x402-agent-implementation.md) | Done | 2026-06-23 | Plan for the governed nanopayment agent (phases 0 and 1). |
| [plans/2026-06-18-nanopayments-x402-phase2-implementation.md](./plans/2026-06-18-nanopayments-x402-phase2-implementation.md) | Done | 2026-06-23 | Phase 2: spend, earn and governed funding. |
| [plans/2026-06-18-nanopayments-x402-phase3-implementation.md](./plans/2026-06-18-nanopayments-x402-phase3-implementation.md) | Done | 2026-06-23 | Phase 3: the insight-agent loop. |
| [design/2026-06-19-nanopayments-live-e2e-wiring-design.md](./design/2026-06-19-nanopayments-live-e2e-wiring-design.md) | Done | 2026-06-23 | Wiring the agent end to end on testnet. |
| [plans/2026-06-19-nanopayments-live-e2e-wiring-implementation.md](./plans/2026-06-19-nanopayments-live-e2e-wiring-implementation.md) | Done | 2026-06-23 | Plan for the end-to-end wiring. |
| [design/2026-06-28-agent-activity-feed-design.md](./design/2026-06-28-agent-activity-feed-design.md) | Done | 2026-09-09 | Showing the agent's real x402 settlements in the dashboard. |
| [plans/2026-06-28-agent-activity-feed.md](./plans/2026-06-28-agent-activity-feed.md) | Done | 2026-09-09 | Plan for the activity feed. |
| [design/2026-07-04-fund-pocket-bridge-robustness-design.md](./design/2026-07-04-fund-pocket-bridge-robustness-design.md) | Done | 2026-07-04 | Making the pocket-funding bridge robust. |
| [plans/2026-07-04-fund-pocket-bridge-robustness.md](./plans/2026-07-04-fund-pocket-bridge-robustness.md) | Done | 2026-07-04 | Plan for the pocket-funding fixes. |
| [design/2026-07-04-payment-funding-hardening-design.md](./design/2026-07-04-payment-funding-hardening-design.md) | Done | 2026-07-04 | Hardening payments and funding. |
| [plans/2026-07-04-payment-funding-hardening.md](./plans/2026-07-04-payment-funding-hardening.md) | Done | 2026-07-04 | Plan for the payment and funding hardening. |
| [design/2026-07-04-x402-demo-seller-leg3-design.md](./design/2026-07-04-x402-demo-seller-leg3-design.md) | Done | 2026-07-04 | An x402 demo seller as a smoke-test target. |
| [plans/2026-07-04-x402-demo-seller-leg3.md](./plans/2026-07-04-x402-demo-seller-leg3.md) | Done | 2026-07-04 | Plan for the x402 demo seller. |
| [plans/2026-07-20-s2-float-ceiling.md](./plans/2026-07-20-s2-float-ceiling.md) | Done | 2026-07-29 | The S2 interim fix: a ceiling on each agent's x402 standing float, and the legal-status gate on payments. |

## Agents: MCP, bring your own agent, jobs

The MCP server, connecting an agent the customer already runs, and ERC-8183 jobs.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [research/2026-06-22-erc8183-reputation-findings.md](./research/2026-06-22-erc8183-reputation-findings.md) | Record | 2026-06-23 | Verified findings on Arc's ERC-8183 job contract and the ERC-8004 reputation registry. |
| [design/2026-06-22-track-c-erc8183-proof-of-life-design.md](./design/2026-06-22-track-c-erc8183-proof-of-life-design.md) | Done | 2026-06-23 | An autonomous ERC-8183 job as proof of life (track C). |
| [plans/2026-06-22-track-c-erc8183-proof-of-life-implementation.md](./plans/2026-06-22-track-c-erc8183-proof-of-life-implementation.md) | Done | 2026-06-23 | Plan for the ERC-8183 proof of life. |
| [design/2026-06-27-mcp-server-design.md](./design/2026-06-27-mcp-server-design.md) | Done | 2026-06-28 | The MCP server (track B). |
| [plans/2026-06-27-mcp-server.md](./plans/2026-06-27-mcp-server.md) | Done | 2026-06-28 | Plan for the MCP server. |
| [plans/2026-07-01-byoa-p0-per-agent-float-webauthn.md](./plans/2026-07-01-byoa-p0-per-agent-float-webauthn.md) | Done | 2026-07-02 | Bring your own agent, P0: per-agent float and WebAuthn hardening. |
| [plans/2026-07-01-byoa-p1-connect.md](./plans/2026-07-01-byoa-p1-connect.md) | Done | 2026-07-02 | P1: connecting an agent from the web. |
| [plans/2026-07-02-byoa-p2a-scope-and-reads.md](./plans/2026-07-02-byoa-p2a-scope-and-reads.md) | Done | 2026-07-03 | P2a: MCP key scopes and read tools. |
| [plans/2026-07-02-byoa-p2b-pay-and-treasury-status.md](./plans/2026-07-02-byoa-p2b-pay-and-treasury-status.md) | Done | 2026-07-03 | P2b: the governed pay tool and treasury status. |
| [plans/2026-07-03-byoa-p2c-run-job.md](./plans/2026-07-03-byoa-p2c-run-job.md) | Done | 2026-07-03 | P2c: the run_job tool (ERC-8183). |
| [plans/2026-07-03-byoa-p3-agent-first-bootstrap.md](./plans/2026-07-03-byoa-p3-agent-first-bootstrap.md) | Done | 2026-07-03 | P3: the magic-link bootstrap and claim_connection. |
| [design/2026-07-03-byoa-frontend-screens-design.md](./design/2026-07-03-byoa-frontend-screens-design.md) | Done | 2026-07-04 | The bring-your-own-agent screens. |
| [plans/2026-07-03-byoa-frontend-screens.md](./plans/2026-07-03-byoa-frontend-screens.md) | Done | 2026-07-04 | Plan for those screens. |

## Interface

The web app.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [design/2026-07-04-interface-connections-reorg-design.md](./design/2026-07-04-interface-connections-reorg-design.md) | Done | 2026-07-05 | Reorganising connections and passkeys in the app. |
| [plans/2026-07-04-interface-connections-reorg.md](./plans/2026-07-04-interface-connections-reorg.md) | Done | 2026-07-05 | Plan for that reorganisation. |

## World and the legal-body check

AgentBook registration and the legal-body check built for ETHOnline 2026.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [design/2026-08-25-agentbook-registration-design.md](./design/2026-08-25-agentbook-registration-design.md) | Done | 2026-09-18 | Registering an agent in World's AgentBook so it can trade with sellers that require human backing. |
| [design/2026-09-07-agentbook-registration-audit.md](./design/2026-09-07-agentbook-registration-audit.md) | Done | 2026-09-18 | The second audit of that design. |
| [plans/2026-09-07-agentbook-registration-plan.md](./plans/2026-09-07-agentbook-registration-plan.md) | Done | 2026-09-18 | Plan for AgentBook registration. |
| [design/2026-09-10-legal-body-check-design.md](./design/2026-09-10-legal-body-check-design.md) | Done | 2026-09-18 | The legal-body check: "is there a human?" plus "is there a legal body?". |
| [plans/2026-09-10-legal-body-check-plan.md](./plans/2026-09-10-legal-body-check-plan.md) | Done | 2026-09-10 | Plan for the legal-body check. |
| [runbooks/agentbook-registration.md](./runbooks/agentbook-registration.md) | Runbook | 2026-09-18 | Registering an agent in AgentBook. |
| [runbooks/legal-body-check.md](./runbooks/legal-body-check.md) | Runbook | 2026-10-09 | Running the legal-body check. |
| [runbooks/world-sandbox-testing.md](./runbooks/world-sandbox-testing.md) | Runbook | 2026-09-18 | Testing guardian flows in World's sandbox. |

## Hedera rail

A second payment rail on Hedera for the paid standing check (ETHOnline 2026).

| Document | Status | Last change | What it is |
|---|---|---|---|
| [research/2026-09-09-hedera-signer-spike-findings.md](./research/2026-09-09-hedera-signer-spike-findings.md) | Record | 2026-09-09 | Signer spike: raw-digest signing, hollow accounts, the 1-of-2 leash. |
| [design/2026-09-10-hedera-rail-design.md](./design/2026-09-10-hedera-rail-design.md) | Done | 2026-09-11 | The Hedera rail: governed x402 payments, the paid standing check, portable identity. |
| [plans/2026-09-10-hedera-rail.md](./plans/2026-09-10-hedera-rail.md) | Done | 2026-09-18 | Plan for the Hedera rail. |
| [runbooks/hedera-demo.md](./runbooks/hedera-demo.md) | Runbook | 2026-09-12 | The five-leg Hedera demo on testnet. |

## Operations

Live operations on testnet: formation runs, demo runs, monitoring.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [runbooks/2026-06-19-live-agent-run.md](./runbooks/2026-06-19-live-agent-run.md) | Runbook | 2026-06-23 | A live governed agent cycle on Arc testnet. |
| [runbooks/doola-deploy.md](./runbooks/doola-deploy.md) | Runbook | 2026-09-18 | Deploying the doola formation provider. |
| [runbooks/doola-webhooks.md](./runbooks/doola-webhooks.md) | Runbook | 2026-09-18 | doola webhooks. |
| [runbooks/formation-e2e-1-2026-08-26.md](./runbooks/formation-e2e-1-2026-08-26.md) | Record | 2026-09-18 | The first end-to-end formation run on doola's sandbox. |
| [runbooks/formation-settle-probe-2026-09.md](./runbooks/formation-settle-probe-2026-09.md) | Record | 2026-09-10 | The live settle probe that gated a merge. |
| [runbooks/controller-monitoring.md](./runbooks/controller-monitoring.md) | Runbook | 2026-10-19 | Monitoring the NoviController. |
| [runbooks/legalbody-monitor.service](./runbooks/legalbody-monitor.service) | Ops file | 2026-09-09 | systemd unit for the monitor. |
| [runbooks/novi-heartbeat.sh](./runbooks/novi-heartbeat.sh) | Ops file | 2026-10-19 | The server heartbeat script (see "Dead-man's switch" in [controller-monitoring.md](./runbooks/controller-monitoring.md)). |
| [runbooks/novi-heartbeat.service](./runbooks/novi-heartbeat.service) | Ops file | 2026-10-19 | systemd unit for the heartbeat. |
| [runbooks/novi-heartbeat.timer](./runbooks/novi-heartbeat.timer) | Ops file | 2026-10-19 | systemd timer for the heartbeat. |

## Research

Background research behind the product.

| Document | Status | Last change | What it is |
|---|---|---|---|
| [research/RESEARCH_FINDINGS.md](./research/RESEARCH_FINDINGS.md) | Reference | 2026-09-18 | Source-checked research on giving AI agents a legal body. Legal points are directional: check them with counsel. |
| [research/STACK_REFERENCE.md](./research/STACK_REFERENCE.md) | Reference | 2026-10-21 | Circle and Arc engineering reference: networks and addresses (testnet and mainnet), wallets, Agent Wallets, x402, gotchas. |

## The legal model, in one line

A fully human-less ("Bayern", zero-member) entity is not possible: a named natural person in
control is required by the Wyoming DAO LLC statute, FinCEN's control test and Circle's terms. The
model is an accountable person (the guardian, verified with World ID or, where World ID has no
path, published as unverified) plus a bounded agent, which
is what the contracts implement. Where an older doc leads with the zero-member idea, read it as
the origin, not the product.
