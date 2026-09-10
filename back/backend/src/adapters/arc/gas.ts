/**
 * Explicit gas for ERC-20 `transfer` of Arc's native-gas USDC from an EOA.
 *
 * On Arc the gas token IS the 0x3600 USDC being transferred. viem's `writeContract` runs
 * `eth_estimateGas` WITH EIP-1559 fee fields, which makes geth reserve ~the sender's entire balance
 * (`maxFeePerGas × gasAllowance`) before executing the estimate — so a near-full-balance USDC
 * transfer from an EOA deterministically reverts `ERC20: transfer amount exceeds balance` DURING
 * estimation (reproduced live via `prepareTransactionRequest`). Passing an explicit `gas` makes viem
 * skip that estimate entirely (`simulateContract`'s plain `eth_call` is unaffected). A plain transfer
 * is ~50k; Circle's own Gateway deposit hardcodes gas for the same reason.
 *
 * Use on EVERY EOA USDC `transfer` writeContract that can move a near-full balance (operator forward,
 * treasury/pocket/provider sweeps). NOT needed where the sender only RECEIVES USDC and pays gas
 * (e.g. `fundOperator`), since the estimate never needs the balance for a transfer there.
 */
export const USDC_TRANSFER_GAS = 100_000n;

/**
 * Explicit gas for `transferWithAuthorization` on Arc's USDC predeploy (design §6.4).
 *
 * ⚠ MEASURED, not estimated. The live merge gate settled a real signed authorization on Arc
 * testnet (chain 5042002) on 2026-09-09 — tx `0x2c5d0648b47cbd176825c51f7dab79f089c6eb5bac79f586
 * 5365498d7dad61df` — and the receipt reported **gasUsed = 117,079**. 140,000 is that plus ~20%,
 * which is the right side to be wrong on: unused gas is refunded, so being generous costs nothing
 * and being short is a reverted settle on a signature the guardian already gave. The transcript
 * is at `docs/runbooks/formation-settle-probe-2026-09.md`.
 *
 * NOT the 100k above, and not for the same reason. `USDC_TRANSFER_GAS` exists because the SENDER
 * is paying gas in the very token it is transferring, so viem's fee-bearing estimate reserves the
 * balance and the estimate itself reverts. That footgun does NOT bite here: the token sender is
 * the GUARDIAN, and the account paying gas is the dedicated SETTLE SUBMITTER, which sends no USDC
 * in this transaction and therefore always has its whole balance available to an estimate.
 *
 * The explicit figure is here for the other reason an explicit figure is ever right — an estimate
 * is a round trip that can fail, be throttled, or answer against a state one block stale, on the
 * hot path of a payment that has already been signed. A settle that dies in `eth_estimateGas`
 * costs the guardian a wallet interaction and buys nothing.
 *
 * (The work, for anyone re-deriving it: an `ecrecover`, the EIP-712 digest, a
 * `_authorizationStates` SSTORE from zero — the expensive kind — and then the balance updates a
 * plain transfer would have done anyway. Which is why the plain-transfer 100k above has no
 * headroom at all here.)
 */
export const TRANSFER_WITH_AUTHORIZATION_GAS = 140_000n;

/**
 * Explicit gas for `cancelAuthorization` — the guardian's fast path out of a stuck payment.
 *
 * ⚠ MEASURED the same way, in the same run: tx `0x33d591a90f490e7dd93e789ed065f0fd5e4397ccfdc4d3
 * ee945291fd873948ff`, **gasUsed = 71,265**, +~20% = 86,000. The same shape of work minus the
 * transfer: an `ecrecover`, a digest, and the same zero-to-non-zero SSTORE that retires the nonce.
 */
export const CANCEL_AUTHORIZATION_GAS = 86_000n;
