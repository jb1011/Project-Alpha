/**
 * `link` — tell the legal body which Hedera float account it now has.
 *
 * The only values that cross to Novi Corpus are the account id and the agent's PUBLIC key.
 * The server reads the account from the mirror node and refuses anything that is not a
 * 1-of-2 key list holding that public key (design D24), then records the guardian's key as
 * the other member.
 */
import { PrivateKey } from "@x402/hedera";
import { requireEnv } from "../mirror.js";
import { createNoviClient } from "../novi.js";

/**
 * Runs the link command.
 *
 * @returns Nothing; prints the tool's JSON answer
 */
export async function link() {
  const publicKey = PrivateKey.fromStringECDSA(
    requireEnv("AGENT_PRIVATE_KEY"),
  ).publicKey.toStringRaw();
  const novi = createNoviClient({
    mcpUrl: requireEnv("NOVI_MCP_URL"),
    apiKey: requireEnv("NOVI_API_KEY"),
  });
  try {
    const answer = await novi.linkHederaAccount({
      id: requireEnv("NOVI_ENTITY_ID"),
      accountId: requireEnv("AGENT_ACCOUNT_ID"),
      publicKey,
    });
    console.log(JSON.stringify(answer));
  } finally {
    await novi.close();
  }
}
