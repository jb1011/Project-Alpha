// DEMO ONLY (ETHOnline 2026, Hedera lane). Not part of the production build. Never run against a production database.
// Seeds one local database row from public data only (the prod /transparency endpoint and public Arc-testnet chain reads) so a local backend can answer GET /verify/:publicId before PR 1 merges.
import { pathToFileURL } from "node:url";
import { http, type Address, createPublicClient, getAddress } from "viem";
import { legalManagerAbi, legalManagerFactoryAbi } from "../../src/abis/generated";
import { arcTestnet } from "../../src/chains";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

const PROD_TRANSPARENCY_URL = "https://www.novicorpus.com/backend/transparency";
const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";

/** The one shape buildSeedRecord needs out of a `/transparency` row. */
export interface TransparencyEntity {
  publicId: string;
  name: string;
  agentId: string;
}

/** Demo-only artifacts must not run by accident (global constraint). */
export function assertDemoGuard(env: NodeJS.ProcessEnv): void {
  if (env.HEDERA_DEMO_LOCAL !== "1") {
    throw new Error("DEMO ONLY: set HEDERA_DEMO_LOCAL=1 to run this script");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("DEMO ONLY: refuses to run with NODE_ENV=production");
  }
}

/**
 * Pure mapping from public data to one locally-seeded `EntityRecord` row (task 6b).
 *
 * Every key-material field (Turnkey/Circle ids, the pocket address, the Hedera link/identity
 * fields) and every formation/party-adjacent field (spec JSON, company id, EIN filing data) is
 * null: this row exists only so a local `/verify` can answer about a `publicId`, never to onboard
 * or transact as the entity it describes. `ein`/`formationDate`/`oaHash` are not on-chain reads
 * this script performs (out of scope, see the task report) and are filled with clearly-labeled
 * placeholders that a real onboarding would never produce.
 */
export function buildSeedRecord(input: {
  transparency: TransparencyEntity;
  proxy: Address;
  treasury: Address;
  manager: Address;
  guardian: Address;
  tenant: Address;
}): EntityRecord {
  const { transparency, proxy, treasury, manager, guardian, tenant } = input;
  return {
    idempotencyKey: `${tenant}:${transparency.name}`,
    name: `DEMO-LOCAL ${transparency.name}`,
    status: "funded",
    manager,
    guardian,
    operator: null,
    amendmentDelay: "0",
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: transparency.agentId,
    proxy,
    treasury,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: tenant,
    error: null,
    specJson: null,
    perTxCap: null,
    trustPolicy: null,
    rootPasskeyId: null,
    walletProvider: "circle",
    circleWalletSetId: null,
    circleOperatorWalletId: null,
    circlePocketWalletId: null,
    pocketAddress: null,
    previousOperator: null,
    operatorRotatedAt: null,
    publicId: transparency.publicId,
    companyId: null,
    formationProvider: null,
    formationEnvironment: null,
    einReal: null,
    formationFiledAt: null,
    formationFilingNumber: null,
    oaManifestVersion: null,
    oaManifestAnchoredHash: null,
    oaManifestPendingHash: null,
    oaManifestPendingVersion: null,
    oaAmendmentExecutableAt: null,
    hederaAccountId: null,
    hederaAgentPublicKey: null,
    hederaGuardianPublicKey: null,
    hederaLinkedAt: null,
    hederaAgentId: null,
    hederaRegisterTx: null,
    uaid: null,
  };
}

function usageAndExit(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { publicId: string; tenant: Address } {
  let publicId: string | undefined;
  let tenantRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from-prod") publicId = argv[++i];
    else if (argv[i] === "--tenant") tenantRaw = argv[++i];
  }
  if (!publicId || !tenantRaw) {
    usageAndExit("usage: seed-public-entity.mts --from-prod <publicId> --tenant <address>");
  }
  let tenant: Address;
  try {
    tenant = getAddress(tenantRaw);
  } catch {
    usageAndExit(`invalid --tenant address: ${tenantRaw}`);
  }
  return { publicId, tenant };
}

async function fetchTransparencyEntity(publicId: string): Promise<TransparencyEntity> {
  const res = await fetch(PROD_TRANSPARENCY_URL);
  if (!res.ok) usageAndExit(`failed to fetch ${PROD_TRANSPARENCY_URL}: HTTP ${res.status}`);
  const body = (await res.json()) as {
    entities?: Array<{ publicId?: string | null; name?: string; agentId?: string }>;
  };
  const found = body.entities?.find((e) => e.publicId === publicId);
  if (!found?.name || !found.agentId) usageAndExit("entity not found on /transparency");
  return { publicId, name: found.name, agentId: found.agentId };
}

export async function main(): Promise<void> {
  // The label goes out BEFORE the guard, so even a refused run says on its first line what this
  // script is. Matches `hedera-client`'s `demo-buyer` command, which labels itself the same way.
  console.log("DEMO ONLY");
  assertDemoGuard(process.env);

  const { publicId, tenant } = parseArgs(process.argv.slice(2));
  const transparency = await fetchTransparencyEntity(publicId);

  const factoryAddressRaw = process.env.FACTORY_ADDRESS;
  if (!factoryAddressRaw) {
    usageAndExit("set FACTORY_ADDRESS (the Arc testnet factory's address; public, not a secret)");
  }
  const factoryAddress = getAddress(factoryAddressRaw);

  const client = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC_URL) });
  const agentId = BigInt(transparency.agentId);

  // Proxy and treasury come straight off the factory's own agent-id lookups — no event-log
  // fallback is needed because both reads exist on this ABI (checked against src/abis/generated.ts
  // before writing this script).
  const [proxy, treasury] = await Promise.all([
    client.readContract({
      address: factoryAddress,
      abi: legalManagerFactoryAbi,
      functionName: "entityByAgentId",
      args: [agentId],
    }),
    client.readContract({
      address: factoryAddress,
      abi: legalManagerFactoryAbi,
      functionName: "treasuryByAgentId",
      args: [agentId],
    }),
  ]);

  // Manager and guardian are the proxy's own role getters.
  const [manager, guardian] = await Promise.all([
    client.readContract({ address: proxy, abi: legalManagerAbi, functionName: "manager" }),
    client.readContract({ address: proxy, abi: legalManagerAbi, functionName: "guardian" }),
  ]);

  const record = buildSeedRecord({ transparency, proxy, treasury, manager, guardian, tenant });

  const dataDir = process.env.DATA_DIR ?? "./data";
  const db = openDatabase(`${dataDir}/legalbody.db`);
  migrate(db);
  new SqliteEntityRepository(db).upsert(record);

  console.log(`seeded DEMO-LOCAL ${transparency.name} publicId ${publicId} treasury ${treasury}`);
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
