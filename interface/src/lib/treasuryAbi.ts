/** AgentTreasury ABI fragment for guardian + read calls from the dashboard.
 *
 * TODO(follow-up): generate this the way `legalManagerAbi.ts` now is — same forge artifacts, same
 * name allowlist in `back/backend/src/abis/interfaceFragment.ts`, same freshness test. Left
 * hand-written in this PR deliberately: it is the second-largest fragment in the package and
 * churning it here would bury the surfaces this change is actually about. */
export const treasuryAbi = [
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "setAllowlistEntry",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "vetoPolicyUpdate",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "liftVeto",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [],
  },
  { type: "function", name: "emergencyWithdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOperator", type: "address" }],
    outputs: [],
  },
  { type: "function", name: "policyDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowlistEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "payoutAddress", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "cap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "period", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "isAllowed",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "pendingPolicy",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [
      { name: "cap", type: "uint256" },
      { name: "period", type: "uint256" },
      { name: "payoutAddress", type: "address" },
      { name: "allowlistEnabled", type: "bool" },
      { name: "executableAt", type: "uint256" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "policyVetoed",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;
