# ENS Integration — Complete Build Reference (offline-capable)

**Scope:** `<publicId>.novicorpus.eth` wildcard CCIP-read names on **Sepolia**, ENSIP-25 bidirectional binding to our ERC-8004 registry on Arc, ENSIP-26 agent records.
**Verified:** 2026-07-24 against docs.ens.domains, ensdomains/offchain-resolver@`099b7e9`, ensjs 4.3.1 (npm tarball), ethereum/ERCs (erc-3668, erc-7930), ensdomains/ensips@master, the live Sepolia controller, and viem 2.52.2 (the version in `back/backend/node_modules`).
**⚠ Read section 9 first if you've internalized `technical-blueprints.md` §3 — one significant correction (names register UNWRAPPED, not wrapped).**

---

## 1. Build sequence checklist (with time estimates)

| # | Step | Est. | Depends on |
|---|------|------|-----------|
| 0 | Sepolia ETH faucet to a fresh "ENS manager" key (needs ~0.02 ETH; 1-yr registration base price is **0.003125 ETH**, live-read 2026-07-24) | 10 min | — |
| 1 | Register `novicorpus.eth` via ensjs script (§2). **Commit is only valid 60 s – 24 h — commit and register in one sitting.** `available("novicorpus")` was `true` on 2026-07-24. | 30 min | 0 |
| 2 | Vendor + deploy `OffchainResolver` via our Foundry (§3); constructor = gateway URL template + `[signerAddress]` | 45 min | 0 |
| 3 | Unit-test the TS signing digest against the deployed contract's `makeSignatureHash()` view **before writing the gateway** (§4.4) | 30 min | 2 |
| 4 | `setResolver` on `novicorpus.eth` → resolver address (§2.3 — `contract: 'registry'`, see §9) | 10 min | 1,2 |
| 5 | Hono gateway route `/ensgateway/...` on our backend (§4) + CORS line in `app.ts` | 3–4 h | 3 |
| 6 | Smoke test gateway **through the Vercel proxy** (it has stripped headers before). If broken: VPS-direct TLS URL + redeploy resolver (2 min, constructor arg) | 30 min | 5 |
| 7 | Records wiring: repo/adapter lookups for every record in §5 | 2 h | 5 |
| 8 | ENSIP-25 on-chain half: `arcAdapter.setAgentMetadata` + backfill script `setMetadata(id,"ens",name)` (pre-validated with `cast` per README checklist item 4) + `renderMetadata` additions | 1–2 h | — |
| 9 | Layer-by-layer test matrix (§7): cast revert → curl → viem full loop → manager app | 1 h | 5–8 |
| 10 | `resolve_agent(name)` MCP tool (runs verification steps 1–4 of the booth walkthrough) | 1 h | 7 |
| 11 | Polish: avatar, `agent-context`, demo video (functional demo, **no hard-coded values** — explicit judging rule), booth prep | 2–3 h | all |

Total: ~12–16 h. Steps 1+2+3 are the night-0 de-risk set.

---

## 2. Name registration (Sepolia, ensjs 4.3.1)

> **⚠️ 2026-07-24 FIELD CORRECTION — this whole ensjs-4.3.1 registration path is BROKEN on live Sepolia.**
> ENS rotated the Sepolia registrar controllers. ensjs 4.3.1 AND the ENS wiki both name
> `0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968` as the ETHRegistrarController, but on-chain it is
> **no longer an authorized controller** on the BaseRegistrar `0x57f1887a…` — `register()` reverts
> with empty data (message-less `require(controllers[msg.sender])` inside `base.register`). Verified via
> local trace. The BaseRegistrar's 5 currently-authorized controllers are
> `0xdf60C561Ca35AD3C89D24BbA854654b1c3477078` (the only one with a `register()` fn — but a NEW ABI:
> `rentPrice`/`commit`/`makeCommitment` all revert with the old signatures), plus `0x802453f2…`,
> `0xB359d7d0…`, `0x1BE516Ae…`, `0x6F4Bf58A…`. The `@ensdomains/ensjs@5.0.0-sepolia-fix.1` pre-release
> points at `0x253553366…` which has **no code on Sepolia** (it's the mainnet controller). So there is
> no working programmatic path via ensjs today.
>
> **✅ SOLVED (programmatic V2 path) — see `scripts/ens-register-v2.mts`.** ENS V2 registration is now
> **single-step, no commit-reveal** (confirmed by on-chain trace). Call `register(registration)` on the V2
> controller **`0xdf60C561Ca35AD3C89D24BbA854654b1c3477078`** with the same struct
> `(string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8
> reverseRecord, bytes32 referrer)` — `secret` can be `0x0`, pass OUR resolver in `resolver`, payable
> (over-send, excess refunded; testnet price ~0). One tx, done. **CRITICAL WIN: V2 writes through to the
> classic ENS Registry `0x0000…2e1e`** — after registering, `registry.owner(node)` and
> `registry.resolver(node)` both reflect our values, so viem/UniversalResolver + ENSIP-10 wildcard + CCIP
> resolve normally. **`novicorpus.eth` REGISTERED 2026-07-24** (owner `0x8ffA…6e2f`, resolver
> `0x50968D0D84fc491c11cedA2999C5eF5Aa1D66473`); wildcard subname `resolve()` reverts `OffchainLookup`
> pointing at our gateway URL — verified. The old ensjs-4.3.1 commit-reveal path (below) is dead; use the
> V2 script. (Browser fallback if ever needed: the ENS V2 app at **app.ens.dev**, verified official.)


### 2.0 Ground truth (all live-verified 2026-07-24)

**Sepolia addresses** (docs.ens.domains/learn/deployments **and** ensjs 4.3.1 `dist/contracts/consts.js` — both agree):

| Contract | Address |
|---|---|
| ENS Registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| ETHRegistrarController (current, **2025 "unwrapped" controller**) | `0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968` |
| BaseRegistrar | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` |
| PublicResolver (current) | `0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5` |
| NameWrapper | `0x0635513f179D50A207757E05759CbD106d7dFcE8` |
| UniversalResolver | `0xeEeEeEeE14D718C2B47D9923Deab1335E144EeEe` (same address on mainnet; already in viem 2.52.2's `sepolia.contracts.ensUniversalResolver`) |
| L1 ReverseRegistrar | `0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6` |
| DefaultReverseRegistrar | `0x4F382928805ba0e23B30cFB75fC9E848e82DFD47` |
| legacy wrapped controller (do **not** use) | `0x4477cAc137F3353Ca35060E01E5aEb777a1Ca01B` |
| legacy controller (pre-wrapper) | `0x7e02892cfc2Bfd53a75275451d73cF620e793fc0` |

**Live controller parameters** (read from `0xfb3c…` on 2026-07-24):
- `minCommitmentAge()` = **60** s
- `maxCommitmentAge()` = **86400** s (24 h — a commit older than a day is dead; recommit)
- `MIN_REGISTRATION_DURATION()` = **2419200** s (28 days)
- `rentPrice("novicorpus", 31536000)` = `(base: 3125000000003490 wei ≈ 0.003125 ETH, premium: 0)`
- `available("novicorpus")` = `true`

**Install:** `npm i @ensdomains/ensjs@4.3.1` (peer: `viem ^2.35.0` — our backend has 2.52.2 ✔).

### 2.1 Commit + register script (runnable)

ensjs 4.3.1 `RegistrationParameters` (verified from the published tarball, `dist/utils/registerHelpers.d.ts`):

```ts
type RegistrationParameters = {
  name: string
  owner: Address
  duration: number            // seconds, min 2419200
  secret: Hex                 // random 32 bytes — use randomSecret()
  resolverAddress?: Address   // defaults to current PublicResolver
  records?: RecordOptions     // { texts?, coins?, contentHash?, abi?, clearRecords? }
  reverseRecord?: 0 | 1 | 2   // enum ReverseRecordParameter: None=0, Ethereum=1, Default=2  (NOT a boolean)
  referrer?: Hex              // bytes32, defaults to zero
}
// registerName additionally requires: value: bigint
```

**There is NO `fuses` / `ownerControlledFuses` parameter in 4.3.1.** The controller call is
`register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer))` — names come out **unwrapped** (owner = your EOA directly in the registry/BaseRegistrar; NameWrapper is not involved). See §9.

```ts
// scripts/registerEnsName.ts  (run with tsx; env: ENS_MANAGER_KEY, SEPOLIA_RPC)
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { addEnsContracts } from '@ensdomains/ensjs'
import { getPrice } from '@ensdomains/ensjs/public'
import { randomSecret } from '@ensdomains/ensjs/utils'
import { commitName, registerName } from '@ensdomains/ensjs/wallet'

