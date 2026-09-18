#!/usr/bin/env -S npx tsx
/**
 * `novi-hedera` — the customer-side commands for the Hedera rail.
 *
 * Every command reads its configuration from the environment and is meant to run under
 * `op run --env-file=.env.tpl -- npx tsx src/cli.ts <command>`. No command reads a `.env`
 * file, and none prints a key.
 */
import { demoBuyer } from "./commands/demo-buyer.js";
import { link } from "./commands/link.js";
import { pay } from "./commands/pay.js";
import { provision } from "./commands/provision.js";
import { revoke } from "./commands/revoke.js";

const USAGE = `usage: novi-hedera <command>

  provision [--memo-only]   create the float account, set the 1-of-2 key list, set the HCS-11 memo
  link                      record the float account on the legal body
  revoke                    guardian rotates the agent key out of the key list
  pay <url>                 fetch a paid resource, settling its x402 invoice
  demo-buyer <uaid>         DEMO ONLY: the ETHOnline five-leg buyer
`;

const [command, ...argv] = process.argv.slice(2);

/**
 * Dispatches one command.
 *
 * @returns Nothing; each command prints its own output
 */
async function main() {
  switch (command) {
    case "provision":
      return provision(argv);
    case "link":
      return link();
    case "revoke":
      return revoke();
    case "pay":
      return pay(argv);
    case "demo-buyer":
      return demoBuyer(argv);
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message ?? e);
  process.exitCode = 1;
});
