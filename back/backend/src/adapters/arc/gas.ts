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
 * NOT the 100k above, and not for the same reason. `USDC_TRANSFER_GAS` exists because the SENDER
 * is paying gas in the very token it is transferring, so viem's fee-bearing estimate reserves the
 * balance and the estimate itself reverts. That footgun does NOT bite here: the token sender is
 * the GUARDIAN, and the account paying gas is the platform EXECUTOR, which sends no USDC in this
 * transaction and therefore always has its whole balance available to the estimate.
 *
 * The explicit figure is here for the other reason an explicit figure is ever right — an estimate
 * is a round trip that can fail, be throttled, or answer against a state one block stale, on the
 * hot path of a payment that has already been signed. A settle that dies in `eth_estimateGas`
 * costs the guardian a wallet interaction and buys nothing.
 *
 * The WORK is genuinely more than a plain transfer: an `ecrecover`, the EIP-712 digest, a
 * `_authorizationStates` SSTORE from zero (the expensive kind — 20k), and then the balance
 * updates a transfer would have done anyway. FiatTokenV2_2's own gas reports put the call in the
 * 90–110k range, so a plain-transfer 100k has no headroom at all and a first-time SSTORE would
 * push a real call over it.
 *
 * ⚠ 150_000 is a BOUNDED ESTIMATE, not a measured one, and the live merge gate is what replaces
 * it with a measurement: `scripts/formation-settle-probe.mts` prints `gasUsed` from a real Arc
 * testnet receipt (§6.9). Pin this constant to that number + ~20% headroom before payment is ever
 * turned on. Unused gas is refunded, so the cost of being generous is zero and the cost of being
 * short is a reverted settle on a signature the guardian already gave.
 */
export const TRANSFER_WITH_AUTHORIZATION_GAS = 150_000n;

/**
 * Explicit gas for `cancelAuthorization` — the guardian's fast path out of a stuck payment.
 *
 * The same shape of work minus the transfer: an `ecrecover`, a digest, and the same
 * zero-to-non-zero SSTORE that marks the nonce used. Bounded the same way and pinned by the same
 * probe, which cancels a second unused nonce and prints ITS `gasUsed` too.
 */
export const CANCEL_AUTHORIZATION_GAS = 100_000n;
