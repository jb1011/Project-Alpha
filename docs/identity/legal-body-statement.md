# Legal-body statements

Anyone can ask, with no account, whether an agent has a Novi legal body and what Novi states about it. The answer carries a statement built from chain reads made when it was signed, and signed by Novi's attestation key, so you can check it yourself instead of trusting the connection it came over.

This page covers legal bodies created by Novi's legal-body factory for an ERC-8004 agent whose owner brought an existing Wyoming LLC.

## What a statement says

A statement is about one legal body, one agent and one moment. It says:

* which legal body Novi's factory created, for which agent, in which identity registry, on which chain, and who owned the agent's identity when the body was created;
* whether the agent's identity points at that body now (`bindingState`);
* the agent's wallet, as the identity registry returns it, and whether that wallet, or that owner, holds contract code;
* the Wyoming LLC behind the body, once a Novi operator has checked it against the Wyoming registry: its name, its filing number, its formation date, and what an operator saw of its annual reports;
* the hash of the operating agreement frozen when the body was created;
* whether the guardian completed World ID verification;
* `standing`: what Novi states about the legal body as a whole.

Every chain fact in a statement is read at one block, `observedAtBlock`, which was no more than two minutes old when it was read. A statement expires 300 seconds after it is issued.

It does not say:

* who owns or manages the LLC, who its registered agent is, or its EIN;
* anything about money the agent holds, or limits on its spending;
* anything about what the agent does, or how well;
* that the LLC is in good standing with the state of Wyoming. An annual report counts as filed only when a Novi operator saw it on the registry.

It does not name the guardian: `identityOwnerAtCreation` is the identity's owner as the chain records it, which may be the guardian's own wallet.

## Standing

| Value | Meaning |
| --- | --- |
| `active` | Every fact holds: the body is active on chain, the agent's identity points at it, the agreement hash on chain is the frozen one, a Novi operator's check of the LLC passed, the legal body is paid for, nothing is revoked, and no annual report is more than 60 days past due without a recorded filing. |
| `pending` | Something to establish is still missing: the operator's check of the LLC has not passed (or must be made again), or the legal body is not paid for yet. |
| `unknown` | Novi cannot state `active` from what it holds: the agreement hash on chain differs from the frozen one, there is no formation date to count annual reports from, or a report is more than 60 days past due with no filing recorded. |
| `inactive` | A recorded fact says no: the body is winding down or dissolved, the agent's identity no longer points at it or changed hands, or Novi has revoked it. |

When several apply, `inactive` comes before `pending`, and `pending` before `unknown`. Missing evidence never reads `inactive`.

An answer whose chain read failed also says `unknown`, with no statement at all: see the answers below.

## Asking

Both routes are public: no account, no key, and any web page may call them (CORS `*`). They are served by the API of a Novi deployment.

### By agent

```text
GET /legal-bodies/by-agent/<agentId>
```

`agentId` is the agent's ERC-8004 token id in decimal: at most 78 digits, no leading zero, at most 2^256 - 1. Each answer below is a 200.

No legal body Novi states for this agent:

```json
{ "agentId": "42", "legalBody": false, "standing": null, "checkedAt": "2026-10-08T15:00:00.000Z" }
```

A statement, whatever its standing:

```json
{
  "agentId": "42",
  "legalBody": true,
  "standing": "active",
  "publicId": "…",
  "network": "testnet",
  "links": {
    "transparency": "https://…/transparency",
    "statement": "https://…/legal-bodies/by-agent/42"
  },
  "checkedAt": "2026-10-08T15:00:00.000Z",
  "statement": { "domain": { … }, "primaryType": "LegalBodyStatement", "message": { … }, "attestor": "0x…", "signature": "0x…" }
}
```

No statement could be made just now, because the chain could not be read:

```json
{
  "agentId": "42",
  "legalBody": true,
  "standing": "unknown",
  "publicId": null,
  "network": "testnet",
  "links": { "transparency": "https://…/transparency" },
  "checkedAt": "2026-10-08T15:00:00.000Z",
  "statement": null
}
```

`standing` is the statement's own. `checkedAt` is when the answer was made. A body the agent's identity no longer points at is still answered, as `inactive`, from the last time it was linked.

### By address

```text
GET /legal-bodies/<address>
```

