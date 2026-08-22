# Runbook — deploying the doola formation provider

> Design: `back/docs/design/2026-08-19-doola-formation-provider-design.md` §2 (the pin), §5 (the
> doors), §7 (the sweeper).
> Webhook receiver: `docs/runbooks/doola-webhooks.md`.
> Code: `back/backend/src/formation.ts`, `back/backend/src/workflow/runner.ts`,
> `back/backend/src/api/main.ts`.

## The one sentence

**A bound formation party is always pinned and always filed. `FORMATION_REQUIRED` decides only
whether the door REFUSES an onboard that carries no party.**

This supersedes PR 2's decision #2, in which `FORMATION_REQUIRED=false` also meant "pin nothing".
That coupling had a hole: a caller who had posted a real legal identity and handed over its
`partyId` got an unpinned stub entity, and their party sat bound to an entity nothing would ever
file. The identity was silently dropped — which is exactly the failure
`formationUnavailableMessage` exists to prevent on a credential-less box.

## What each setting actually does

| `DOOLA_API_KEY` + `DOOLA_WEBHOOK_SECRET` | `FORMATION_REQUIRED` | Result |
|---|---|---|
| unset | (must be unset) | No formation anywhere. A `partyId` on an onboard is **refused**, never ignored. No webhook route, no sweeper. |
| set | `false` | Formation is **available, not mandatory**. An onboard with no `partyId` succeeds and files nothing. An onboard WITH a `partyId` is pinned and filed, and counts against the spend controls. |
| set | `true` (the default when the block is present) | An onboard **without** a `partyId` is refused at the door (REST 400 / MCP `isError`). The legacy onboarding server and `cli create-entity` refuse every request, because neither can carry a party. |

`ARC_NETWORK=mainnet` forces the block present and `FORMATION_REQUIRED=true`; a mainnet
deployment cannot mint stub entities, and it cannot point at doola sandbox.

## Deploy note — the testnet box

**Run `FORMATION_REQUIRED=false` on the testnet box until the PR-4 wizard collects a legal
identity.**

The wizard (`interface/`) does not send a `partyId` today. With `FORMATION_REQUIRED=true` the door
refuses every wizard onboard, so the box's only working onboarding surface would be MCP/REST with
a hand-created party. With `false`:

- the wizard keeps working exactly as it did before formation existed, and pins nothing;
- an MCP or REST caller can opt in by creating a party (`POST /formation-party` or the
  `create_formation_party` tool) and passing its handle — that entity IS pinned and IS filed, in
  the environment the box is configured for;
- the sandbox end-to-end can be exercised on demand without every test agent costing a filing.

Boot says so out loud, and this warning is the one to look for in journald after a deploy:

```
⚠ doola formation ENABLED (sandbox, required=false)
⚠ FORMATION_REQUIRED=false — formation is AVAILABLE, not mandatory: an onboard is only pinned
  and filed when it carries a partyId, and the wizard does not send one yet
```

Without the second line, an operator who expected every new entity to become a Wyoming LLC would
only find out from an empty `formation_requests` table a week later.

## Flipping it on

When PR 4 lands the identity step in the wizard:

1. confirm the wizard sends `partyId` on `POST /onboard` (the `/config` response already
   advertises `formationRequired`, and the wizard branches on it);
2. set `FORMATION_REQUIRED=true` and restart;
3. check the boot line no longer carries the second warning;
4. onboard one agent end-to-end and confirm `formation_requests` has four rows for it and
   `create_provider` reaches `confirmed`.

Nothing about entities already minted changes: the pin is stamped at the claim and is immutable
after (audit M5), so an entity minted while the flag was `false` — with or without a party — keeps
whatever it was pinned to, forever.

## Spend controls

`FORMATION_MAX_PER_TENANT` (default 3) and `FORMATION_DAILY_CEILING` (default 10) are checked at
the door, before the entity is claimed, **whenever the onboard carries a party** — on every
deployment, `required` or not. An opt-in filing costs the same $100–150 as a mandatory one.

Both counts include FAILED `create_provider` rows, deliberately: a create that failed after doola
committed has already cost a real company and a real fee.

## Boot ordering (C4)

The formation sweeper starts **after** the HTTP port is listening, and its first loop iteration is
the boot reconcile. Nothing about doola is on the boot path: a doola outage must never be able to
delay `/healthz`, because a load balancer would mark the box down and fail the deploy for a reason
unrelated to whether the process can serve requests.
