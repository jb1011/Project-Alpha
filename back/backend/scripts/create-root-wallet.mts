/**
 * One-off: create a single Ethereum wallet in the ROOT Turnkey org and print its address.
 *
 * Used to obtain a value for TURNKEY_SIGN_WITH when switching to a new org (the API server needs a
 * boot-time global operator signer; per-agent onboarding still uses per-agent sub-orgs).
 *
 * Reads creds straight from env (NOT loadConfig) so it works BEFORE TURNKEY_SIGN_WITH is set:
 *   TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, [TURNKEY_BASE_URL]
 *
 * Run:  npx tsx scripts/create-root-wallet.mts
 */
import "dotenv/config";
import { Turnkey } from "@turnkey/sdk-server";

const ETH_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const organizationId = req("TURNKEY_ORGANIZATION_ID");
  const client = new Turnkey({
    apiBaseUrl: process.env.TURNKEY_BASE_URL ?? "https://api.turnkey.com",
    apiPublicKey: req("TURNKEY_API_PUBLIC_KEY"),
    apiPrivateKey: req("TURNKEY_API_PRIVATE_KEY"),
    defaultOrganizationId: organizationId,
  }).apiClient();

  // biome-ignore lint/suspicious/noExplicitAny: Turnkey apiClient response is loosely typed
  const res: any = await client.createWallet({
    walletName: `boot-signer-${Date.now()}`,
    accounts: [ETH_ACCOUNT],
  });

  const address: string | undefined =
    res?.addresses?.[0] ?? res?.activity?.result?.createWalletResult?.addresses?.[0];
  const walletId: string | undefined =
    res?.walletId ?? res?.activity?.result?.createWalletResult?.walletId;

  if (!address) {
    console.error("Could not read an address from the response:");
    console.error(JSON.stringify(res, null, 2));
    process.exit(1);
  }

  console.log(`✅ Wallet created in org ${organizationId}`);
  console.log(`   walletId: ${walletId}`);
  console.log(`   address : ${address}`);
  console.log(`\nSet this in backend/.env:\n\nTURNKEY_SIGN_WITH=${address}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