`address` is all lower case or EIP-55. For a legal body on this page, the address must be the agent's wallet: the wallet the identity registry returns for the agent, read when you ask, and again at the block the statement is read at. The same route also answers for agents onboarded with a Novi treasury; those answers carry no statement. [The AgentKit integration guide](https://github.com/jb1011/Project-Alpha/blob/main/back/docs/integrations/agentkit-legal-body-check.md), in Novi's public repository, describes them: it shows a seller on World's AgentKit how to ask, in one call, whether a verified human vouches for an address and whether a Novi legal body stands behind it, and gives every answer of this route.

No legal body Novi states for this address:

```json
{ "address": "0x…", "legalBody": false, "standing": null, "checkedAt": "2026-10-08T15:00:00.000Z" }
```

A statement, whatever its standing:

```json
{
  "address": "0x…",
  "legalBody": true,
  "standing": "active",
  "agentId": "42",
  "publicId": "…",
  "name": "Example Holdings LLC",
  "network": "testnet",
  "links": {
    "transparency": "https://…/transparency",
    "metadata": null,
    "statement": "https://…/legal-bodies/by-agent/42"
  },
  "formation": null,
  "checkedAt": "2026-10-08T15:00:00.000Z",
  "statement": { … }
}
```

No statement could be made just now:

```json
{
  "address": "0x…",
  "legalBody": true,
  "standing": "unknown",
  "agentId": null,
  "publicId": null,
  "name": "",
  "network": "testnet",
  "links": { "transparency": "https://…/transparency", "metadata": null },
  "formation": null,
  "checkedAt": "2026-10-08T15:00:00.000Z",
  "statement": null
}
```

`name` is the statement's `legalName`, so it is empty unless the statement may show it. `links.metadata` and `formation` are always `null` here.

When more than one agent with a legal body has this address as its wallet, the answer prefers a statement that reads `active`.

A wallet that is not the identity's owner is found by address only once a statement has been made for that agent with that wallet, for example by a request by agent. If you know the agent id, ask by agent.

### Not a yes

`legalBody: true` with `statement: null` is not a yes, on either route. It says only that Novi holds a record that may be a legal body for this agent or address, which the chain could not confirm just now. Ask again later.

