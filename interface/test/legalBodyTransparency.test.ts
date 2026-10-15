/**
 * The legal bodies on the public transparency page.
 *
 * The page reads one view in one call and keeps one failure state of its own. The legal-body
 * section reads the same view and decides on its own keys: absent on an older backend (no list
 * key) and whenever the page failed; "could not be read" when the backend says the list is
 * unavailable, never an empty table; "none yet" when the list is available and empty; otherwise
 * the rows. Each row says its environment out loud (amber "sandbox"), and its statement link is
 * the row's own `links.statement`, shown as a link only over http or https.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LegalBodiesSection } from "@/components/transparency/LegalBodiesSection";
import type { TransparencyLegalBody, TransparencyView } from "@/lib/api/types";
import { addressUrl } from "@/lib/chain";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  legalBodiesStatValue,
  transparencyRow,
  transparencySection,
} from "@/lib/legalBody/transparency";

const T = LEGAL_BODY_COPY.transparency;

/** The live test body on Arc testnet and its agent id, both already on the public page. */
const BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE";
const STATEMENT_URL = "https://api.example.test/legal-bodies/by-agent/897126/statement";

function row(over: Partial<TransparencyLegalBody> = {}): TransparencyLegalBody {
  return {
    agentId: "897126",
    publicId: "pub_example",
    legalBody: BODY,
    chainId: 5042002,
    legalName: "Example Test Holdings LLC",
    filingNumber: "TEST-0001",
    jurisdiction: "WY",
    entityType: "LLC",
    source: "customer",
    environment: "sandbox",
    standing: "active",
    linkedSince: "2026-10-07T12:34:56.000Z",
    links: { statement: STATEMENT_URL },
    ...over,
  };
}

/** A view as an older backend serves it: no legal-body key at all. */
const OLDER: TransparencyView = {
  stats: { entities: 2, jobsSettled: 3, usdcSettledAtomic: "1000000" },
  entities: [],
};

function view(over: Partial<TransparencyView>): TransparencyView {
  return { ...OLDER, ...over };
}

describe("transparencySection decides on the section's own keys", () => {
  test("an older view without the key is absent", () => {
    expect(transparencySection(OLDER, false)).toEqual({ kind: "absent" });
  });

  test("a failed page is absent, whatever view is held", () => {
    expect(transparencySection(null, true)).toEqual({ kind: "absent" });
    const listed = view({
      stats: { ...OLDER.stats, legalBodies: 1 },
      legalBodies: [row()],
      legalBodiesAvailable: true,
    });
    expect(transparencySection(listed, true)).toEqual({ kind: "absent" });
  });

  test("no view yet is absent", () => {
    expect(transparencySection(null, false)).toEqual({ kind: "absent" });
  });

  test("legalBodiesAvailable false with an empty list is unavailable, never empty", () => {
    const v = view({
      stats: { ...OLDER.stats, legalBodies: 0 },
      legalBodies: [],
      legalBodiesAvailable: false,
    });
    expect(transparencySection(v, false)).toEqual({ kind: "unavailable" });
  });

  test("legalBodiesAvailable false wins over a list, and over a missing list", () => {
    expect(
      transparencySection(view({ legalBodies: [row()], legalBodiesAvailable: false }), false),
    ).toEqual({ kind: "unavailable" });
    expect(transparencySection(view({ legalBodiesAvailable: false }), false)).toEqual({
      kind: "unavailable",
    });
  });

  test("a list key that is not a list is unavailable, never a table", () => {
    const v = { ...OLDER, legalBodies: null, legalBodiesAvailable: true } as unknown as TransparencyView;
    expect(transparencySection(v, false)).toEqual({ kind: "unavailable" });
  });

  test("available and empty is empty", () => {
    const v = view({
      stats: { ...OLDER.stats, legalBodies: 0 },
      legalBodies: [],
      legalBodiesAvailable: true,
    });
    expect(transparencySection(v, false)).toEqual({ kind: "empty" });
  });

  test("rows are the rows, with their count", () => {
    const rows = [row(), row({ agentId: "897127", legalName: "Second Test Holdings LLC" })];
    const v = view({
      stats: { ...OLDER.stats, legalBodies: 2 },
      legalBodies: rows,
      legalBodiesAvailable: true,
    });
    expect(transparencySection(v, false)).toEqual({ kind: "rows", rows, count: 2 });
  });

  test("legalBodiesAvailable true with stats.legalBodies absent is still rows", () => {
    const rows = [row()];
    const v = view({ legalBodies: rows, legalBodiesAvailable: true });
    expect(v.stats.legalBodies).toBeUndefined();
    expect(transparencySection(v, false)).toEqual({ kind: "rows", rows, count: 1 });
  });
});

