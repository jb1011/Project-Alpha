import { type Address, type Hex, getAddress } from "viem";

/**
 * The READ half of the ERC-8004 Reputation registry: one view and one event, written by hand.
 *
 * The generated `reputationRegistryAbi` carries `giveFeedback` only, because the job flow only
 * ever writes. Both entries below were copied from the explorer-verified implementation behind
 * the proxy (0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34, read 2026-10-28), and a test pins the
 * selector and the topic so a hand edit cannot drift from the contract.
 *
 * `readAllFeedback` returns values and tags but NO timestamp, URI or hash: the date of the last
 * post comes from the event's logs instead (`explorerLogs.ts`).
 */
export const reputationReadAbi = [
  {
    type: "function",
    name: "readAllFeedback",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "includeRevoked", type: "bool" },
    ],
    outputs: [
      { name: "clients", type: "address[]" },
      { name: "feedbackIndexes", type: "uint64[]" },
      { name: "values", type: "int128[]" },
      { name: "valueDecimals", type: "uint8[]" },
      { name: "tag1s", type: "string[]" },
      { name: "tag2s", type: "string[]" },
      { name: "revokedStatuses", type: "bool[]" },
    ],
  },
  {
    type: "event",
    name: "NewFeedback",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: false },
      { name: "value", type: "int128", indexed: false },
      { name: "valueDecimals", type: "uint8", indexed: false },
      { name: "indexedTag1", type: "string", indexed: true },
      { name: "tag1", type: "string", indexed: false },
      { name: "tag2", type: "string", indexed: false },
      { name: "endpoint", type: "string", indexed: false },
      { name: "feedbackURI", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

/** `keccak256("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)")`. */
export const NEW_FEEDBACK_TOPIC0: Hex =
  "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc";

/** One entry of a `readAllFeedback` answer, columns zipped into a row. */
export interface FeedbackEntry {
  client: Address;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

/** The view's seven parallel columns, as viem decodes them. */
export type ReadAllFeedbackResult = readonly [
  readonly Address[],
  readonly bigint[],
  readonly bigint[],
  readonly number[],
  readonly string[],
  readonly string[],
  readonly boolean[],
];

/** Thrown when the seven columns do not line up: the answer is not one this code can read. */
export class FeedbackDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackDecodeError";
  }
}

/** Zip the columns into rows, refusing an answer whose columns differ in length. */
export function feedbackEntries(result: ReadAllFeedbackResult): FeedbackEntry[] {
  const [clients, , values, decimals, tag1s, tag2s, revoked] = result;
  const n = clients.length;
  if ([values, decimals, tag1s, tag2s, revoked].some((col) => col.length !== n))
    throw new FeedbackDecodeError("readAllFeedback columns differ in length");
  return clients.map((client, i) => ({
    client: getAddress(client),
    value: values[i] as bigint,
    valueDecimals: decimals[i] as number,
    tag1: tag1s[i] as string,
    tag2: tag2s[i] as string,
    revoked: revoked[i] as boolean,
  }));
}
