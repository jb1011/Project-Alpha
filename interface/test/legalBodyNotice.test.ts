/**
 * The sixteen notices of the legal-body flow: each has a title and a body on both environments,
 * and each offers its own way out: a new order, a new declaration, or nothing.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ClosedNotice } from "@/components/legalBody/ClosedNotice";
import type { CheckReasonCode, LapseReason } from "@/lib/api/types";
import { CHECK_REASON_SENTENCES, LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { closedSentence, noticeSentence } from "@/lib/legalBody/notice";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";

type Kind = LegalBodyNotice["kind"];

/** One notice per kind, and the way out it must offer. */
const KINDS: [LegalBodyNotice, "new_order" | "new_company" | "none"][] = [
  [{ kind: "expired" }, "new_order"],
  [{ kind: "lapsed", reason: "deadline_passed" }, "new_order"],
  [{ kind: "superseded", by: "lbo_newer" }, "new_order"],
  [{ kind: "replaced", by: "lbo_newer" }, "new_order"],
  [{ kind: "abandoned" }, "new_order"],
  [{ kind: "order_revoked" }, "new_order"],
  // Placed under another chain or factory: a new order is placed under this one.
  [{ kind: "other_deployment" }, "new_order"],
  // The company step: a failed, revoked or abandoned company is declared again.
  [{ kind: "company_failed", reasonCode: "name_mismatch" }, "new_company"],
  [{ kind: "company_revoked" }, "new_company"],
  [{ kind: "company_abandoned" }, "new_company"],
  // Waiting is not a dead end: the check is on its way, so nothing is offered instead.
  [{ kind: "company_awaiting_check" }, "none"],
  // The body is on its way, or stands: nothing to start again.
  [{ kind: "creating" }, "none"],
  [{ kind: "winding_down" }, "none"],
  [{ kind: "dissolved" }, "none"],
  [{ kind: "broken_reason_unknown" }, "none"],
  // The identity step itself is the way out: pick another identity.
  [{ kind: "identity_taken", agentId: "897126" }, "none"],
];

describe("noticeSentence", () => {
  test("covers the sixteen kinds", () => {
    const kinds = new Set<Kind>(KINDS.map(([n]) => n.kind));
    expect(kinds.size).toBe(16);
  });

  test.each(KINDS)("%j: a title, a body and its way out", (notice, wayOut) => {
    for (const environment of ["sandbox", "production"] as const) {
      const s = noticeSentence(notice, environment);
      expect(s.title.trim()).not.toBe("");
      expect(s.body.trim()).not.toBe("");
      expect(s.wayOut).toBe(wayOut);
    }
  });

  test("a lapse names its reason, and an unknown reason still reads", () => {
    const deadline = noticeSentence({ kind: "lapsed", reason: "deadline_passed" }, "sandbox").body;
    const owner = noticeSentence({ kind: "lapsed", reason: "owner_changed" }, "sandbox").body;
    const none = noticeSentence({ kind: "lapsed", reason: null }, "sandbox").body;
    expect(deadline).toMatch(/deadline/);
    expect(owner).not.toBe(deadline);
    expect(none.trim()).not.toBe("");
  });

  test("a superseded or replaced order names the newer one when it is known", () => {
    expect(noticeSentence({ kind: "superseded", by: "lbo_newer" }, "sandbox").body).toContain(
      "lbo_newer",
    );
    expect(noticeSentence({ kind: "replaced", by: "lbo_newer" }, "sandbox").body).toContain(
      "lbo_newer",
    );
    expect(noticeSentence({ kind: "superseded", by: null }, "sandbox").body).not.toContain("{by}");
  });

  test("a replaced body is never offered its pointer again", () => {
    expect(noticeSentence({ kind: "replaced", by: null }, "sandbox").body).toMatch(/not offered/);
  });

  test("a failed check says why, from the reason's own sentence", () => {
    for (const environment of ["sandbox", "production"] as const) {
      const s = noticeSentence({ kind: "company_failed", reasonCode: "filing_not_found" }, environment);
      expect(s.body).toContain(CHECK_REASON_SENTENCES.filing_not_found);
    }
    expect(
      noticeSentence({ kind: "company_failed", reasonCode: null }, "production").body.trim(),
    ).not.toBe("");
  });

  test("the identity refusal names the identity and says replacing is not offered", () => {
    const s = noticeSentence({ kind: "identity_taken", agentId: "897126" }, "sandbox");
    expect(s.body).toContain("897126");
    expect(s.body).toContain(
      "this identity already has a legal body; replacing it is not offered yet",
    );
  });

  test("waiting on production says a person checks it, and is not instant", () => {
    const s = noticeSentence({ kind: "company_awaiting_check" }, "production");
    expect(s.body).toContain(
      "A Novi Corpus operator checks the declaration against the registry and your document. This is done by a person; it is not instant.",
    );
  });
});

describe("a reason this build does not know still reads", () => {
  const N = LEGAL_BODY_COPY.notices;

  test("a lapse reason from a newer backend: the reservation closed, no more", () => {
    const n = { kind: "lapsed", reason: "a_newer_reason" as LapseReason } as const;
    expect(noticeSentence(n, "sandbox").body).toBe(N.lapsed.reasons.unknown);
  });

  test("an inherited name is not a reason", () => {
    const n = { kind: "lapsed", reason: "toString" as LapseReason } as const;
    expect(noticeSentence(n, "sandbox").body).toBe(N.lapsed.reasons.unknown);
  });

  test("a check reason code from a newer backend: no reason recorded, and the way back", () => {
    const n = { kind: "company_failed", reasonCode: "a_newer_code" as CheckReasonCode } as const;
    expect(noticeSentence(n, "production").body).toBe(
      `${N.company_failed.noReason} ${N.company_failed.wayBackProduction}`,
    );
  });
});

describe("closedSentence", () => {
  test("a closed phase with a notice says the notice", () => {
    expect(closedSentence({ kind: "expired" }, "sandbox")).toEqual(
      noticeSentence({ kind: "expired" }, "sandbox"),
    );
  });

  test("a closed phase without one (a state this build does not know) offers nothing", () => {
    const s = closedSentence(undefined, "production");
    expect(s.title.trim()).not.toBe("");
    expect(s.body.trim()).not.toBe("");
    expect(s.wayOut).toBe("none");
  });
});

describe("ClosedNotice", () => {
  const html = (n: Parameters<typeof closedSentence>[0]) =>
    renderToString(createElement(ClosedNotice, { sentence: closedSentence(n, "sandbox"), onWayOut: () => {} }));

  test("a closed order is never headed as done", () => {
    const out = html({ kind: "expired" });
    expect(out).toContain(LEGAL_BODY_COPY.closed.eyebrow);
    expect(out).not.toContain(`>${LEGAL_BODY_COPY.rail.labels.done}<`);
    expect(out).toContain(LEGAL_BODY_COPY.notices.expired.title);
  });

  test("its way out, when it has one, and none otherwise", () => {
    expect(html({ kind: "expired" })).toContain(LEGAL_BODY_COPY.closed.newOrder);
    expect(html(undefined)).not.toContain("<button");
  });
});