const chain = addEnsContracts(sepolia)
const account = privateKeyToAccount(process.env.ENS_MANAGER_KEY as `0x${string}`)
const client = createPublicClient({ chain, transport: http(process.env.SEPOLIA_RPC) })
const wallet = createWalletClient({ chain, transport: http(process.env.SEPOLIA_RPC), account })

const secret = randomSecret()
console.log('SECRET (save until registered):', secret)
const params = {
  name: 'novicorpus.eth',
  owner: account.address,
  duration: 31536000, // 1 year
  secret,
}

const commitTx = await commitName(wallet, params)
await client.waitForTransactionReceipt({ hash: commitTx })
console.log('committed, waiting 75s (min age 60s, max age 24h)...')
await new Promise((r) => setTimeout(r, 75_000))

const { base, premium } = await getPrice(client, { nameOrNames: params.name, duration: params.duration })
const value = ((base + premium) * 110n) / 100n // +10% buffer; excess refunded by controller
const registerTx = await registerName(wallet, { ...params, value })
await client.waitForTransactionReceipt({ hash: registerTx })
console.log('registered:', registerTx)
```

Keep registration + resolver-setting on **one key** (this `account`). If `registerName` reverts: commitment too new (<60 s), too old (>24 h), wrong `secret`/params (commitment hash covers ALL of `{label,owner,duration,secret,resolver,data,reverseRecord,referrer}` — pass the *identical* params object to both calls), or insufficient `value`.

### 2.2 Optional mainnet `novicorpus.eth`

Same script with `mainnet` + `addEnsContracts(mainnet)`. ~$5/yr (5+ chars) + gas. Buys wallet/Etherscan resolution at the booth. Same resolver contract + same gateway work unchanged (deploy a second `OffchainResolver` on mainnet pointing at the same gateway URL).

### 2.3 setResolver

Freshly registered names are **unwrapped** → the registry owns the record → `contract: 'registry'`:

```ts
import { setResolver } from '@ensdomains/ensjs/wallet'
import { getOwner } from '@ensdomains/ensjs/public'

// Sanity check first (robust either way):
const owner = await getOwner(client, { name: 'novicorpus.eth' })
// unwrapped: { registrant: <you>, owner: <you>, ownershipLevel: 'registrar' }
// wrapped:   { owner: <you>, ownershipLevel: 'nameWrapper' }
const contract = owner?.ownershipLevel === 'nameWrapper' ? 'nameWrapper' : 'registry'

const tx = await setResolver(wallet, {
  name: 'novicorpus.eth',
  contract,                                   // 'registry' for our fresh registration
  resolverAddress: OFFCHAIN_RESOLVER_ADDRESS, // from §3 deploy
})
```

ensjs 4.3.1 `SetResolverDataParameters.contract` is exactly `'registry' | 'nameWrapper'` (verified in published d.ts). Setting the resolver on the **parent** makes ENSIP-10 wildcard resolution serve every `*.novicorpus.eth` with zero per-agent txs — and also answers queries for the apex `novicorpus.eth` itself (gateway must handle both, §4.6).

### 2.4 Reading records back

```ts
import { getRecords } from '@ensdomains/ensjs/public'
const result = await getRecords(client, {
  name: 'e81ca24a-….novicorpus.eth',
  texts: ['description', 'legal-status', 'agent-endpoint[mcp]'],
  coins: ['eth', '2152525650'],   // 60 and the Arc-testnet coinType (string or number OK)
})
// { texts:[{key,value}...], coins:[{id:60,name:'ETH',value:'0x…'},{id:2152525650,...}], ... }
```

Or plain viem (no ensjs) — viem's `sepolia` chain already has the UniversalResolver:

```ts
import { normalize } from 'viem/ens'
const addr = await client.getEnsAddress({ name: normalize(name) })                  // coinType 60
const arc  = await client.getEnsAddress({ name: normalize(name), coinType: 2152525650n })
const txt  = await client.getEnsText({ name: normalize(name), key: 'legal-status' })
// optional overrides: universalResolverAddress, gatewayUrls: ['https://…'], strict: true
```

`strict: true` propagates resolution errors instead of returning `null` — turn it on while debugging.

---

## 3. Resolver contract

### 3.1 Source (verbatim)

From `github.com/ensdomains/offchain-resolver`, commit **`099b7e9827899efcf064e71b7125f7b4fc2e342f`** (main HEAD, 2024-02-03), path `packages/contracts/contracts/`. Vendor into our Foundry root at `back/src/ens/`. **One permitted edit** (flagged inline): the `SupportsInterface` import path — upstream pulls it from `@ensdomains/ens-contracts@^0.0.8`; we vendor those 2 tiny files instead (§3.2) so no new dependency enters `lib/`.

`back/src/ens/OffchainResolver.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./SupportsInterface.sol"; // EDIT: upstream = "@ensdomains/ens-contracts/contracts/resolvers/SupportsInterface.sol"
import "./IExtendedResolver.sol";
import "./SignatureVerifier.sol";

