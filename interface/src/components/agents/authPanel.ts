/**
 * The signed-out gate's ONE decision: which of the two wallet buttons is on screen, and whether it
 * is spinning.
 *
 * A pure function rather than three ternaries inline, because the bug it replaces was invisible in
 * the inline form: both buttons were given `loading={isLoggingIn}` — the flag only `login()` sets —
 * which reads as correct until you notice that `connectWallet()` never touches it. A connect then
 * has no pending state at all (so a second, third click each queue another `eth_requestAccounts`,
 * which MetaMask answers with -32002 and no visible change), and a login that is still waiting on
 * the wallet keeps the flag true — so if the wallet drops mid-signature, the same spinning,
 * disabled button re-labels itself "Connect wallet" and can never be clicked again.
 *
 * Hence the two rules below. The spinner belongs to the action that is in flight, and the panel
 * does not re-label itself out from under an action that has not finished.
 */

export type AuthPanelAction = "connect" | "login";

export type AuthPanelState = {
  /** Which handler the button runs. */
  action: AuthPanelAction;
  label: string;
  /** Drives BOTH the spinner and `disabled` — `Button` derives `disabled` from `loading`. */
  pending: boolean;
};

const LABELS: Record<AuthPanelAction, string> = {
  connect: "Connect wallet",
  login: "Sign in with wallet",
};

export function authPanelState(wallet: {
  isConnected: boolean;
  isConnecting: boolean;
  isLoggingIn: boolean;
}): AuthPanelState {
  // An in-flight action outranks the wallet's current state, in BOTH directions. A login survives
  // `isConnected` going false (a locked or dropped wallet mid-signature must not turn the sign-in
  // button into a stuck connect button); a connect survives `isConnected` going true (the accounts
  // resolve before the chain switch does, and the button should not move mid-click).
  const action: AuthPanelAction = wallet.isLoggingIn
    ? "login"
    : wallet.isConnecting
      ? "connect"
      : wallet.isConnected
        ? "login"
        : "connect";

  return {
    action,
    label: LABELS[action],
    pending: wallet.isConnecting || wallet.isLoggingIn,
  };
}
