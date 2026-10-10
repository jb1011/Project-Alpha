/**
 * The auth gate's hydration contract, from the server side.
 *
 * The session lives in sessionStorage, which the server cannot read, so the server must never
 * decide: whatever the client will find, the markup it hydrates against is the loading state.
 * `renderToString` is what the server does, and it needs no DOM.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const auth = {
  session: null as { token: string } | null,
  isConnected: false,
  isConnecting: false,
  isLoggingIn: false,
  connectWallet: async () => {},
  login: async () => {},
};
vi.mock("@/components/onboarding/AuthProvider", () => ({ useAuth: () => auth }));

import { RequireAuth } from "@/components/agents/RequireAuth";

const html = () =>
  renderToString(createElement(RequireAuth, null, createElement("p", null, "the guarded page")));

test("server render with a session on hand still shows the loading state, not the page", () => {
  auth.session = { token: "t" };
  const out = html();
  expect(out).toContain("Loading…");
  expect(out).not.toContain("the guarded page");
  expect(out).not.toContain("Sign in to continue");
});

test("server render with no session shows the loading state, not the sign-in panel", () => {
  auth.session = null;
  auth.isConnected = true;
  const out = html();
  expect(out).toContain("Loading…");
  expect(out).not.toContain("Sign in to continue");
  expect(out).not.toContain("the guarded page");
});
