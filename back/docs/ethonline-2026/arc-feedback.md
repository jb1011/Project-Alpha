# Arc developer feedback, from Novi Corpus (ETHOnline 2026)

Novi Corpus has run on Arc testnet since June 2026: a governed USDC treasury per agent, x402
payments from the agent's own wallet, ERC-8004 and ERC-8183 registrations, and since this event
the USDC payment path for forming the company (EIP-3009 on the USDC token). About 17 entities and
a few hundred transactions on the testnet box, plus the Lisbon and ETHOnline demos. This is what
building on Arc felt like, the good and the expensive, with one concrete ask per item.

## What worked, and why we stayed

- **USDC as gas.** One token to faucet, one balance to watch, and fees that mean something in
  dollars. We measured about $0.009 per governed operation. That number goes straight into our
  pricing, which we could not do on a chain with a volatile gas token.
- **Standard USDC, standard rails.** EIP-3009 `transferWithAuthorization` on the Arc USDC contract
  works exactly as on Ethereum (domain name `USDC`, version `2`; we measured 117,079 gas for the
  transfer and 71,265 for a cancel). Our formation payment is a plain signed authorization the
  guardian's wallet already knows how to produce.
- **Finality you can build a UI on.** Sub-second confirmations let the dashboard show the result
  of a treasury action without a spinner and a prayer.
- **The registries are there.** ERC-8004 and ERC-8183 on testnet, confirmed for mainnet day one.
  Every one of our agents is a registered identity with a bound wallet from its first minute.
- **Circle's x402 batching client survived a major bump.** Moving `@x402/evm` from 2.15 to 2.25
  for the Hedera rail left the Arc settlement path intact, verified with a live settle. Peer
  ranges were right.

## What cost us time, with the ask

1. **`eth_estimateGas` reserves the sender's whole balance when the call carries EIP-1559 fee
   fields.** On Arc the gas token is the token being sent, so a near-full-balance USDC transfer
   fails estimation with no useful error. We lost most of a day before pinning explicit gas on
   every EOA USDC transfer. Ask: a note in the docs, and ideally an estimator that does not
   reserve the value being transferred.
2. **The public RPC hangs on receipts and rate-limits sends.** `waitForTransactionReceipt` on the
   default endpoint can wait forever without an error; under load we got 429s on sends, which
   turned a fund that had already succeeded into a "stuck" entity in the UI until a refresh. We
   now run a keyed endpoint and a receipt timeout. Ask: document a receipt timeout and a second
   ranked endpoint in the getting-started page, and publish the public endpoint's rate limits.
3. **The testnet chain definition says `decimals: 6` for the native currency.** That is true of
   USDC, but MetaMask refuses `wallet_addEthereumChain` for anything but 18, so "add Arc testnet"
   fails from a dapp. Ask: a documented, wallet-compatible chain definition and a chainlist entry
   that works out of the box.
4. **Gas Station budgets are per entity, not per wallet.** We wanted a cap per agent wallet as a
   runaway brake; the answer was blocked-addresses per entity. Two doc gaps bit us: the per-tx cap
   does not apply to a smart account's first transaction, and the policy check does not lock the
   nonce, so two sponsored sends can race past a cap. Ask: per-wallet caps, and both caveats in
   the Gas Station docs.
5. **Circle wallets will not sign from an undeployed smart account.** Nothing says so; the signing
   call just fails. We now deploy the account during provisioning. Ask: one sentence in the
   Developer-Controlled Wallets docs, or a deploy-on-first-sign option.
6. **Mainnet readiness is scattered.** With Arc mainnet on 16 September we could confirm the
   registries, but Gateway, Gas Station, the x402 facilitator and the account-abstraction stack
   each needed a separate ask to a person. Ask: one "on Arc mainnet, day one" page per Circle
   product, with the chain id and the contract addresses.
7. **Small things.** Registry rebinds emit `MetadataSet`, not `AgentWalletSet`, which cost us a
   monitoring rule; Circle wallet metadata names have an undocumented length limit that broke our
   wizard once; the console's IP allowlist must include every machine that will ever call the
   API, including the developer's laptop.

## What we would ask for next

A testnet faucet with a higher ceiling for teams running end-to-end suites, and a status page for
the public RPC. Everything else above is documentation, and documentation is cheap compared to the
days it saved the next team.

Novi Corpus, September 2026. Code: github.com/jb1011/Project-Alpha. Design notes for each item
live in `back/docs/design/`.
