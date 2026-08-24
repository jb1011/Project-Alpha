/**
 * LegalManager ABI fragment — the guardian's OWN view of a pending amendment.
 *
 * The second hand-written fragment in this package (`treasuryAbi` is the first), and it exists
 * for a reason the design states plainly: the guardian veto card must read the chain itself. If
 * the card vetoed a hash the backend handed it, a compromised backend could choose what gets
 * vetoed — offer up a harmless hash, keep the malicious one scheduled, and the guardian's veto
 * would land on nothing (audit H4). So the card enumerates `AmendmentScheduled` from the entity's
 * own proxy over the user's own RPC, and this is the fragment it decodes with.
 *
 * Kept minimal on purpose: five reads/writes and four events, not the whole 50-entry contract.
 * A backend vitest (`test/api/legalManagerAbiFragment.test.ts`) compares every entry here against
 * `src/abis/generated.ts` — the interface package has no test runner, so the drift guard lives in
 * the suite that actually runs in CI, exactly like the proxy-header guard.
 *
 * Note the shape of veto on this contract: `cancelOperatingAgreementUpdate` DELETES `scheduledAt`
 * and sets `vetoed`, so a vetoed amendment reads back as `scheduledAt == 0` — "live" is
 * `scheduledAt != 0`, and `vetoed` is a separate, sticky flag that parks the hash until
 * `liftVeto`.
 */
export const legalManagerAbi = [
  {
    type: "function",
    name: "scheduledAt",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "vetoed",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "cancelOperatingAgreementUpdate",
    stateMutability: "nonpayable",
    inputs: [{ name: "newHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "liftVeto",
    stateMutability: "nonpayable",
    inputs: [{ name: "newHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "meta",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "ein", type: "string" },
      { name: "formationDate", type: "uint64" },
      { name: "operatingAgreementHash", type: "bytes32" },
      { name: "agentId", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "AmendmentScheduled",
    inputs: [
      { name: "newHash", type: "bytes32", indexed: true },
      { name: "executableAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AmendmentVetoed",
    inputs: [{ name: "newHash", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "VetoLifted",
    inputs: [{ name: "newHash", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "OperatingAgreementUpdated",
    inputs: [{ name: "newHash", type: "bytes32", indexed: true }],
  },
] as const;