interface IResolverService {
    function resolve(bytes calldata name, bytes calldata data) external view returns(bytes memory result, uint64 expires, bytes memory sig);
}

/**
 * Implements an ENS resolver that directs all queries to a CCIP read gateway.
 * Callers must implement EIP 3668 and ENSIP 10.
 */
contract OffchainResolver is IExtendedResolver, SupportsInterface {
    string public url;
    mapping(address=>bool) public signers;

    event NewSigners(address[] signers);
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);

    constructor(string memory _url, address[] memory _signers) {
        url = _url;
        for(uint i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
        }
        emit NewSigners(_signers);
    }

    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result) external pure returns(bytes32) {
        return SignatureVerifier.makeSignatureHash(target, expires, request, result);
    }

    /**
     * Resolves a name, as specified by ENSIP 10.
     * @param name The DNS-encoded name to resolve.
     * @param data The ABI encoded data for the underlying resolution function (Eg, addr(bytes32), text(bytes32,string), etc).
     * @return The return data, ABI encoded identically to the underlying function.
     */
    function resolve(bytes calldata name, bytes calldata data) external override view returns(bytes memory) {
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(
            address(this),
            urls,
            callData,
            OffchainResolver.resolveWithProof.selector,
            abi.encode(callData, address(this))
        );
    }

    /**
     * Callback used by CCIP read compatible clients to verify and parse the response.
     */
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns(bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(
            signers[signer],
            "SignatureVerifier: Invalid sigature");
        return result;
    }

    function supportsInterface(bytes4 interfaceID) public pure override returns(bool) {
        return interfaceID == type(IExtendedResolver).interfaceId || super.supportsInterface(interfaceID);
    }
}
```

Yes, the revert string really is misspelled **"Invalid sigature"** upstream — grep for that exact string when debugging.

`back/src/ens/SignatureVerifier.sol` (verbatim, zero edits — OZ import matches our existing remapping `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`):

```solidity
// SPDX-License-Identifier: MIT

pragma solidity ^0.8.4;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library SignatureVerifier {
    /**
     * @dev Generates a hash for signing/verifying.
     * @param target: The address the signature is for.
     * @param request: The original request that was sent.
     * @param result: The `result` field of the response (not including the signature part).
     */
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result) internal pure returns(bytes32) {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    /**
     * @dev Verifies a signed message returned from a callback.
     * @param request: The original request that was sent.
     * @param response: An ABI encoded tuple of `(bytes result, uint64 expires, bytes sig)`, where `result` is the data to return
     *        to the caller, and `sig` is the (r,s,v) encoded message signature.
     * @return signer: The address that signed this message.
     * @return result: The `result` decoded from `response`.
     */
    function verify(bytes calldata request, bytes calldata response) internal view returns(address, bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        (bytes memory extraData, address sender) = abi.decode(request, (bytes, address));
        address signer = ECDSA.recover(makeSignatureHash(sender, expires, extraData, result), sig);
        require(
            expires >= block.timestamp,
            "SignatureVerifier: Signature expired");
        return (signer, result);
    }
}
```

`back/src/ens/IExtendedResolver.sol` (verbatim):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

interface IExtendedResolver {
    function resolve(bytes memory name, bytes memory data) external view returns(bytes memory);
}
```

### 3.2 Vendored dependency (from `@ensdomains/ens-contracts` v0.0.8, verbatim)

`back/src/ens/ISupportsInterface.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

interface ISupportsInterface {
    function supportsInterface(bytes4 interfaceID) external pure returns(bool);
}
```

`back/src/ens/SupportsInterface.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./ISupportsInterface.sol";

abstract contract SupportsInterface is ISupportsInterface {
    function supportsInterface(bytes4 interfaceID) virtual override public pure returns(bool) {
        return interfaceID == type(ISupportsInterface).interfaceId;
    }
}
```

**OZ compatibility:** our `lib/openzeppelin-contracts` is pinned v5.1.0 (CI installs it). `ECDSA.recover(bytes32, bytes)` exists identically in OZ 5.x; the only behavioral difference vs the 4.x upstream built against is that invalid signatures revert with custom errors (`ECDSAInvalidSignature…`) instead of strings — irrelevant to correctness. Compiles clean under our `solc 0.8.24` / `via_ir` / `evm_version = "paris"` profile (paris bytecode runs fine on Sepolia).

### 3.3 Ownership / admin — what the blueprint glossed over

`OffchainResolver` has **no owner, no setters**: `url` and `signers` are constructor-fixed forever. No Ownable, no upgrade path. Rotating the gateway URL or signer = **redeploy + `setResolver` again** (2 quick txs — this is the documented fallback for proxy trouble, and why the deploy must be scripted, not artisanal). Deployer address is irrelevant afterwards; any funded key works.

### 3.4 Deploy commands

```bash
cd /home/mbarr/Project-Alpha/back
export SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com   # or your provider
export ENS_MANAGER_KEY=0x…                                       # same key that registered the name (funds only; not the record signer)

forge build   # remember: fresh clones need lib/ restored (see back-snapshot-foundry-lib-gap memory)

forge create src/ens/OffchainResolver.sol:OffchainResolver \
  --rpc-url "$SEPOLIA_RPC" --private-key "$ENS_MANAGER_KEY" --broadcast \
  --constructor-args \
    "https://project-alpha-pi.vercel.app/backend/ensgateway/{sender}/{data}.json" \
    "[0x<GATEWAY_SIGNER_ADDRESS>]"
```

