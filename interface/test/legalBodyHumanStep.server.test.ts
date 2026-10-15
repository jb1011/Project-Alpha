/**
 * The legal-body flow's human gate, rendered as the server renders it.
 *
 * A record this product refuses must never read as a verified human: not in the shared status row
 * (with or without the flow's own sentence), and not on the step, which says why the record is
 * refused, offers Verify and never Continue. A deployment without World ID says so and offers no
 * button at all. The waiver is never offered here.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";
import { ApiError, type WorldIdMe } from "@/lib/api/types";
import type { WorldIdGateState } from "@/lib/legalBody/worldIdGate";

const me = vi.hoisted(() => ({
  current: { data: undefined as unknown, error: null as unknown },
}));

vi.mock("@/components/onboarding/AuthProvider", () => ({
  useAuth: () => ({
    session: { token: "t", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", expiresAt: 0 },
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    ensureSession: async () => ({ token: "t" }),
  }),
}));

vi.mock("@/lib/api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/hooks")>()),
  useWorldIdMeQuery: () => ({ data: me.current.data, error: me.current.error, refetch: async () => undefined }),
}));

import { WorldIdStatusRow } from "@/components/guardian/WorldIdGate";
import { HumanStep } from "@/components/legalBody/HumanStep";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

const H = LEGAL_BODY_COPY.human;

const record = (over: Partial<WorldIdMe> = {}): WorldIdMe => ({
  verified: true,
  required: true,
  credential: "orb",
  realHuman: true,
  ...over,
});

function step(data: WorldIdMe | undefined, error: unknown = null): string {
  me.current = { data, error };
  return renderToString(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(HumanStep, { onEngage: () => {}, onContinue: () => {}, onBack: () => {} }),
    ),
  );
}

/** A button's label as React renders it, so a sentence that contains the word does not count. */
const button = (label: string) => new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`, "s");

describe("WorldIdStatusRow: a refused record never reads as a verified human", () => {
  const credentials = ["orb", "passport", "document", "waiver", null];

  test.each(credentials)("credential %s, without a sentence: no record line", (credential) => {
    const state: WorldIdGateState = { kind: "not_accepted", credential };
    const out = renderToString(createElement(WorldIdStatusRow, { state }));
    expect(out).not.toContain("Verified human");
    expect(out).not.toContain("proof of personhood");
  });

  test.each(credentials)("credential %s, with the flow's sentence: the sentence only", (credential) => {
    const state: WorldIdGateState = { kind: "not_accepted", credential };
    const out = renderToString(createElement(WorldIdStatusRow, { state, notAcceptedSentence: H.notAccepted }));
    expect(out).not.toContain("Verified human");
    expect(out).toContain(H.notAccepted);
  });
});

describe("HumanStep", () => {
  test("a waiver on record: refused, said why, Verify offered, never Continue, no waiver form", () => {
    const out = step(record({ credential: "waiver", realHuman: false }));
    expect(out).toContain(H.notAccepted);
    expect(out).toContain(H.product);
    expect(out).not.toContain("Verified human");
    expect(out).toMatch(button(H.verify));
    expect(out).not.toMatch(button(H.continue));
    expect(out).not.toContain("<form");
  });

  test("a real credential the real-human check refuses: the same", () => {
    const out = step(record({ credential: "passport", realHuman: false }));
    expect(out).toContain(H.notAccepted);
    expect(out).not.toContain("Verified human");
    expect(out).not.toMatch(button(H.continue));
  });

  test("an older backend that does not say: refused, never assumed", () => {
    const out = step(record({ realHuman: undefined }));
    expect(out).toContain(H.notAccepted);
    expect(out).not.toMatch(button(H.continue));
  });

  test("accepted: the person's record and Continue", () => {
    const out = step(record());
    expect(out).toContain("Verified human");
    expect(out).toContain(H.titleAccepted);
    expect(out).toMatch(button(H.continue));
    expect(out).not.toMatch(button(H.verify));
  });

  test("nobody on record: the product sentence, the points and Verify", () => {
    const out = step(record({ verified: false, credential: undefined, realHuman: false }));
    expect(out).toContain(H.product);
    for (const point of H.points) expect(out).toContain(point.replace(/'/g, "&#x27;"));
    expect(out).toMatch(button(H.verify));
    expect(out).not.toMatch(button(H.continue));
  });

  test("no World ID on this deployment: its sentence and no button but Back", () => {
    const out = step(undefined, new ApiError(404, { code: "not_found", message: "Not found" }));
    expect(out).toContain(H.unavailable);
    expect(out).not.toMatch(button(H.verify));
    expect(out).not.toMatch(button(H.continue));
  });
});
