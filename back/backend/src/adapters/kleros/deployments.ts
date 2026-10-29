/**
 * The two Kleros Dispute Service deployments, one per key.
 *
 * Constants in code, selected by the mode and never typed in the env. The chain decides whose
 * Court a case lives in: a read sent to the wrong chain is a read of someone else's case, so the
 * chain is never overridable. The court id is a fact of the key's preset that Kleros may
 * renumber, so config may override it (`deploymentFor`).
 */

export type KlerosChain = "arbitrum-one" | "arbitrum-sepolia-testnet";
/** What a read may name: a real chain, or "fake" for a rehearsal row (only the fake answers it). */
export type KlerosReadChain = KlerosChain | "fake";
export type KlerosDeploymentName = "testnet" | "live";

export interface KlerosDeployment {
  chain: KlerosChain;
  courtId: number;
  jurors: number;
  /** Public words: an operator sees them, and they may be stored with a case. */
  label: string;
  /** The Court interface's case page prefix: a case URL is `<courtUrlBase><coreDisputeId>/overview`. */
  courtUrlBase: string;
}

/**
 * The two deployments Kleros configured, one per key. courtId defaults are 8 and 34 and may be
 * overridden from config; the chain never is. Frozen, rows included: a mutated row would silently
 * point every later case at another court.
 */
export const KLEROS_DEPLOYMENTS: Readonly<
  Record<KlerosDeploymentName, Readonly<KlerosDeployment>>
> = Object.freeze({
  testnet: Object.freeze({
    chain: "arbitrum-sepolia-testnet",
    courtId: 8,
    jurors: 5,
    label: "Kleros testnet court",
    courtUrlBase: "https://v2-testnet.kleros.builders/#/cases/",
  }),
  live: Object.freeze({
    chain: "arbitrum-one",
    courtId: 34,
    jurors: 5,
    label: "Kleros Agentic Commerce Court",
    courtUrlBase: "https://v2.kleros.builders/#/cases/",
  }),
});

/**
 * The named deployment as a fresh object the caller owns, with the court id override applied
 * when one is given. The override comes from config, so anything but a positive safe integer is
 * refused rather than sent to Kleros as a court.
 */
export function deploymentFor(
  name: KlerosDeploymentName,
  courtIdOverride?: number,
): KlerosDeployment {
  // `name` may come from the environment at run time; an own-property check keeps "toString"
  // and friends from resolving to something that is not a row.
  if (!Object.hasOwn(KLEROS_DEPLOYMENTS, name)) {
    throw new Error(`unknown Kleros deployment ${JSON.stringify(name)}`);
  }
  const row = KLEROS_DEPLOYMENTS[name];
  if (courtIdOverride === undefined) return { ...row };
  if (!Number.isSafeInteger(courtIdOverride) || courtIdOverride <= 0) {
    throw new Error(
      `Kleros court id override must be a positive integer, got ${String(courtIdOverride)}`,
    );
  }
  return { ...row, courtId: courtIdOverride };
}

/**
 * The Court interface page of a case: `<courtUrlBase><coreDisputeId>/overview` for the chain's
 * deployment (pattern checked on public cases 186 on the testnet and 287 on arbitrum-one). The id
 * is a decimal number; anything else is refused, never turned into a link.
 */
export function klerosCaseUrl(chain: KlerosChain, coreDisputeId: string): string {
  const row = Object.values(KLEROS_DEPLOYMENTS).find((d) => d.chain === chain);
  if (!row) throw new Error(`no Kleros Court interface for chain ${JSON.stringify(chain)}`);
  if (!/^[0-9]+$/.test(coreDisputeId)) {
    throw new Error(
      `Kleros coreDisputeId must be a decimal number, got ${JSON.stringify(coreDisputeId)}`,
    );
  }
  return `${row.courtUrlBase}${coreDisputeId}/overview`;
}
