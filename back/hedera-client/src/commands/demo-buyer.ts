// DEMO ONLY (ETHOnline 2026, Hedera lane). Not part of the production build. Never run against a production database.
// The five-leg buyer that resolves a Novi Corpus company from its UAID and pays its /verify
// route, used only for the ETHOnline demo recording.
/**
 * `demo-buyer <uaid>` — the demo's buyer.
 *
 * The five legs (resolve, pay, pause and be refused, revoke, be refused on chain) land in
 * task 15. This file exists now so the command name, the demo-only header, the
 * `HEDERA_DEMO_LOCAL` guard and the production refusal are in place from the start and are
 * reviewed with the rest of the package rather than bolted on at the end.
 */

/**
 * Runs the demo buyer.
 *
 * @param argv - Command arguments; the first is the UAID to resolve
 * @returns Nothing; prints `DEMO ONLY` first, then refuses or runs
 */
export async function demoBuyer(argv: string[]) {
  console.log("DEMO ONLY");
  if (process.env.NODE_ENV === "production")
    throw new Error("demo-buyer refuses to run with NODE_ENV=production");
  if (process.env.HEDERA_DEMO_LOCAL !== "1")
    throw new Error("demo-buyer requires HEDERA_DEMO_LOCAL=1");
  const uaid = argv[0];
  if (!uaid) throw new Error("usage: novi-hedera demo-buyer <uaid>");
  throw new Error("demo-buyer lands in task 15; use `novi-hedera pay <url>` until then");
}