- URL template MUST contain literal `{sender}` and `{data}` (clients substitute them; `{data}` present ⇒ clients use GET — §4.1).
- `GATEWAY_SIGNER_ADDRESS` = address of a **fresh EOA whose key lives only in the VPS `.env`** (`ENS_GATEWAY_SIGNER_KEY`). It never holds funds; it only signs response digests.
- Multiple signers allowed (array) — deploy with both a primary and a backup signer to allow key rotation without redeploy.
- Verify (optional, nice for judges): `forge verify-contract <addr> src/ens/OffchainResolver.sol:OffchainResolver --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY --constructor-args $(cast abi-encode "constructor(string,address[])" "<url>" "[<signer>]")`.

Post-deploy sanity: `cast call <RESOLVER> "supportsInterface(bytes4)(bool)" 0x9061b923 --rpc-url $SEPOLIA_RPC` → `true` (ENSIP-10 interface id), and `cast call <RESOLVER> "url()(string)"` → your template.

---

## 4. Gateway — CCIP-Read wire protocol + our Hono implementation

### 4.1 EIP-3668 wire protocol (complete, from the final ERC text)

**Revert ABI** (error selector `0x556f1830`):

```solidity
error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)
```

- `sender` — the resolver's own address. Clients MUST verify it equals the contract they called (bubbled-up reverts from nested calls are rejected).
- `urls` — URL **templates**, tried in order of priority. May contain `{sender}` and `{data}`. Substitution: `sender` → **lowercase** 0x-hex address; `data` → 0x-hex `callData`.
- `callData` — opaque to the client. For OffchainResolver it is `abi.encodeWithSelector(0x9061b923 /* resolve(bytes,bytes) */, dnsEncodedName, innerCall)`.
- `callbackFunction` — 4-byte selector called in step 3. Here `resolveWithProof(bytes,bytes)` = `0xf4d4d2f8`.
- `extraData` — opaque, returned unmodified to the callback. Here `abi.encode(callData, resolverAddress)`.

**GET vs POST (spec-exact):**
- Template **contains `{data}`** ⇒ client MUST send **GET** to the substituted URL. (Ours: `…/ensgateway/{sender}/{data}.json` ⇒ GET.)
- Template **lacks `{data}`** ⇒ client MUST send **POST**, `Content-Type: application/json`, body `{"data": "0x…callData", "sender": "0x…"}`.
- Clients MUST support both; gateways may implement either or both. URL practical limit ~2 KB ⇒ GET is fine for us (resolve calldata for a text() lookup ≈ 300–500 bytes hex).

**Success response** — HTTP 200, `Content-Type: application/json`, body:

```json
{ "data": "0x<hex result bytes>" }
```

**Error responses** — proper status codes; if `Content-Type: application/json`, body `{"message": "human-readable"}`. Clients MUST NOT parse non-JSON error bodies as JSON.

**Client retry/error semantics** (normative):
- **4xx** → client returns an error to the caller and **stops** (no other URL is tried). ⇒ a gateway 404/400 kills resolution immediately.
- **5xx** → client tries the **next URL** in `urls`; stops when the list is exhausted.
- After a 200, the client re-calls the contract as `callbackFunction(response, extraData)`; the contract may revert `OffchainLookup` again (nested lookups). Clients MUST cap redirects; the cap SHOULD be ≥ 4.

**Client implementations:**
- **viem** (ours, 2.52.2): follows OffchainLookup automatically inside `eth_call` (`client.ccipRead` — set `ccipRead: false` on the client to disable). ENS actions (`getEnsAddress`/`getEnsText`/`getEnsAvatar`) call the **UniversalResolver**, which wraps the per-name resolver's OffchainLookup in its own; override points: `universalResolverAddress`, `gatewayUrls` (overrides the resolver-provided URL list — handy to point at localhost during dev), `strict` (propagate errors instead of `null`).
- **ethers v6**: `provider.getResolver(name)` / `resolveName` follow CCIP automatically; `provider.call` follows when the tx has `enableCcipRead: true`. ethers v5 needed `ccipReadEnabled: true`.
- **Known quirks:** clients lowercase `{sender}`; some clients POST even with `{data}` present is a spec violation you will NOT get from viem/ethers — but the ENS **UniversalResolver batch gateway** may hit you with POST (it uses its own gateway list), so implement POST anyway (10 lines). Always send CORS `*` (browser clients — manager app, Rainbow — fetch from the page origin). HTTP redirect responses (3xx) are followed by fetch; avoid them (Vercel proxy must not redirect).

### 4.2 DNS wire-format name encoding (what arrives in `name`)

RFC 1035 §3.1 length-prefixed labels, ENSIP-10 variant (no 255-byte total-length cap):

```
"e81ca24a-….novicorpus.eth" →
  0x24 ‖ "e81ca24a-…" (36 bytes) ‖ 0x0a ‖ "novicorpus" ‖ 0x03 ‖ "eth" ‖ 0x00
```

- Each label: 1 length byte (value **1–63**) + that many bytes of UTF-8. **Hard max label length = 63 bytes** (RFC 1035: the top two bits of the length octet are reserved for compression pointers, so 0x3F is the max). Our 36-char UUID publicIds fit with room to spare; any future id **> 63 bytes cannot be DNS-encoded at all** — enforce `label.length <= 63` if id formats ever change.
- Terminated by a zero byte. Empty name = single `0x00`.
- The name arrives **already ENSIP-15-normalized** by the client (viem/ethers normalize before hashing). Normalization rules that matter for our labels:
  - Uppercase ASCII is **mapped to lowercase** during normalization — the gateway will only ever see lowercase; still, `.toLowerCase()` defensively before the repo lookup (our `findByPublicId` UUID regex is case-insensitive anyway).
  - Hyphens are legal **except** when the 3rd AND 4th characters are both `-` (forbidden pattern `/^..--/`, the xn-- rule). UUIDs have hyphens at positions 9/14/19/24 only → **safe**. A future id format must avoid `??--…`.
  - Underscore only allowed **leading** (`/^_*[^_]*$/`). UUIDs have none → safe.
  - Lowercase hex + hyphen labels validate as label-type "ASCII" — nothing else to worry about (no emoji/confusable logic touches them).
- Numeric labels (a raw agentId like `845775`) are also valid ASCII labels, if we ever serve those.

Decoder (gateway-side):