### Other answers

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ "error": "validation_error", "message": "…" }` | The agent id or the address is malformed. The message says what is expected. |
| 429 | `{ "error": "rate_limited", "message": "try again in a few seconds" }` | Too many requests: slow down. |
| 503 | `{ "error": "unavailable", "message": "could not check right now; try again shortly" }` | Novi's own database could not be read. A chain that cannot be read is never a 503: it is the `unknown` with `statement: null` above. |
| 404 | any | This deployment does not serve the route: by agent, it signs no statements; by address, it runs no lookup. |

Treat each of them as no answer: never as a no, and never as a yes.

Both routes share the same rate limits, one per client and one for all callers together. An answer served from memory (below) costs nothing.

### Freshness

* A 200 with a statement, whatever its standing (a statement that reads `unknown` included), and a 200 with `legalBody: false`, are remembered for 15 seconds and carry `Cache-Control: public, max-age=15`. Within those 15 seconds you get the same answer, with the same statement and signature.
* The `unknown` with `statement: null` is never remembered and carries `Cache-Control: no-store`: the next request reads the chain again. The 400, the 429 and the 503 carry `no-store` too.
* A statement lives 300 seconds: `expiresAt = issuedAt + 300`.
* A change, such as a revocation, shows in Novi's answers within 15 seconds. A cache between you and Novi can hold the earlier answer for up to 15 seconds more. A statement signed before the change still verifies until it expires, so check `expiresAt`, and ask again when you need the current answer.

### The transparency list

On a deployment that serves statements, the API's `GET /transparency` also lists, under `legalBodies`, each linked legal body whose statement would read `active`, with its name, its filing number and `links.statement`. `stats.legalBodies` counts them. When the chain could not be read, the list is empty and `legalBodiesAvailable` is `false`. The list is not signed and can be a few seconds old; a body linked moments ago is listed once the binding check has recorded the link. Follow `links.statement` for a signed, current answer.

## The signed statement

The `statement` of an answer is EIP-712 typed data in JSON, with the signer's address and the signature:

```json
{
  "domain": { "name": "Novi Corpus Attestation", "version": "2", "chainId": 5042002 },
  "primaryType": "LegalBodyStatement",
  "message": {
    "chainId": "5042002",
    "identityRegistry": "0x…",
    "factory": "0x…",
    "legalBody": "0x…",
    "agentId": "42",
    "agentWallet": "0x…",
    "identityOwnerAtCreation": "0x…",
    "bindingState": "linked",
    "identityOwnerIsContract": false,
    "agentWalletIsContract": false,
    "standing": "active",
    "attestationState": "active",
    "jurisdiction": "WY",
    "entityType": "LLC",
    "legalName": "Example Holdings LLC",
    "filingNumber": "TEST-0001",
    "source": "customer",
    "environment": "sandbox",
    "controlVerified": true,
    "existenceCheckedAt": "1790780400",
    "filedAt": "2026-03-10",
    "einIssued": false,
    "filingStatus": "not_yet_due",
    "lastFiledPeriod": "0",
    "lastFiledAt": "",
    "lastFiledConfirmedBy": "",
    "nextDue": "2027-03-01",
    "oaManifestHash": "0x…",
    "oaManifestVersion": "1",
    "guardianHumanVerified": true,
    "observedAtBlock": "31415926",
    "issuedAt": "1791471600",
    "expiresAt": "1791471900"
  },
  "attestor": "0x…",
  "signature": "0x…"
}
```

`attestor` is the address the answer says signed. Never verify against it: take the attestor from ENS (see [How to verify](#how-to-verify)).

The domain, with no `verifyingContract`:

```text
{ name: "Novi Corpus Attestation", version: "2", chainId }
```

`chainId` is the chain the legal body is on. In the JSON `domain` it is a number.

The primary type is `LegalBodyStatement`, one flat struct of 33 fields in this order:

```text
LegalBodyStatement(uint256 chainId,address identityRegistry,address factory,address legalBody,uint256 agentId,address agentWallet,address identityOwnerAtCreation,string bindingState,bool identityOwnerIsContract,bool agentWalletIsContract,string standing,string attestationState,string jurisdiction,string entityType,string legalName,string filingNumber,string source,string environment,bool controlVerified,uint256 existenceCheckedAt,string filedAt,bool einIssued,string filingStatus,uint256 lastFiledPeriod,string lastFiledAt,string lastFiledConfirmedBy,string nextDue,bytes32 oaManifestHash,uint256 oaManifestVersion,bool guardianHumanVerified,uint256 observedAtBlock,uint256 issuedAt,uint256 expiresAt)
```

In the JSON `message`, every `uint256` is a decimal string with no leading zero, addresses are in EIP-55 form, the `bytes32` is lower-case hex starting `0x`, booleans are JSON booleans, and dates are `YYYY-MM-DD` or `""`. Dates are Wyoming calendar dates (time zone America/Denver).

A field that can be absent then holds a value it can never really take: the zero address, `""` or `0`. A boolean has no such value: `false` means "not established".

| Field | Meaning | When absent |
| --- | --- | --- |
| `chainId` | The chain the legal body is on. The domain names it too. | |
| `identityRegistry` | The ERC-8004 identity registry the agent is in. | |
| `factory` | Novi's legal-body factory, which created the body. | |
| `legalBody` | The legal body's address. | |
| `agentId` | The agent's ERC-8004 token id. | |
| `agentWallet` | The agent's wallet, as the identity registry returns it at `observedAtBlock`. | the zero address |
| `identityOwnerAtCreation` | Who owned the agent's identity when the body was created, as the factory recorded it. While `bindingState` is `linked`, that address still owns it: the factory links a body only while the identity belongs to the body's creator. | |
| `bindingState` | `linked` when the factory names this body as the agent's legal body at `observedAtBlock`. `broken` otherwise: the pointer was cleared or moved, the identity changed hands, or the body is winding down or dissolved. | |
| `identityOwnerIsContract` | `identityOwnerAtCreation` holds contract code at `observedAtBlock`. See [Contract accounts](#contract-accounts). | `false` |
| `agentWalletIsContract` | The same for `agentWallet`. | `false` |
| `standing` | `pending`, `active`, `unknown` or `inactive`: see [Standing](#standing). | |
| `attestationState` | Novi's own record of the LLC: `active` when an operator's check passed and the legal body is paid for, `revoked` when Novi revoked the legal body or its check of the LLC, `pending` otherwise. | |
| `jurisdiction` | `WY`. | |
| `entityType` | `LLC`. | |
| `legalName` | The LLC's name, as declared to Novi and checked by an operator against the Wyoming registry. Shown only while that check stands, the binding is `linked` and nothing is revoked. | `""` |
| `filingNumber` | The LLC's Wyoming filing number, on the same rule. | `""` |
| `source` | `customer`: the owner brought an existing LLC. `novi`, for an LLC Novi formed, is in no statement today. | |
| `environment` | `production` on a mainnet deployment, `sandbox` otherwise. A sandbox statement comes from a test deployment. | |
| `controlVerified` | An operator saw evidence that the person who declared the LLC to Novi controls it. | `false` |
| `existenceCheckedAt` | When the operator's check that established the LLC was made, in unix seconds. | `0` |
| `filedAt` | The LLC's formation date. | `""` |
| `einIssued` | Always `false`: Novi does not check an EIN for an LLC its owner brought. | `false` |
| `filingStatus` | `not_yet_due`: no annual report has come due. `filed`: a report recorded at the check covers the last one due. `past_due_unverified`: a report came due and no recorded report covers it (it may have been filed; nobody has confirmed it). `unverified`: there is no formation date to count from. | |
| `lastFiledPeriod` | The report year of the last annual report recorded at the operator's check. A year that cannot be one of this LLC's report years is ignored. | `0` |
| `lastFiledAt` | The date that report was filed, when it was recorded. | `""` |
| `lastFiledConfirmedBy` | `operator` when a Novi operator saw that report on the registry. | `""` |
| `nextDue` | The next annual report's due date: reports are due on the first day of the formation month, every year from the year after formation. A report due today is not yet late. | `""` |
| `oaManifestHash` | The hash of the operating agreement frozen when the body was created. The agreement hash on chain must equal it, or `standing` is `unknown`. | |
| `oaManifestVersion` | The version of that agreement. | |
| `guardianHumanVerified` | The guardian completed World ID verification at a level Novi accepts (a waiver does not count). It never says who. | `false` |
| `observedAtBlock` | The block every chain fact above was read at. | |
| `issuedAt` | When the statement was signed, in unix seconds. | |
| `expiresAt` | `issuedAt + 300`. | |

On a sandbox deployment (`environment: "sandbox"`), `guardianHumanVerified` can rest on a World ID verification made in a test environment.

## How to verify

1. **Take the attestor from ENS, never from the answer.** Read the text record `com.novicorpus.attestor` of `novicorpus.eth` (on Ethereum Sepolia, see [ENS names](ens.md)). Its value is CAIP-10, `eip155:<chainId>:<address>`: check that the chain id is the chain you expect statements for. An empty record means the deployment publishes no attestor. The record is served by Novi's gateway and signed by its key, so it is a convenience and not a source independent of Novi's servers.
2. **Check what the statement is about.** `primaryType` is `LegalBodyStatement`. The domain is exactly the one above, with your chain id and no `verifyingContract`. `message.chainId` is the same chain, `message.factory` is the legal-body factory you pin for that deployment, and `message.identityRegistry` is the registry you expect. Asked by agent, `message.agentId` is your agent; asked by address, `message.agentWallet` is your address.
3. **Check the time.** `issuedAt <= now <= expiresAt`, and `expiresAt - issuedAt` is 300.
4. **Check the signature with plain ECDSA.** Recover the signer of the EIP-712 hash and compare it with the attestor from step 1. The attestor is a key, not a contract.

Only a statement that passes all four says anything. The `statement` of either route is checked the same way.

With [viem](https://viem.sh), whose `verifyTypedData` takes the served `message` as it is, decimal strings included:

```ts
import { type Address, type Hex, isAddressEqual, verifyTypedData } from "viem";

