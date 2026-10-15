/**
 * The one way a sign screen gets typed data for the wallet.
 *
 * A gate takes the served answer and what the person chose, runs the field-by-field check, and
 * converts the typed data for wagmi only when the check passed. A screen never converts on its
 * own: it hands the gate's answer to `signThroughGate`, which opens the wallet only for an open
 * gate. So typed data the check refused has no path to the wallet at all, and a test pins it with
 * a spy in the wallet's place.
 *
 * The shape is generic: the statement of authority's gate is here, and the link's takes the same
 * shape.
 */
import type { Hex, StatementMessageAnswer } from "@/lib/api/types";
import type { Refusal } from "./chain";
import {
  assertStatementTypedData,
  toWagmiStatementTypedData,
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