```ts
/** DNS wire format -> ['e81ca24a-…','novicorpus','eth']. Returns null on malformed input. */
function decodeDnsName(bytes: Uint8Array): string[] | null {
  const labels: string[] = []
  let i = 0
  while (i < bytes.length) {
    const len = bytes[i]
    if (len === 0) return i === bytes.length - 1 ? labels : null // junk after terminator
    if (len > 63 || i + 1 + len > bytes.length) return null
    labels.push(new TextDecoder().decode(bytes.subarray(i + 1, i + 1 + len)))
    i += 1 + len
  }
  return null // missing terminator
}
```

### 4.3 What the gateway must compute

Request (GET): `/ensgateway/:sender/:data.json` where `data` = hex of `resolve(bytes name, bytes data)` calldata (selector `0x9061b923`).

1. Hex-decode `data` (strip trailing `.json`). Check selector `0x9061b923`; else 400.
2. ABI-decode the two `bytes` args → `dnsName`, `innerCall`.
3. `decodeDnsName(dnsName)` → labels; determine target entity (§4.6).
4. Dispatch on `innerCall` selector:

| Inner selector | Function | Result encoding (the `result` bytes) |
|---|---|---|
| `0x3b3b57de` | `addr(bytes32)` | `encodeAbiParameters([{type:'address'}], [treasury])` |
| `0xf1cb7e06` | `addr(bytes32,uint256)` | `encodeAbiParameters([{type:'bytes'}], [addrBytes])` — for EVM coinTypes `addrBytes` = the raw 20-byte address (`0x…` hex of 20 bytes); **empty `0x` if coinType unknown** (ENSIP-9: zero-length = not set) |
| `0x59d1d43c` | `text(bytes32,string)` | `encodeAbiParameters([{type:'string'}], [value])` — **empty string** for unknown keys (ENSIP-5), never an error |
| anything else | — | `encodeAbiParameters([{type:'bytes'}],['0x'])` is NOT correct — instead return an ABI-encoded empty value of the right shape if known, else HTTP 400. In practice: return empty-string/empty-bytes for `contenthash(bytes32)` (`0xbc1c58d1`) and `ABI(bytes32,uint256)` (`0x2203ab56`) if clients probe them |

   (The `bytes32 node` inside `innerCall` is `namehash(name)` — you don't need it; the DNS name is authoritative. Don't try to reverse the hash.)
5. `expires = BigInt(Math.floor(Date.now()/1000) + 300)` (uint64).
6. Sign digest (§4.4) with the gateway signer key.
7. `body = { data: encodeAbiParameters([{type:'bytes'},{type:'uint64'},{type:'bytes'}], [result, expires, sig]) }` → 200 JSON.

**The signed `request` is the FULL outer calldata** (the `resolve(bytes,bytes)` bytes you received in the URL) — trace through `resolveWithProof`: `extraData = abi.encode(callData, resolverAddr)`; `verify` decodes it and hashes `callData` (= your `data` param) as `request`, and `sender` (= resolver address) as `target`.

### 4.4 Signing digest — the classic footgun

```
digest = keccak256( 0x1900 ‖ resolverAddress(20) ‖ expires(uint64, 8 bytes BE) ‖ keccak256(request) ‖ keccak256(result) )
```

Raw ECDSA over that 32-byte digest. **NOT** `personal_sign` (no `\x19Ethereum Signed Message` prefix), **NOT** EIP-712.

```ts
import { encodePacked, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const signer = privateKeyToAccount(env.ENS_GATEWAY_SIGNER_KEY)

function makeDigest(resolver: `0x${string}`, expires: bigint, request: `0x${string}`, result: `0x${string}`) {
  return keccak256(encodePacked(
    ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
    ['0x1900', resolver, expires, keccak256(request), keccak256(result)],
  ))
}
const sig = await signer.sign({ hash: makeDigest(sender, expires, requestData, result) }) // 65-byte r‖s‖v hex
```

