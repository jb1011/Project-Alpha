/**
 * The wallet sign-in card's state machine, and the rule a screen gates on.
 *
 * An attempt is a connect or a sign-in that is under way (`connecting`) or that failed (`error`).
 * A stored session can meet a wallet that is locked or not yet rehydrated, so the card can offer
 * "Connect wallet" while a session exists. During that attempt, and after it failed, the card's
 * badge is not signed in, and a screen around the card must not be either. The card's badge reads
 * `walletStateOf(...) === "logged-in"` and the screen reads `walletSignedIn`; a test over all
 * twelve combinations of attempt, session and connection proves the two equal.
 */

export type WalletAttempt = "connecting" | "error" | null;

export type WalletState = "idle" | "connecting" | "connected" | "logged-in" | "error";

export function walletStateOf(
  attempt: WalletAttempt,
  hasSession: boolean,
  isConnected: boolean,
): WalletState {
  return attempt === "connecting"
    ? "connecting"
    : attempt === "error"
      ? "error"
      : hasSession
        ? "logged-in"
        : isConnected
          ? "connected"
          : "idle";
}

/** Signed in: a session, and no attempt under way or failed. */
export function walletSignedIn(hasSession: boolean, attempt: WalletAttempt): boolean {
  return hasSession && attempt === null;
}

/** Where an attempt reports: the attempt's state, and its error (`null` when a new one starts). */
export type AttemptReport = {
  attempt(next: WalletAttempt): void;
  error(message: string | null): void;
};

export async function connectAttempt(
  connectWallet: () => Promise<void>,
  report: AttemptReport,
): Promise<void> {
  report.error(null);
  report.attempt("connecting");
  try {
    await connectWallet();
    report.attempt(null);
  } catch (e) {
    report.attempt("error");
    report.error(e instanceof Error ? e.message : "Wallet connection failed.");
  }
}

export async function signInAttempt(
  login: () => Promise<void>,
  report: AttemptReport,
): Promise<void> {
  report.error(null);
  report.attempt(null);
  try {
    await login();
  } catch (e) {
    report.attempt("error");
    report.error(e instanceof Error ? e.message : "Sign-in failed.");
  }
}
