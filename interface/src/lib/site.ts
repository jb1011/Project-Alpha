/** Public site origin. No trailing slash. */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://novicorpus.xyz"
).replace(/\/$/, "");

export const SITE_TITLE = "Novi Corpus: A company for your agent";

export const SITE_DESCRIPTION =
  "A legal entity for an AI agent. A Wyoming DAO LLC, spending rules the agent cannot break, and a USDC treasury on Arc. Live on testnet. Real filings are not on yet.";