`account.sign({ hash })` is the raw-digest signer in viem (do not use `signMessage` — that's personal_sign). `encodePacked` writes `uint64` as exactly 8 big-endian bytes, matching `abi.encodePacked`.

**Unit-test FIRST (build step 3):** compare TS digest to the contract:

```bash
cast call $RESOLVER "makeSignatureHash(address,uint64,bytes,bytes)(bytes32)" \
  $RESOLVER 1790000000 0xdeadbeef 0xcafe --rpc-url $SEPOLIA_RPC
# TS: makeDigest(RESOLVER, 1790000000n, '0xdeadbeef', '0xcafe')  → must be byte-identical
```

Wire this exact vector into a vitest test so regressions can't sneak in.

### 4.5 Hono route — our idioms

New file `back/backend/src/api/routes/ensGateway.ts`, mirroring `metadata.ts` (public, unauthenticated, uniform errors). Zero new deps — viem only.

```ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { decodeAbiParameters, encodeAbiParameters, encodePacked, hexToBytes, keccak256 } from "viem";
// deps additions (ApiDeps): ensGateway?: { signer: PrivateKeyAccount; resolverAddress?: `0x${string}` }
// optional-deps pattern like `payments`: absent -> route not mounted (404), matching x402Demo.

const RESOLVE_SELECTOR = "0x9061b923";

export function mountEnsGatewayRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  const handle = async (sender: string, dataHex: string) => {
    // …selector check -> decodeAbiParameters([{type:'bytes'},{type:'bytes'}], `0x${dataHex.slice(10)}`)
    // -> decodeDnsName -> label lookup via deps.repo.findByPublicId -> dispatch table (§4.3)
    // -> sign (§4.4) -> { data: encodeAbiParameters([bytes,uint64,bytes], [result, expires, sig]) }
  };

  // GET  /ensgateway/0x<sender>/0x<calldata>.json   (primary — matches the {sender}/{data}.json template)
  app.get("/ensgateway/:sender/:data", async (c) => {
    const data = c.req.param("data").replace(/\.json$/, "");
    const body = await handle(c.req.param("sender"), data);          // throws ApiError(400/404) on bad input
    return c.json(body);
  });
  // POST /ensgateway   (spec fallback; body {sender, data}) — costs 6 lines, keep it
  app.post("/ensgateway", async (c) => {
    const { sender, data } = await c.req.json<{ sender: string; data: string }>();
    return c.json(await handle(sender, data));
  });
}
```

Mount in `buildApiApp` (app.ts) right after `mountMetadataRoutes` (public zone, **before** the `requireAuth` blocks), and extend the CORS origin callback:

```ts
origin: (_origin, c) =>
  c.req.path.startsWith("/metadata/") || c.req.path.startsWith("/ensgateway") ? "*" : deps.webOrigin,
```

Error mapping: spec-correct codes matter (4xx aborts the client, 5xx makes it retry other URLs — we only have one URL, so everything unexpected should be 400/404 with `{"message": …}` via the existing `ApiError`/`apiOnError` envelope — check that `apiOnError`'s JSON shape includes a `message` field; if it's `{error: …}` add `message` for this route's errors). Unknown **record** ≠ error: empty string/bytes, 200. Unknown **label** (no entity): also prefer 200 + empty values over 404 — a 404 hard-fails resolution of typo'd names in demos with ugly errors, empty results degrade gracefully. Add `Cache-Control: max-age=30` (records include live `legal-status`; short TTL keeps the pause-flip demo snappy).

### 4.6 Apex vs subdomain dispatch

`labels` from the DNS name:
- `["novicorpus","eth"]` → apex: serve `addr(60)` = platform treasury or manager address, `url`, `description` ("Novi Corpus — legal bodies for AI agents"), `agent-endpoint[web]`. Judges WILL look up the bare name.
- `[publicId,"novicorpus","eth"]` → agent: `deps.repo.findByPublicId(labels[0].toLowerCase())`; not found → empty answers.
- Anything deeper / different suffix → empty answers. (Don't hard-verify the suffix equals `novicorpus.eth`: the same gateway then serves a mainnet deployment for free.)

---

## 5. Records catalog (every record we serve, and where the data comes from)

All served by the gateway from our SQLite/adapters — nothing stored on-chain on ENS. Backend sources reference `ApiDeps` (`app.ts`).

| Record | Key / args | Value format | Source in our backend |
|---|---|---|---|
| `addr(node)` (coinType 60 implied) | — | 20-byte address, ABI-`address` | **AgentTreasury address** for the entity (repo record / addresses file) — the whitelist-able governed account |
| `addr(node, 2152525650)` | coinType `0x804cef52` = `0x80000000 \| 5042002` (ENSIP-11, Arc testnet) | raw 20 bytes, ABI-`bytes` | same treasury address (its Arc-native form) |
| `text: description` | ENSIP-5 global | UTF-8 string | entity display name + "Wyoming DAO LLC governed agent" boilerplate |
| `text: url` | ENSIP-5 global | https URL | `METADATA_BASE_URL/metadata/<publicId>` (public metadata JSON) |
| `text: avatar` | ENSIP-12 | URI: `https://…` (must be a direct image: jpeg/png/svg), `ipfs://…`, `data:image/…`, or NFT `eip155:1/erc721:<contract>/<tokenId>` (NFT form requires the name's addr to own the token — skip; use a plain https PNG) | static per-brand asset, or `data:` URI for full offline-ness |
| `text: legal-status` | custom | `"Active"` / `"Suspended"` — **live** read | `deps.arc` LegalManager read (the same standing/legalActive surface as `GET /entities/:id/treasury`); this is the pause-on-stage demo record |
| `text: treasury` | custom | 0x address string | repo |
| `text: operator` | custom | 0x address string | repo (operator EOA) |
| `text: metadata` | custom | https URL | same as `url` |
| `text: agent-registration[…][…]` | **ENSIP-25**, §6.1 | `"1"` iff label↔agentId match, else `""` | repo: entity's `agentId`; return `"1"` only when the key's registry hex == ours AND the key's agentId == this entity's agentId |
| `text: agent-context` | **ENSIP-26** | free-form Markdown describing the agent + pointing at the ENSIP-25 record and endpoints | template + repo fields |
| `text: agent-endpoint[mcp]` | ENSIP-26 | URL | `deps.mcpPublicUrl` |
| `text: agent-endpoint[web]` | ENSIP-26 | URL | dashboard URL (`webOrigin`) |

Return **empty string** for every other text key (clients probe `com.twitter`, `email`, etc. — ENSIP-5 mandates empty, not error). Return **empty bytes** for other coinTypes. `display` (ENSIP-5) is optional; if served it MUST case-fold-match the name.

**ENSIP-11 refresher:** coinType for an EVM chain = `(0x80000000 | chainId) >>> 0`. Arc testnet 5042002 → `2152525650` (`0x804cef52`). Ethereum itself stays SLIP-44 `60`; `addr(node)` == `addr(node, 60)` must agree (backwards-compat rule from ENSIP-9).

---

## 6. ENSIP-25 / ENSIP-26 — exact specs + our encodings

Both are **status: draft** in `ensdomains/ensips@master` (fetched 2026-07-24): ENSIP-25 created 2025-10-02 (contributors premm.eth, raffy.eth, workemon.eth, ses.eth); ENSIP-26 created 2025-05-17 (premm.eth, justghadi.eth). Both are linked from the ETHGlobal ENS prize page — judges know them.

### 6.1 ENSIP-25 key format (spec text, verbatim)

> To enable verification of an ENS name from a specific AI agent registry entry, this ENSIP defines a global parameterized ENS text record key:
>
> ```
> agent-registration[<registry>][<agentId>]
> ```
>
> Where:
>
> - `<registry>` is the ERC-7930 interoperable address of the registry contract (hexadecimal string with `0x` prefix),
> - `<agentId>` is the registry-defined agent identifier (string) and MUST NOT contain the characters `[` or `]`.
>
> The combination of `<registry>` and `<agentId>` MUST uniquely identify an agent within the context of the referenced registry.
>
> The value of this text record MUST be a non-empty string. Implementations SHOULD set the value to `"1"`. The specific value has no semantic meaning; the presence of a non-empty value is interpreted as an attestation by the ENS name owner that the ENS name is associated with the referenced AI agent registry entry. Verification clients MUST NOT depend on the specific value beyond it being non-empty.

### 6.2 ENSIP-25 verification flow (spec text, verbatim)

> Clients performing verification starting from an AI agent registry entry MUST follow the steps below:
>
> 1. Obtain the claimed ENS name, agent identifier, and registry address from the AI agent registry entry.
> 2. Construct the text record key `agent-registration[<registry>][<agentId>]`.
> 3. Resolve the text record with this key on the claimed ENS name.
> 4. If the resolved value is non-empty, the ENS name is considered verified for that specific agent registry entry.
>
> If the text record does not exist or resolves to an empty value, verification MUST fail.

Plus (Ethereum example section): "For EVM-based registries, the registry address MUST be encoded as an ERC-7930 interoperable address with a 20-byte address length." Spec's own example (ERC-8004 mainnet, chainId 1, agent 167): key `agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]`. And from Registry Compatibility: "Registries using this ENSIP MUST document how agent identifiers and claimed ENS names are obtained" — that's our metadata `registrations` block + this doc.

### 6.3 Our ERC-7930 encoding (field-by-field, verified against ERC-7930 + the ENSIP-25 example)

ERC-7930 binary layout: `Version(2) ‖ ChainType(2) ‖ ChainReferenceLength(1) ‖ ChainReference(var) ‖ AddressLength(1) ‖ Address(var)`.

Our registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` on Arc testnet (eip155:5042002):

| Field | Bytes | Meaning |
|---|---|---|
| Version | `0001` | ERC-7930 v1 |
| ChainType | `0000` | CASA namespace `eip155` |
| ChainReferenceLength | `03` | chainId needs 3 bytes |
| ChainReference | `4cef52` | 5042002 big-endian, minimal bytes |
| AddressLength | `14` | 20 |
| Address | `8004a818bfb912233c491871b3d84c89a494bd9e` | registry, lowercase |

Full: `0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e` — **matches the blueprint exactly** ✔ (display lowercase, per ERC-7930 recommendation).

Per-agent key (e.g. agentId 845775):

```
agent-registration[0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e][845775]
```

Gateway rule: parse incoming `text()` keys matching `^agent-registration\[(0x[0-9a-f]+)\]\[([^\[\]]+)\]$`; answer `"1"` **only** if group1 == our registry hex (compare lowercase) AND group2 == the resolved entity's agentId (string compare). Everything else → `""`. Presence-only semantics; never answer `"1"` from the key alone.

**Bidirectional half (registry→ENS input data):** on Arc, `setMetadata(agentId, "ens", bytes("<publicId>.novicorpus.eth"))` on `0x8004A818…BD9e` (NFT owner = our manager EOA post-createEntity; **pre-validate with the README checklist `cast` calls** — if setMetadata auth fails, off-chain-only bidirectionality via the metadata JSON is explicitly permitted by the spec's "on-chain or off-chain" registry-compatibility clause). Also extend `renderMetadata` with `"ens": "<name>"` and `"registrations": [{"agentId": <id>, "agentRegistry": "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e"}]`.

### 6.4 ENSIP-26 exact keys + formats

- **`agent-context`** — published via `text(bytes32,string)`; "Any format suitable for agentic systems (plain text, Markdown, YAML, JSON, etc.)"; it's the entry point (spec's analogy: `index.html`) and MAY reference ENSIP-25 records and `agent-endpoint` records.
- **`agent-endpoint[<protocol>]`** — value "MUST be a valid URL, including IPFS URIs". Protocol values aligned with ERC-8004 services: `mcp` (Model Context Protocol), `a2a`, `web`. Additional values MAY be used.
- Resolution flow (spec): 1) load `agent-context`; 2) read it; 3) optionally load `agent-endpoint[<protocol>]`. Absent `agent-context` ⇒ "no agent context is available".

Ours: `agent-endpoint[mcp]` = `deps.mcpPublicUrl`, `agent-endpoint[web]` = dashboard, `agent-context` = short Markdown: what the agent is, its legal wrapper, treasury address, "verify me: ENSIP-25 record + on-chain getMetadata(id,'ens')", endpoints. ENSIP-27 (agent card): mention as draft/garnish only — cite verbally, don't build.

---

## 7. Testing & debugging matrix

Env for all: `RPC=$SEPOLIA_RPC`, `RESOLVER=<deployed addr>`, `NAME=e81ca24a-….novicorpus.eth`.

### Layer 0 — digest unit test (do FIRST — §4.4)

### Layer 1 — resolver revert (no gateway needed)

```bash
NODE=$(cast namehash "$NAME")
INNER=$(cast calldata "text(bytes32,string)" "$NODE" "description")
# DNS-encode the name (node one-liner using viem, already in backend deps):
DNSNAME=$(cd /home/mbarr/Project-Alpha/back/backend && node -e \
  "const{packetToBytes}=require('viem/ens');const{toHex}=require('viem');console.log(toHex(packetToBytes(process.argv[1])))" "$NAME")
cast call "$RESOLVER" "resolve(bytes,bytes)" "$DNSNAME" "$INNER" --rpc-url "$RPC"
```

Expected: **revert** with raw data starting `0x556f1830` (`OffchainLookup`). cast does NOT follow CCIP-read — the revert IS the pass condition. Decode it:

```bash
cast decode-error --sig "OffchainLookup(address,string[],bytes,bytes4,bytes)" 0x556f1830…
# check: [0]==$RESOLVER, [1][0]==your URL template, [3]==0xf4d4d2f8
```

### Layer 2 — gateway direct (curl)

```bash
CALLDATA=$(cast calldata "resolve(bytes,bytes)" "$DNSNAME" "$INNER")
curl -sD - "https://project-alpha-pi.vercel.app/backend/ensgateway/${RESOLVER,,}/${CALLDATA}.json"
# expect: 200, content-type application/json, {"data":"0x…"}
# decode: cast abi-decode "x()(bytes,uint64,bytes)" <data>   -> (result, expires, sig)
# then:   cast abi-decode "x()(string)" <result>             -> "…description…"
# POST fallback:
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"sender\":\"$RESOLVER\",\"data\":\"$CALLDATA\"}" \
  https://project-alpha-pi.vercel.app/backend/ensgateway
```

### Layer 3 — signature round-trip on-chain (catches digest bugs before any client)

```bash
RESPONSE=<the "data" hex from layer 2>
EXTRADATA=$(cast abi-encode "x(bytes,address)" "$CALLDATA" "$RESOLVER")
cast call "$RESOLVER" "resolveWithProof(bytes,bytes)(bytes)" "$RESPONSE" "$EXTRADATA" --rpc-url "$RPC"
# success -> ABI-encoded record; revert "Invalid sigature" -> digest/signer mismatch
```

### Layer 4 — full CCIP loop (viem)

```ts
// back/backend scripts sandbox; viem's sepolia already has ensUniversalResolver
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'
const c = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC) })
console.log(await c.getEnsAddress({ name: normalize(NAME) }))
console.log(await c.getEnsText({ name: normalize(NAME), key: 'legal-status', strict: true }))
console.log(await c.getEnsAddress({ name: normalize(NAME), coinType: 2152525650n }))
// dev tip: gatewayUrls: ['http://localhost:8789/ensgateway/{sender}/{data}.json'] to bypass the deployed URL
```

### Layer 5 — manager app / booth surface

`https://sepolia.app.ens.domains/<name>` shows the records visually (good booth prop). Then the live demo: guardian pause on Arc → re-query `legal-status` → `Suspended`.

### Classic failure modes

| Symptom | Cause → fix |
|---|---|
| `resolveWithProof` reverts **"SignatureVerifier: Invalid sigature"** (note upstream typo) | Digest mismatch: used personal_sign/EIP-712 instead of raw `sign({hash})`; signed the inner call instead of the FULL `resolve()` calldata; `expires` not packed as 8-byte uint64; signer key ≠ constructor allowlist. Layer 0/3 isolate it. |
| "Signature expired" | `expires` in ms not seconds, or clock skew — use `now+300` seconds. |
| viem returns `null`, no error | Swallowed resolution failure — rerun with `strict: true` to see the real revert. |
| Client error mentions HTTP 4xx | Gateway returned 400/404 — clients ABORT on 4xx (spec). Check route mount path through the proxy (`/backend/ensgateway/...` vs local `/ensgateway/...` — the resolver URL bakes the PUBLIC path), the `.json` strip, hex decode. |
| Loops/retries then fails | Gateway 5xx — client retried the (single) URL list and gave up; check backend logs. |
| Works via curl, fails in browser/manager app | CORS — the `app.ts` origin callback must return `*` for `/ensgateway` paths. Also confirm the Vercel proxy passes the route at all (hour-1 smoke test; fallback = VPS-direct TLS URL + 2-min resolver redeploy). |
| Wrong/empty record for a name you KNOW exists | Normalization mismatch: query side must `normalize(name)`; gateway side lowercase the label before `findByPublicId`. |
| `cast call resolve(...)` returns instead of reverting | You called the PublicResolver, not your OffchainResolver — check `setResolver` landed (`cast call $REGISTRY "resolver(bytes32)(address)" $(cast namehash novicorpus.eth)`). |
| Registration `registerName` reverts | Commitment <60 s or >24 h old, params not byte-identical between commit/register, or value too low (§2.1). |

---

## 8. Track submission requirements (re-fetched 2026-07-24 from ethglobal.com/events/lisbon2026/prizes/ens)

Total ENS pool **$5,000**; we target all three with one build:

| Prize | Amount | Requirement (verbatim where quoted) |
|---|---|---|
| Best ENS Integration for AI Agents | $1,500 | "It should be obvious how ENS improves your agent's identity or discoverability — not just a cosmetic add-on." |
| Best ENS Continuity Integration | $2,000 | Continuity Track participants only. "It should be clear what ENS-powered feature was built during the hackathon and how it improves the existing product." |
| Most Creative Use of ENS | $1,500 | "ENS should clearly improve the product. Demo must be functional (no hard-coded values)." |

**Common to all three:** functional demo, **no hard-coded values**; submit with **video or live demo link**; **present at the ENS booth in person on Sunday morning** (mandatory).

Sponsor-recommended resources (be conversant): docs.ens.domains, `/building-with-ai/` (llms.txt + `llms-full.txt` plain-text docs endpoints, MCP servers incl. Context7), **ENSIP-25**, **ENSIP-26**, and `github.com/ensdomains/ens-cli` (their "agent-native CLI" — a nice booth line: our MCP `resolve_agent` tool is the same spirit pointed at legal bodies).

Continuity framing for the $2k: everything in this doc is new-during-hackathon (resolver, gateway, records, ENSIP-25 both halves, MCP tool) layered on the pre-existing ERC-8004/treasury product — the branch diff + this folder document the boundary. Commit incrementally.

---

## 9. Corrections / deltas vs `technical-blueprints.md` §3

1. **⚠ WRONG: "Names register WRAPPED → `setResolver` via NameWrapper (`contract:'nameWrapper'`)."**
   ensjs **4.3.1** (current, npm-verified) targets the **2025 ETHRegistrarController** (`0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968` on Sepolia — same address the blueprint lists, but it's the *new, unwrapped* controller): `register((label, owner, duration, secret, resolver, data, uint8 reverseRecord, bytes32 referrer))`. Names register **UNWRAPPED**; NameWrapper is untouched (the wrapped controller survives only as legacy `wrappedEthRegistrarController` `0x4477cAc…`). Therefore `setResolver` uses **`contract: 'registry'`**. §2.3's `getOwner` check makes the step robust either way.
2. **No `fuses`/`ownerControlledFuses` parameter exists** in ensjs 4.3.1 registration (older ensjs docs pages still show it — they are stale). `reverseRecord` is now a **uint8 enum** (0 None / 1 Ethereum / 2 Default), not a boolean, and there's a new optional `referrer: bytes32`.
3. **New fact, plan-relevant: commitments expire after 24 h** (`maxCommitmentAge` live-read). "Register night-0" must mean commit+register the same evening.
4. Blueprint's Sepolia addresses (Registry / Controller / NameWrapper / UniversalResolver) all **re-verified correct**. Additional current addresses now pinned in §2.0 (PublicResolver `0xE996…`, new ReverseRegistrar `0xA0a1…`, DefaultReverseRegistrar).
5. ENSIP-25 key + our ERC-7930 hex `0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e` — **verified correct field-by-field** against ERC-7930 and the ENSIP-25 worked example. `"1"`-presence semantics confirmed (clients MUST NOT depend on the value beyond non-emptiness). coinType `2152525650`/`0x804cef52` confirmed.
6. OffchainResolver detail glossed over: **no owner/setters — URL + signers are constructor-frozen**; rotation = redeploy + setResolver (blueprint's "2 min redeploy" fallback is real, and the reason to deploy with 2 allowlisted signers).
7. Blueprint said "~60 lines + SignatureVerifier": actual verbatim sources + the 2 vendored SupportsInterface files ≈ 150 lines total (§3); the OZ dependency is satisfied by our existing v5.1.0 pin (ECDSA API unchanged; upstream repo builds it via ens-contracts 0.0.8 transitively).
8. Registration cost on Sepolia: **0.003125 ETH/yr** (live-read), `novicorpus` **available** as of 2026-07-24 — grab it night-0.
9. Prize page re-verified; amounts/booth requirement match the blueprint. New info: "no hard-coded values" is an explicit judged rule, and the sponsor resource list adds `ens-cli` + `building-with-ai` (llms-full.txt) — mention at the booth.

Everything else in blueprint §3 (architecture, records list, booth walkthrough, risks, hour split) stands as written.
