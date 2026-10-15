/**
 * The one way a sign screen gets typed data for the wallet.
 *
 * A gate takes the served answer and what the person chose, runs the field-by-field check, and
 * converts the typed data for wagmi only when the check passed. A screen never converts on its
 * own: it hands the gate's answer to `signThroughGate`, which opens the wallet only for an open
 * gate. So typed data the check refused has no path to the wallet at all, and a test pins it with
 * a spy in the wallet's place.
 *
 * The shape is generic: both gates are here, the statement of authority's and the link's.
 */
import type { Hex, LinkMessageResult, StatementMessageAnswer } from "@/lib/api/types";
import type { Refusal } from "./chain";
import type { OwnerBranch } from "./flow";
import { identityOwnerCheck } from "./link";
import {
  assertLinkTypedData,
  assertStatementTypedData,
  toWagmiLinkTypedData,
  toWagmiStatementTypedData,
  type WagmiLinkTypedData,
  type WagmiStatementTypedData,
} from "./typedData";

/** The typed data to sign, converted, or the check's refusal and nothing to sign. */
export type SignGate<T> = { ok: true; typedData: T } | Refusal;

/** What the statement is checked against: the deployment, the wallet in session, what the person
 *  typed, and this browser's clock in seconds. */
export type StatementGateContext = Parameters<typeof assertStatementTypedData>[1];

/** The statement of authority, checked, then converted for wagmi. */
export function statementSignGate(
  served: StatementMessageAnswer,
  ctx: StatementGateContext,
): SignGate<WagmiStatementTypedData> {
  const checked = assertStatementTypedData(served, ctx);
  if (!checked.ok) return checked;
  return { ok: true, typedData: toWagmiStatementTypedData(served.typedData) };
}

/** What the link is checked against: the order, the agreement read, the wallet in session, the
 *  identity picked, this browser's clock, the served ceiling, and who signs. */
export type LinkGateContext = Parameters<typeof assertLinkTypedData>[1] & { branch: OwnerBranch };

/**
 * The link, checked field by field; then, on the browser branch, the identity's owner the door
 * read against the wallet in session (the wallet that is about to sign); then converted for
 * wagmi. The first refusal is the answer, and nothing is converted.
 */
export function linkSignGate(
  served: LinkMessageResult,
  ctx: LinkGateContext,
): SignGate<WagmiLinkTypedData> {
  const checked = assertLinkTypedData(served, ctx);
  if (!checked.ok) return checked;
  const owner = identityOwnerCheck(served, { branch: ctx.branch, sessionAddress: ctx.sessionAddress });
  if (!owner.ok) return owner;
  return { ok: true, typedData: toWagmiLinkTypedData(served.typedData) };
}

/**
 * - `signed`: the wallet signed the gate's typed data, which is returned beside the signature;
 * - `refused`: the gate was closed, and the wallet was never opened;
 * - `declined`: the wallet was opened and did not sign (the person said no, or the wallet failed).
 */
export type SignOutcome<T> =
  | { kind: "signed"; typedData: T; signature: Hex }
  | { kind: "refused"; problem: string }
  | { kind: "declined" };

/** The wallet opened for an open gate only, with the gate's own typed data, once. */
export async function signThroughGate<T>(
  gate: SignGate<T>,
  sign: (typedData: T) => Promise<Hex>,
): Promise<SignOutcome<T>> {
  if (!gate.ok) return { kind: "refused", problem: gate.problem };
  try {
    const signature = await sign(gate.typedData);
    return { kind: "signed", typedData: gate.typedData, signature };
  } catch {
    return { kind: "declined" };
  }
}
