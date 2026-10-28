import type { Address, PublicClient } from "viem";
import { JobAdapter } from "../adapters/arc/jobAdapter";
import {
  type KlerosDeployment,
  type KlerosDeploymentName,
  deploymentFor,
} from "../adapters/kleros/deployments";
import type {
  CreateOutcome,
  KlerosDisputeService,
  PinOutcome,
  SubmitOutcome,
} from "../adapters/kleros/disputeService";
import { FakeDisputeService, type FakeScript } from "../adapters/kleros/fakeDisputeService";
import { HttpDisputeService } from "../adapters/kleros/httpDisputeService";
import { arcTestnet } from "../chains";
import type { Config, PilotKlerosMode } from "../config/env";
import type { PilotContext } from "./context";

/**
 * THE PILOT'S CHAIN SIDE: one job adapter whose client is the buyer and whose evaluator is the
 * referee, the three wallets and every chain fact the pilot steps read, all from the config.
 * The seller is not on the adapter: it signs `setBudget` and `submit`, which take their wallet.
 */
export interface PilotChain {
  job: JobAdapter;
  publicClient: PublicClient;
  wallets: PilotContext["wallets"];
  addresses: PilotContext["addresses"];
  usdc: Address;
  jobContract: Address;
  chainId: number;
  identityRegistry: Address;
  /** The block explorer's base URL, without a trailing slash. */
  explorerBase: string;
}

export function buildPilotChain(ctx: PilotContext): PilotChain {
  const { cfg } = ctx;
  const explorerBase = cfg.arcExplorerUrl ?? arcTestnet.blockExplorers?.default.url;
  if (!explorerBase) throw new Error("the pilot needs a block explorer URL (ARC_EXPLORER_URL)");
  return {
    job: new JobAdapter({
      publicClient: ctx.publicClient,
      clientWallet: ctx.wallets.buyer,
      evaluatorWallet: ctx.wallets.referee,
      sendClient: ctx.sendClient,
      jobContract: cfg.jobContract,
    }),
    publicClient: ctx.publicClient,
    wallets: ctx.wallets,
    addresses: ctx.addresses,
    usdc: cfg.usdc,
    jobContract: cfg.jobContract,
    chainId: cfg.chainId,
    identityRegistry: cfg.identityRegistry,
    explorerBase: explorerBase.replace(/\/+$/, ""),
  };
}

/**
 * THE KLEROS STAGE: the service the mode selects, with what the filing guards read beside it.
 *
 *  - `rehearsal`: the scripted fake; no deployment, no cap, no flag. With `realReads`, the named
 *    deployment's HTTP client instead, whose writes refuse before any request, for the key check.
 *  - `testnet` and `live`: the HTTP client with that deployment's key, its court, its cap and the
 *    flag a filing must be confirmed with.
 *
 * Only the key of the deployment being built is read from `cfg.kleros`, so a testnet run never
 * touches the live key, and a missing key is named by its variable, never by a value.
 */
export interface KlerosStage {
  mode: PilotKlerosMode;
  service: KlerosDisputeService;
  deployment: KlerosDeployment | null;
  cap: number | null;
  flag: "--testnet" | "--live" | null;
}

/** The script a rehearsal runs when none is named. */
const DEFAULT_SCRIPT: FakeScript = "pay";

export function buildKlerosService(
  cfg: Config,
  opts: { script?: FakeScript; realReads?: KlerosDeploymentName },
): KlerosStage {
  const pilot = cfg.pilot;
  if (!pilot)
    throw new Error(
      "refusing: the pilot keys are not set on this box (PILOT_BUYER_PRIVATE_KEY, PILOT_SELLER_PRIVATE_KEY, PILOT_REFEREE_PRIVATE_KEY)",
    );
  const mode = pilot.mode;
  if (mode === "rehearsal") {
    if (opts.realReads === undefined)
      return {
        mode,
        service: new FakeDisputeService({ script: opts.script ?? DEFAULT_SCRIPT }),
        deployment: null,
        cap: null,
        flag: null,
      };
    const { apiUrl, apiKey, deployment } = httpParts(cfg, opts.realReads);
    return {
      mode,
      service: new ReadOnlyHttpDisputeService({ apiUrl, apiKey, deployment: opts.realReads }),
      deployment,
      cap: null,
      flag: null,
    };
  }
  if (opts.realReads !== undefined)
    throw new Error(`refusing realReads in ${mode} mode: it is accepted in rehearsal mode only`);
  const { apiUrl, apiKey, deployment } = httpParts(cfg, mode);
  return {
    mode,
    service: new HttpDisputeService({ apiUrl, apiKey, deployment: mode }),
    deployment,
    cap: mode === "testnet" ? pilot.testnetCasesCap : pilot.liveCasesCap,
    flag: mode === "testnet" ? "--testnet" : "--live",
  };
}

/** The URL, the one key and the deployment of `name`, read property by property so the other
 *  deployment's key is never touched. */
function httpParts(
  cfg: Config,
  name: KlerosDeploymentName,
): { apiUrl: string; apiKey: string; deployment: KlerosDeployment } {
  const variable = name === "testnet" ? "KLEROS_API_KEY_TESTNET" : "KLEROS_API_KEY_LIVE";
  const kleros = cfg.kleros;
  if (!kleros)
    throw new Error(`refusing: the ${name} Kleros stage needs ${variable}, which is not set`);
  const apiKey = name === "testnet" ? kleros.apiKeyTestnet : kleros.apiKeyLive;
  if (!apiKey)
    throw new Error(`refusing: the ${name} Kleros stage needs ${variable}, which is not set`);
  const courtId = name === "testnet" ? kleros.courtIdTestnet : kleros.courtIdLive;
  return { apiUrl: kleros.apiUrl, apiKey, deployment: deploymentFor(name, courtId) };
}

/** The HTTP client with its three writes refused before any request: the key check reads only. */
class ReadOnlyHttpDisputeService extends HttpDisputeService {
  override async pin(): Promise<PinOutcome> {
    throw readOnly("evidence_pin");
  }
  override async createDispute(): Promise<CreateOutcome> {
    throw readOnly("dispute_create");
  }
  override async submitEvidence(): Promise<SubmitOutcome> {
    throw readOnly("evidence_submit");
  }
}

const readOnly = (tool: string) =>
  new Error(`refusing ${tool}: this Kleros client was built for reads only; nothing was sent`);