/** The type string above, verbatim. */
const TYPE =
  "LegalBodyStatement(uint256 chainId,address identityRegistry,address factory,address legalBody,uint256 agentId,address agentWallet,address identityOwnerAtCreation,string bindingState,bool identityOwnerIsContract,bool agentWalletIsContract,string standing,string attestationState,string jurisdiction,string entityType,string legalName,string filingNumber,string source,string environment,bool controlVerified,uint256 existenceCheckedAt,string filedAt,bool einIssued,string filingStatus,uint256 lastFiledPeriod,string lastFiledAt,string lastFiledConfirmedBy,string nextDue,bytes32 oaManifestHash,uint256 oaManifestVersion,bool guardianHumanVerified,uint256 observedAtBlock,uint256 issuedAt,uint256 expiresAt)";

/** Its 33 fields, in order: what viem hashes. */
const FIELDS = TYPE.slice(TYPE.indexOf("(") + 1, -1)
  .split(",")
  .map((field) => {
    const [type, name] = field.split(" ") as [string, string];
    return { name, type };
  });

interface SignedStatement {
  domain: Record<string, unknown>;
  primaryType: string;
  message: Record<string, string | boolean>;
  signature: Hex;
}

/** True only for a statement signed by `attestor`, about your chain, factory and identity
 *  registry, not expired. */
