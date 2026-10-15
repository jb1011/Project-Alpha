import { ApiError, type WorldIdMe } from "@/lib/api/types";

/**
 * The World ID gate, decided in one place for every flow that asks for a person.
 *
 * Two flows read the same guardian record (`/world-id/me`) and ask it different questions:
 *
 * - the onboarding wizard accepts any row on record, a waiver included (shown in amber), and on a
 *   deployment without World ID it skips the step;
 * - a flow that needs a real person (`requireRealHuman`) accepts only what the server's own
 *   real-human check accepts (`realHuman === true`), and on a deployment without World ID it
 *   stops (`forceRequired`): there is no way forward there, so there is no skip either.
 *
 * A screen keys its title on `accepted`, never on `verified`: under `requireRealHuman` a row can
 * be on record and still not be accepted, and a title that said otherwise would be a claim the
 * server refuses at the next door.
 */

export type WorldIdGateInput = {
  me: WorldIdMe | null;
  meStatus: "loading" | "ok" | "missing" | "error";
  requireRealHuman: boolean;
  forceRequired: boolean;
};

export type WorldIdGateState =
  | { kind: "loading" }
  /** No World ID on this deployment (404) under `forceRequired`: a stop, not a skip. */
  | { kind: "unavailable" }
  /** No World ID on this deployment, and the flow may go on without it (the wizard). */
  | { kind: "skip" }
  | { kind: "error" }
  /** No row on record. `required` is `forceRequired || me.required`. */
  | { kind: "verify"; required: boolean }
  /** A row this gate refuses: a waiver, or `realHuman` false or absent, under `requireRealHuman`. */
  | { kind: "not_accepted"; credential: string | null }
  | { kind: "accepted"; credential: string | null };

export function worldIdGateState(i: WorldIdGateInput): WorldIdGateState {
  // The status decides first: a row cached from an earlier read never hides a load, a failure,
  // or a deployment that no longer serves the record at all.
  if (i.meStatus === "loading") return { kind: "loading" };
  if (i.meStatus === "error") return { kind: "error" };
  if (i.meStatus === "missing") return i.forceRequired ? { kind: "unavailable" } : { kind: "skip" };

  const me = i.me;
  // "ok" with nothing to read yet is not a decision.
  if (!me) return { kind: "loading" };
  if (!me.verified) return { kind: "verify", required: i.forceRequired || me.required };

  const credential = me.credential ?? null;
  // Under `requireRealHuman` only the server's own answer counts. An older backend that does not
  // serve `realHuman` gives no answer, and no answer is not a yes.
  const accepted = i.requireRealHuman ? me.realHuman === true : me.verified;
  return accepted ? { kind: "accepted", credential } : { kind: "not_accepted", credential };
}

/**
 * The record's read, as the gate's input status.
 *
 * A 404 means this deployment serves no World ID route, so it wins over a record cached from an
 * earlier read. Any other failure keeps a record already in hand (a refetch that failed does not
 * erase what was read), and is an error only when there is no record to show.
 */
export function worldIdMeStatus(me: WorldIdMe | null, error: unknown): WorldIdGateInput["meStatus"] {
  if (error instanceof ApiError && error.status === 404) return "missing";
  if (me) return "ok";
  if (error) return "error";
  return "loading";
}
