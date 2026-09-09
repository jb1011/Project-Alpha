/**
 * Which button the signed-out gate shows, and which one is allowed to spin.
 *
 * The bug this is written against: `RequireAuth` gave BOTH of its buttons `loading={isLoggingIn}`
 * — a flag only `login()` ever set. Two consequences, and the founder hit both on prod. A connect
 * showed no feedback at all, so an impatient second click queued a second `eth_requestAccounts`
 * that MetaMask answers with -32002 and nothing on screen ever changed. And a signature request
 * left pending in the wallet kept `isLoggingIn` true; when the wallet then dropped or locked,
 * `isConnected` flipped false and the SAME spinning, disabled button re-labelled itself
 * "Connect wallet" — a connect button, spinning forever, that could no longer be clicked.
 *
 * So the rule these assert is one rule seen from two sides: the spinner belongs to the action that
 * is actually in flight, and the panel never re-labels itself out from under an in-flight action.
 */
import { expect, test } from "vitest";
import { authPanelState } from "@/components/agents/authPanel";

const state = (over: {
  isConnected?: boolean;
  isConnecting?: boolean;
  isLoggingIn?: boolean;
} = {}) =>
  authPanelState({
    isConnected: false,
    isConnecting: false,
    isLoggingIn: false,
    ...over,
  });

test("G1: idle and disconnected — the connect button, not spinning", () => {
  expect(state()).toEqual({ action: "connect", label: "Connect wallet", pending: false });
});

test("G1: idle and connected — the sign-in button, not spinning", () => {
  expect(state({ isConnected: true })).toEqual({
    action: "login",
    label: "Sign in with wallet",
    pending: false,
  });
});

test("G2: a connect in flight spins the CONNECT button", () => {
  // Before the fix this was unreachable: no flag was set around `connectWallet` at all, so the
  // connect button was permanently idle-looking however long the wallet took.
  expect(state({ isConnecting: true })).toEqual({
    action: "connect",
    label: "Connect wallet",
    pending: true,
  });
});

test("G2: a connect still finishing its chain switch does not flip to the sign-in button", () => {
  // `connectAsync` resolves the accounts before the `wallet_switchEthereumChain` leg finishes, so
  // `isConnected` goes true while `connectWallet()` is still running. Swapping the label at that
  // moment moves a button under a cursor that is already on it.
  expect(state({ isConnected: true, isConnecting: true })).toMatchObject({
    action: "connect",
    pending: true,
  });
});

test("G3: a login in flight spins the SIGN-IN button", () => {
  expect(state({ isConnected: true, isLoggingIn: true })).toEqual({
    action: "login",
    label: "Sign in with wallet",
    pending: true,
  });
});

test("G3: THE BUG — a pending signature whose wallet dropped is never a spinning connect button", () => {
  // `login()` clears `isLoggingIn` in a `finally` that only runs when the wallet promise settles.
  // A `personal_sign` that never surfaces (MetaMask's popup suppressed in Brave) leaves it true
  // indefinitely; if the account locks meanwhile, `isConnected` is false. The old wiring rendered
  // that as "Connect wallet" + spinner + disabled, with no way out short of a reload.
  const panel = state({ isConnected: false, isLoggingIn: true });
  expect(panel.action).toBe("login");
  expect(panel.label).toBe("Sign in with wallet");
});

test("G4: the two flags are never cross-wired — `pending` is exactly 'something is in flight'", () => {
  for (const isConnected of [false, true]) {
    for (const isConnecting of [false, true]) {
      for (const isLoggingIn of [false, true]) {
        const panel = authPanelState({ isConnected, isConnecting, isLoggingIn });
        expect(panel.pending).toBe(isConnecting || isLoggingIn);
        // Whichever action is in flight is the one on screen, so the spinner always sits on the
        // button whose work it describes.
        if (isLoggingIn) expect(panel.action).toBe("login");
        else if (isConnecting) expect(panel.action).toBe("connect");
      }
    }
  }
});
