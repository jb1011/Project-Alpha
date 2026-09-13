/**
 * The client's own mirror-node reads, and the testnet wiring the commands share.
 *
 * The mirror node is the free REST view of Hedera consensus. `provision` uses it to see
 * the hollow account appear and to read back the key list; nothing here signs.
 */

/** Base of the mirror node's REST API. Public value, overridable for a private mirror. */
export const mirrorBase = () =>
  `${(process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/+$/, "")}/api/v1`;

/**
 * HashScan link for a transaction id, in either the `@` or the `-` spelling.
 *
 * @param txId - The Hedera transaction id
 * @returns A testnet HashScan URL
 */
export const hashscan = (txId: string) => `https://hashscan.io/testnet/transaction/${txId}`;

/**
 * Reads an environment variable, or stops with a message naming it.
 *
 * Values arrive from `op run --env-file=.env.tpl`; nothing here reads a file.
 *
 * @param name - The variable's name
 * @returns Its value
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run under \`op run --env-file=.env.tpl --\`)`);
  return v;
}

/** A mirror-node account, as much of it as this package reads. */
export type MirrorAccount = {
  account: string;
  key: { _type?: string; key?: string } | null;
  max_automatic_token_associations?: number;
};

/**
 * GETs a mirror-node path, treating 404 as "not there yet".
 *
 * @param path - A path under `/api/v1`, leading slash included
 * @returns The parsed body, or `null` on 404
 */
export async function mirror<T>(path: string): Promise<T | null> {
  const r = await fetch(`${mirrorBase()}${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`mirror ${path} -> ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Polls a mirror-node path until it answers with something.
 *
 * @param path - A path under `/api/v1`
 * @param tries - How many times to ask, 1.5 seconds apart
 * @returns The parsed body, or `null` if it never appeared
 */
export async function waitMirror<T>(path: string, tries = 20): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = await mirror<T>(path);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * How the mirror node describes an account's key, for the provision command's last line.
 *
 * The mirror node reports a key list only as `ProtobufEncoded`, so this line is a shape
 * hint and not a check. What actually validates the 1-of-2 (threshold 1, exactly two
 * distinct keys, the agent's among them) is `link_hedera_account` on the server, D24.
 *
 * @param acct - A mirror-node account, or `null`
 * @returns `ThresholdKey(1 of 2)` for a key list, the key type otherwise
 */
export function describeKey(acct: MirrorAccount | null): string {
  if (!acct?.key) return "NULL (hollow)";
  return acct.key._type === "ProtobufEncoded" ? "ThresholdKey(1 of 2)" : (acct.key._type ?? "set");
}
