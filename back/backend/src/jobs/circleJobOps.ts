import { encodeFunctionData } from "viem";
import { iErc8183JobAbi } from "../abis/generated";
import type { SubmitAndConfirmOptions } from "../adapters/circle/circleExec";
import { CircleTxFailedError, submitAndConfirm } from "../adapters/circle/circleExec";
import { circleRefId } from "../adapters/circle/circleRefId";
import type { CircleWalletsApi } from "../adapters/circle/circleWallets";
import type { JobOpAttempts } from "../persistence/jobOpAttempts";
import type { Address, Hex } from "../types";
import type { ProviderJobOps } from "./runJob";

/**
 * Circle-path ProviderJobOps (Tier-0 audit item 4): the provider-signed job steps sent by the
 * operator SCA through contractExecution instead of an enclave-backed viem wallet.
 *
 * Idempotency seeds are deterministic per (jobKey, step, attempt): a crash between Circle
 * accepting the submit and the job saga persisting its status makes the retry REPLAY the
 * original tx instead of firing a duplicate (Circle returns the original response for a reused
 * key) — while a terminal FAILED/DENIED bump of the persisted attempt (review finding H1)
 * derives a FRESH key, because the burned key would replay the failed response forever. The
 * sweep seed additionally carries the amount, so a later retry after balances moved never
 * replays a stale attempt.
 */
/**
 * The run tail every mint site appends: `Date.now()` + 8 hex of a fresh uuid. It is what makes a
 * shortened refId unique per job RUN, so a job key without it is not a shape we can shorten.
 */
const JOB_RUN = /^\d{10,}-[0-9a-f]{8}$/;

/** The tenant (guardian) address an entity key is prefixed with: `<tenant>:<user key>`. */
const TENANT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Split a job key into the two parts a BOUNDED refId is built from.
 *
 * Every mint site — MCP `run_job`, `POST /jobs`, the CLI's `run-job` — builds
 * `<entity key>:<timestamp>-<suffix>`, and an entity key is itself `<tenant address>:<user key>`.
 * So there are two shapes to accept, and the tenant address is dropped from both: it identifies
 * nothing the entity key does not already identify, and its 43 characters are exactly what pushed
 * `job:<jobKey>:<step>` past Circle's 100-character refId ceiling.
 *
 * It REFUSES anything else rather than guessing. A shortened refId has to stay unique — Circle
 * lets us filter transactions by refId, so it is a lookup key — and uniqueness is a property of
 * the shape, not of the length. An unrecognised key fails here, deterministically, in front of a
 * test, instead of becoming a refId that collides with another job's.
 */
export function jobRefIdParts(jobKey: string): { entity: string; run: string } {
  const refuse = (): never => {
    throw new Error(
      `job key "${jobKey}" is not a shape a Circle refId can be built from: expected \`<entity key>:<timestamp>-<suffix>\` (as minted by run_job, POST /jobs and the CLI)`,
    );
  };
  const cut = jobKey.lastIndexOf(":");
  if (cut < 1) return refuse();
  const run = jobKey.slice(cut + 1);
  const entityKey = jobKey.slice(0, cut);
  if (!JOB_RUN.test(run)) return refuse();
  const firstColon = entityKey.indexOf(":");
  const entity =
    firstColon > 0 && TENANT_ADDRESS.test(entityKey.slice(0, firstColon))
      ? entityKey.slice(firstColon + 1)
      : entityKey;
  if (entity === "") return refuse();
  return { entity, run };
}

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function circleJobOps(p: {
  api: Pick<CircleWalletsApi, "createContractExecutionTransaction" | "getTransaction">;
  operatorWalletId: string;
  jobContract: Address;
  jobKey: string;
  /** Persisted per-(jobKey, step) attempt counters — the H1 key-burn escape hatch. */
  attempts: JobOpAttempts;
  confirm?: SubmitAndConfirmOptions;
  /** S5: Gas Station sponsorship observed from confirmed-tx fees (recorded, never checked). */
  outflows?: { record(path: "gas_sponsorship", amountAtomic: bigint, ref: string | null): void };
}): ProviderJobOps {
  // Parsed once, up front: the refId parts are a property of the job key, so an unrecognised key
  // is refused before any step is attempted rather than halfway through the saga.
  const { entity, run: jobRun } = jobRefIdParts(p.jobKey);

  const run = async (contractAddress: Address, callData: Hex, step: string): Promise<Hex> => {
    const attempt = p.attempts.get(p.jobKey, step);
    try {
      const { txHash } = await submitAndConfirm(
        p.api,
        {
          walletId: p.operatorWalletId,
          contractAddress,
          callData,
          // The seed keeps the WHOLE job key: it is hashed into a UUID, so its length never
          // mattered, and re-keying it would make an in-flight retry fire a second transaction
          // instead of replaying the first.
          idempotencySeed: `job:${p.jobKey}:${step}:${attempt}`,
          // The refId does NOT: Circle caps it at 100 characters (see circleRefId) and
          // `job:<jobKey>:<step>` was 116 for an MCP job key.
          refId: circleRefId(["job", entity, jobRun, step]),
        },
        {
          ...p.confirm,
          onNetworkFee: (fee, txId) => p.outflows?.record("gas_sponsorship", fee, txId),
        },
      );
      return txHash;
    } catch (e) {
      // Terminal Circle failure burned this attempt's idempotency key — bump so the NEXT retry
      // derives a fresh one instead of replaying the failed response forever.
      if (e instanceof CircleTxFailedError) p.attempts.bump(p.jobKey, step);
      throw e;
    }
  };

  return {
    setBudget: (jobId, amount) =>
      run(
        p.jobContract,
        encodeFunctionData({
          abi: iErc8183JobAbi,
          functionName: "setBudget",
          args: [jobId, amount, "0x"],
        }),
        "setBudget",
      ),
    submit: (jobId, deliverable) =>
      run(
        p.jobContract,
        encodeFunctionData({
          abi: iErc8183JobAbi,
          functionName: "submit",
          args: [jobId, deliverable, "0x"],
        }),
        "submit",
      ),
    sweepToTreasury: (usdc, treasury, amount) =>
      run(
        usdc,
        encodeFunctionData({
          abi: erc20TransferAbi,
          functionName: "transfer",
          args: [treasury, amount],
        }),
        `sweep:${amount}`,
      ),
  };
}
