/**
 * The "Don't have a World ID?" disclosure, rendered as the server renders it.
 *
 * A flow that does not accept a waiver must not offer one: with `showWaiver` false the routes to
 * a real World ID stay and the waiver form is gone. The default keeps the wizard's form.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";

vi.mock("@/components/onboarding/AuthProvider", () => ({
  useAuth: () => ({ session: null, ensureSession: async () => ({ token: "t" }) }),
}));

import { GetWorldIdHelp } from "@/components/guardian/GetWorldIdHelp";

const WAIVER_LABEL = "Neither works where you live?";
const ROUTE = "Tap your passport in World App";

const html = (props: { showWaiver?: boolean }) =>
  renderToString(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(GetWorldIdHelp, { defaultOpen: true, ...props }),
    ),
  );

test("showWaiver false: the routes stay, the waiver form is gone", () => {
  const out = html({ showWaiver: false });
  expect(out).toContain(ROUTE);
  expect(out).not.toContain(WAIVER_LABEL);
  expect(out).not.toContain("<form");
});

test("by default the waiver form is offered, as the wizard does today", () => {
  const out = html({});
  expect(out).toContain(ROUTE);
  expect(out).toContain(WAIVER_LABEL);
  expect(out).toContain("<form");
});
