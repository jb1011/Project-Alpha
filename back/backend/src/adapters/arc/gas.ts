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
