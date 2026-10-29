/**
 * The legal-body flow's human gate, rendered as the server renders it.
 *
 * A record this product refuses must never read as a verified human: not in the shared status row
 * (with or without the flow's own sentence), and not on the step, which says why the record is
 * refused, offers Verify and never Continue. A deployment without World ID says so and offers no
 * button at all. The waiver is never offered here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

import { GetWorldIdHelp } from "@/components/guardian/GetWorldIdHelp";
import { WorldIdStatusRow } from "@/components/guardian/WorldIdGate";
import { HumanStep } from "@/components/legalBody/HumanStep";
import { LEGAL_BODY_COPY, PERSON_SENTENCES, fillCopy } from "@/lib/legalBody/copy";

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

/** U+2014, written as an escape. */
const EM_DASH = "\u2014";

const help = (props: { showWaiver?: boolean; defaultOpen?: boolean; comeBackSentence?: string }) =>
  renderToString(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(GetWorldIdHelp, props)),
  );
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the flow's human step reads without a dash", () => {
  test.each([
    ["accepted with the Orb", record()],
    ["accepted with a passport", record({ credential: "passport" })],
    ["accepted, the credential not named", record({ credential: undefined })],
    ["a waiver on record", record({ credential: "waiver", realHuman: false })],
    ["a credential the check refuses", record({ realHuman: false })],
    ["nobody on record", record({ verified: false, credential: undefined, realHuman: false })],
  ])("%s: nothing rendered carries an em dash", (_name, data) => {
    expect(step(data)).not.toContain(EM_DASH);
  });

  test("the accepted row is the flow's own sentence, about the person", () => {
    const out = step(record());
    expect(out).toContain(fillCopy(H.verifiedAs, { credential: "orb" }));
    expect(out).toContain("Verified human: orb");
    expect(PERSON_SENTENCES).toContain(H.verifiedAs);
  });

  test("the help, opened with the props the step passes, carries no em dash and offers no waiver", () => {
    const out = help({ showWaiver: false, defaultOpen: true, comeBackSentence: H.comeBack });
    expect(out).toContain(H.comeBack);
    expect(out).not.toContain(EM_DASH);
    expect(out).not.toContain("<form");
  });

  test("the step passes the help its own sentence, and the row its own line", () => {
    const code = readFileSync(
      fileURLToPath(new URL("../src/components/legalBody/HumanStep.tsx", import.meta.url)),
      "utf8",
    );
    expect(code).toContain("comeBackSentence={H.comeBack}");
    expect(code).toMatch(/acceptedLine=\{\(credential\) => fillCopy\(H\.verifiedAs, \{ credential \}\)\}/);
  });
});

describe("the onboarding wizard reads exactly as before", () => {
  const ICON =
    '<svg viewBox="0 0 16 16" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  const row = (tone: string, line: string) =>
    `<div class="flex items-center gap-2 text-[13px] ${tone}">${ICON}${line}</div>`;

  test.each([
    ["orb", row("text-emerald-300", `Verified human ${EM_DASH} orb`)],
    ["passport", row("text-emerald-300", `Verified human ${EM_DASH} passport`)],
    ["document", row("text-emerald-300", `Verified human ${EM_DASH} document`)],
    ["waiver", row("text-amber-300", `Guardian waiver on record ${EM_DASH} not a verified human`)],
    [null, row("text-emerald-300", `Verified human ${EM_DASH} proof of personhood`)],
  ] as const)("the status row with credential %s, byte for byte", (credential, markup) => {
    const state: WorldIdGateState = { kind: "accepted", credential };
    expect(renderToString(createElement(WorldIdStatusRow, { state }))).toBe(markup);
  });

  test("the help, opened and closed, with and without the waiver, byte for byte", () => {
    expect(sha256(help({ defaultOpen: true, showWaiver: true }))).toBe(
      "c76d722b46dc862e0e3768d8519e74bdb185da10cc279e20afe9a90502642ace",
    );
    expect(sha256(help({ defaultOpen: true, showWaiver: false }))).toBe(
      "b9155d801034662b2b0c29b7550c641eeabed28493a7cb3ac0c6764b7a7898bb",
    );
    for (const showWaiver of [true, false])
      expect(sha256(help({ showWaiver }))).toBe(
        "da771f03719227bf7cbff65b436b94486cace6e878462bf609339cd1fa5d8396",
      );
    expect(help({ defaultOpen: true })).toContain(
      `Come back to this page once World App shows your World ID and tap Verify ${EM_DASH} we keep your place.`,
    );
  });
});