describe("legalBodiesStatValue: the tile only where the number means something", () => {
  test("no tile without a view, or on an older backend", () => {
    expect(legalBodiesStatValue(null)).toBeNull();
    expect(legalBodiesStatValue(OLDER)).toBeNull();
  });

  test("the number as served when it is a number", () => {
    const v = view({
      stats: { ...OLDER.stats, legalBodies: 3 },
      legalBodies: [row(), row(), row()],
      legalBodiesAvailable: true,
    });
    expect(legalBodiesStatValue(v)).toBe("3");
    const none = view({
      stats: { ...OLDER.stats, legalBodies: 0 },
      legalBodies: [],
      legalBodiesAvailable: true,
    });
    expect(legalBodiesStatValue(none)).toBe("0");
  });

  test("no tile when the list could not be read: a zero there would be a false count", () => {
    const v = view({
      stats: { ...OLDER.stats, legalBodies: 0 },
      legalBodies: [],
      legalBodiesAvailable: false,
    });
    expect(legalBodiesStatValue(v)).toBeNull();
  });
});

describe("transparencyRow: what one row shows", () => {
  test("the facts as served, the body linked to the explorer", () => {
    const r = transparencyRow(row());
    expect(r.agentId).toBe("897126");
    expect(r.legalName).toBe("Example Test Holdings LLC");
    expect(r.filingNumber).toBe("TEST-0001");
    expect(r.body.address).toBe(BODY);
    expect(r.body.href).toBe(addressUrl(BODY));
    expect(r.linkedSince).toBe("2026-10-07");
  });

  test("a sandbox row says sandbox, in amber", () => {
    expect(transparencyRow(row()).environment).toEqual({ label: "sandbox", tone: "amber" });
  });

  test("a production row says production, never amber", () => {
    expect(transparencyRow(row({ environment: "production" })).environment).toEqual({
      label: "production",
      tone: "neutral",
    });
  });

  test("an environment this page does not know is amber, as served", () => {
    const odd = row({ environment: "staging" as unknown as "sandbox" });
    expect(transparencyRow(odd).environment).toEqual({ label: "staging", tone: "amber" });
  });

  test("the statement link is the row's own links.statement", () => {
    const own = "https://elsewhere.example.test/statements/897126";
    const r = transparencyRow(row({ links: { statement: own } }));
    expect(r.statement).toEqual({ text: own, href: own });
  });

  test("a statement URL that is not http or https is shown as text, never as a link", () => {
    const r = transparencyRow(row({ links: { statement: "javascript:alert(1)" } }));
    expect(r.statement).toEqual({ text: "javascript:alert(1)", href: null });
  });

  test("a body that is not an address gets no explorer link", () => {
    const r = transparencyRow(row({ legalBody: "not-an-address" as unknown as `0x${string}` }));
    expect(r.body).toEqual({ address: "not-an-address", href: null });
  });

  test("a linked-since that is not a dated ISO string is shown as served", () => {
    expect(transparencyRow(row({ linkedSince: "soon" })).linkedSince).toBe("soon");
  });

  test("rows have distinct keys", () => {
    const a = transparencyRow(row());
    const b = transparencyRow(row({ agentId: "897127" }));
    expect(a.key).not.toBe(b.key);
  });
});

describe("the section as rendered", () => {
  const render = (v: TransparencyView | null, failed = false) =>
    renderToString(createElement(LegalBodiesSection, { view: v, failed }));

  test("absent renders nothing", () => {
    expect(render(OLDER)).toBe("");
    expect(render(null, true)).toBe("");
    expect(render(null)).toBe("");
  });

  test("unavailable says so, with the intro, and renders no table", () => {
    const html = render(view({ legalBodies: [], legalBodiesAvailable: false }));
    expect(html).toContain(T.unavailable);
    expect(html).toContain(T.intro);
    expect(html).not.toContain("<table");
    expect(html).not.toContain(T.empty);
  });

  test("empty says none is linked yet, and renders no table", () => {
    const html = render(view({ legalBodies: [], legalBodiesAvailable: true }));
    expect(html).toContain(T.empty);
    expect(html).not.toContain("<table");
    expect(html).not.toContain(T.unavailable);
  });

  test("rows render every column, the sandbox pill, the explorer link and the row's statement", () => {
    const html = render(view({ legalBodies: [row()], legalBodiesAvailable: true }));
    expect(html).toContain("<table");
    for (const header of Object.values(T.columns)) expect(html).toContain(header);
    expect(html).toContain("897126");
    expect(html).toContain("Example Test Holdings LLC");
    expect(html).toContain("TEST-0001");
    expect(html).toContain(`href="${addressUrl(BODY)}"`);
    expect(html).toContain(`href="${STATEMENT_URL}"`);
    expect(html).toContain("2026-10-07");
    expect(html).toMatch(/amber[^"]*"[^>]*>(?:<[^>]+>)*sandbox/);
    expect(html).not.toContain(T.empty);
    expect(html).not.toContain(T.unavailable);
  });

  test("a statement URL that is not http or https is never an href", () => {
    const html = render(
      view({
        legalBodies: [row({ links: { statement: "javascript:alert(1)" } })],
        legalBodiesAvailable: true,
      }),
    );
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(1)");
  });
});