async function isValidStatement(
  s: SignedStatement,
  expected: { attestor: Address; chainId: number; factory: Address; identityRegistry: Address },
): Promise<boolean> {
  const domain = { name: "Novi Corpus Attestation", version: "2", chainId: expected.chainId };
  try {
    const d = s.domain;
    const m = s.message;
    if (s.primaryType !== "LegalBodyStatement") return false;
    if (Object.keys(d).length !== 3) return false;
    if (d.name !== domain.name || d.version !== domain.version || d.chainId !== domain.chainId)
      return false;
    if (m.chainId !== String(expected.chainId)) return false;
    if (!isAddressEqual(m.factory as Address, expected.factory)) return false;
    if (!isAddressEqual(m.identityRegistry as Address, expected.identityRegistry)) return false;
    const issuedAt = BigInt(m.issuedAt as string);
    const expiresAt = BigInt(m.expiresAt as string);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < issuedAt || now > expiresAt || expiresAt - issuedAt !== 300n) return false;
    // Your own domain, never the served one.
    return await verifyTypedData({
      address: expected.attestor,
      domain,
      types: { LegalBodyStatement: FIELDS },
      primaryType: "LegalBodyStatement",
      message: m,
      signature: s.signature,
    });
  } catch {
    return false;
  }
}
```

And the attestor, the answer and the checks:

```ts
import { createPublicClient, http, isAddress } from "viem";
import { sepolia } from "viem/chains";

const API = "https://…"; // the API of the Novi deployment you ask
const CHAIN_ID = 5042002; // the chain you expect statements for: Arc testnet here
const FACTORY: Address = "0x…"; // the legal-body factory you pin for that deployment
const IDENTITY_REGISTRY: Address = "0x…"; // the ERC-8004 identity registry you expect the agent in
const AGENT_ID = "42";

// 1. The attestor, from ENS: Novi's gateway answers it through CCIP-Read.
const ens = createPublicClient({ chain: sepolia, transport: http() });
const record = await ens.getEnsText({ name: "novicorpus.eth", key: "com.novicorpus.attestor" });
const [namespace, chainId, attestor] = (record ?? "").split(":");
if (namespace !== "eip155" || chainId !== String(CHAIN_ID) || !attestor || !isAddress(attestor))
  throw new Error("no attestor published for this chain");

// 2. The answer.
const response = await fetch(`${API}/legal-bodies/by-agent/${AGENT_ID}`);
const answer = (await response.json()) as { statement: SignedStatement | null };
if (answer.statement === null) throw new Error("no statement just now: ask again later");

// 3. The checks, then what it says.
const valid =
  answer.statement.message.agentId === AGENT_ID &&
  (await isValidStatement(answer.statement, {
    attestor,
    chainId: CHAIN_ID,
    factory: FACTORY,
    identityRegistry: IDENTITY_REGISTRY,
  }));
if (!valid) throw new Error("not a valid statement");
console.log(answer.statement.message.standing);
```

A signature covers values, not how they are written: viem also accepts `"042"` for agent 42, or an address in lower case, under the same signature. So one signature can verify over more than one text: never use the text of a message as its identity. The reference verifier, `verifyPublicStatement` in [publicStatement.ts](https://github.com/jb1011/Project-Alpha/blob/main/back/backend/src/legalBody/publicStatement.ts), in Novi's public repository, refuses every spelling but the one the answers use. It also accepts only the canonical signature, the form the answers carry: a low `s` (at most half the order of secp256k1) and `v` 27 or 28.

## Contract accounts

When `identityOwnerIsContract` or `agentWalletIsContract` is `true`, verify that address's signatures with ERC-1271, not `ecrecover`. Who controls a contract account can change without any transfer on the identity registry. The statement says nothing about any spending limits on it.

An address whose only code is an EIP-7702 delegation does not count as a contract: its own key still signs, with plain ECDSA, so its flag is `false`.

## What you may say

When a statement you verified reads `active`, say:

> a registered legal body stands behind this address, and Novi states its standing as active

(asked by agent: "this agent"). Show `pending`, `unknown` and `inactive` as they are, and say that a `sandbox` statement is a test. Never "verified company", "KYC", "licensed", "human-backed" or "good standing".

## Attestors

Each deployment's attestor address is listed here once it is published. None is listed yet: take the attestor from the ENS record (step 1 of [How to verify](#how-to-verify)).
