/**
 * `EntityView`'s formation fields (design §2/§8). Two rules, and the second one is the one that
 * matters legally: NULL means legacy/stub (the convention every optional view field follows), and
 * an environment is REQUIRED whenever a formation block is present — a sandbox filing must never
 * be renderable as a real one by omission.
 */
import { expect, test } from "vitest";
import { toEntityView, toEntityViews } from "../../src/api/views";
import type { FormationRequestRecord } from "../../src/persistence/formationRepository";
import type { EntityRecord } from "../../src/types";

const BASE: EntityRecord = {
  idempotencyKey: "t:agent-1",
  name: "View Agent",
  status: "bound",
  manager: "0x000000000000000000000000000000000000aAaa",
  guardian: "0x000000000000000000000000000000000000bBbb",
  operator: "0x000000000000000000000000000000000000cCcc",
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  oaHash: "0xabc",
  metadataURI: "https://host.example/metadata/p",
  docPath: "/data/documents/oa-t-agent-1-v1.md",
  treasuryConfig: null,
  agentId: "7",
  proxy: "0x0000000000000000000000000000000000000abc",
  treasury: "0x0000000000000000000000000000000000000def",
  createTxHash: "0xcreate",
  bindTxHash: "0xbind",
  fundTxHash: null,
};

test("a LEGACY row serves formation: null and the LEGACY anchor scheme (the stub shape, forever)", () => {
  const v = toEntityView(BASE);
  expect(v.formation).toBeNull();
  // A row with an oaHash and no manifest marker is legacy: the hash commits to the document.
  expect(v.oaAnchor).toEqual({ scheme: "legacy", hash: "0xabc" });
  expect(v.oaHash).toBe("0xabc");
});

test("a formed row serves provider + environment + the derived status", () => {
  const v = toEntityView({
    ...BASE,
    formationProvider: "doola",
    formationEnvironment: "sandbox",
    oaManifestVersion: 1,
    oaManifestAnchoredHash: "0xabc",
  });
  // No sub-saga rows to read: the entity is pinned but nothing has been opened for it.
  expect(v.formation).toEqual({
    provider: "doola",
    environment: "sandbox",
    status: "none",
    providerRef: null,
    filedAt: null,
    filingNumber: null,
    ein: null,
    requiredActions: [],
    documents: [],
  });
  expect(v.oaAnchor).toEqual({
    scheme: "manifest",
    hash: "0xabc",
    version: 1,
    pendingHash: null,
  });
});

test("G2: the anchor scheme comes from the SAME predicate the saga anchors with", () => {
  // A manifest entity whose v1 has not confirmed yet has a NULL version — the exact case a
  // "version == null means legacy" renderer got wrong, describing a bundle anchor as a doc hash.
  const pending = toEntityView({
    ...BASE,
    status: "translating",
    oaHash: "0xman",
    oaManifestPendingHash: "0xman",
  });
  expect(pending.oaAnchor).toEqual({
    scheme: "manifest",
    hash: "0xman",
    version: null,
    pendingHash: "0xman",
  });

  // A brand-new row (nothing derived yet) is a manifest entity too — that is what the saga will
  // give it — and it has no hash to show.
  const fresh = toEntityView({ ...BASE, status: "pending", oaHash: null });
  expect(fresh.oaAnchor).toEqual({
    scheme: "manifest",
    hash: null,
    version: null,
    pendingHash: null,
  });

  // …and a legacy row stays legacy whatever its tx state is.
  expect(toEntityView({ ...BASE, createTxHash: null }).oaAnchor.scheme).toBe("legacy");
});

test("HONESTY INVARIANT: the environment can never be omitted from a formation block", () => {
  for (const environment of ["sandbox", "production"] as const) {
    const v = toEntityView({
      ...BASE,
      formationProvider: "doola",
      formationEnvironment: environment,
    });
    expect(v.formation?.environment).toBe(environment);
  }
  // A half-written pair is a bug, and the view refuses to render half of it: a provider with no
  // environment would let a sandbox filing be shown without its "demo" qualifier.
  expect(toEntityView({ ...BASE, formationProvider: "doola" }).formation).toBeNull();
  expect(toEntityView({ ...BASE, formationEnvironment: "sandbox" }).formation).toBeNull();
});

// ── the derived status (design §5/§8) ──────────────────────────────────────────────────────

const step = (
  step: FormationRequestRecord["step"],
  state: FormationRequestRecord["state"],
  providerRef: string | null = null,
): FormationRequestRecord => ({
  entityKey: BASE.idempotencyKey,
  step,
  state,
  attempt: 0,
  providerRef,
  detail: null,
  error: null,
  nextPollAt: null,
  createdAt: "2026-08-21 12:00:00",
  updatedAt: "2026-08-21 12:00:00",
});

const formed = (steps: FormationRequestRecord[]) =>
  toEntityView(
    { ...BASE, formationProvider: "doola", formationEnvironment: "sandbox" },
    { formationSteps: () => steps },
  );

test("status is DERIVED from the sub-saga rows, never stored", () => {
  expect(formed([]).formation!.status).toBe("none");

  // Opened, nothing legally true yet: doola has the request, Wyoming has nothing.
  expect(
    formed([step("create_provider", "confirmed"), step("await_filing", "pending")]).formation!
      .status,
  ).toBe("in_progress");
  expect(formed([step("create_provider", "submitted")]).formation!.status).toBe("in_progress");

  // The STATE has filed it — the company legally exists.
  expect(
    formed([step("create_provider", "confirmed"), step("await_filing", "confirmed")]).formation!
      .status,
  ).toBe("filed");

  // The IRS has issued the EIN: fully formed.
  expect(
    formed([step("await_filing", "confirmed"), step("await_ein", "confirmed")]).formation!.status,
  ).toBe("complete");

  // Nothing confirmed and the filing step is in error.
  expect(formed([step("create_provider", "failed")]).formation!.status).toBe("failed");
  expect(formed([step("create_provider", "abandoned")]).formation!.status).toBe("failed");
});

test("a FILED company whose later step failed still reads `filed` — the legal fact stands", () => {
  // Reporting this as "failed" would deny a company that exists in Wyoming's records. The
  // ordering of the checks is what makes that impossible.
  const v = formed([
    step("create_provider", "confirmed"),
    step("await_filing", "confirmed"),
    step("fetch_documents", "failed"),
  ]);
  expect(v.formation!.status).toBe("filed");
});

test("providerRef comes from the create_provider row; the legal facts come from the record", () => {
  const v = toEntityView(
    {
      ...BASE,
      formationProvider: "doola",
      formationEnvironment: "sandbox",
      einReal: "12-3456789",
      formationFiledAt: 1_755_600_000,
      formationFilingNumber: "2026-123456",
    },
    {
      formationSteps: () => [
        step("create_provider", "confirmed", "cmp_1"),
        step("await_ein", "confirmed"),
      ],
    },
  );
  expect(v.formation).toEqual({
    provider: "doola",
    environment: "sandbox",
    status: "complete",
    providerRef: "cmp_1",
    filedAt: 1_755_600_000,
    filingNumber: "2026-123456",
    // The AUTHENTICATED view — and only this one — carries the EIN.
    ein: "12-3456789",
    requiredActions: [],
    documents: [],
  });
  // `ein` on the record is the placeholder frozen on-chain at mint; it is never served as a fact.
  expect(v.formation!.ein).not.toBe(BASE.ein);
});

test("no PII reaches the view, whatever the record carries", () => {
  const v = toEntityView({ ...BASE, formationProvider: "doola", formationEnvironment: "sandbox" });
  const printed = JSON.stringify(v);
  for (const forbidden of ["legalFirstName", "email", "ssn", "postalCode", "line1"])
    expect(printed).not.toContain(forbidden);
});

// ── required actions + documents (design §8, part B) ───────────────────────────────────────

test("requiredActions serves CODES only — never the id, never doola's free-text reason", () => {
  const withActions = step("await_filing", "pending");
  withActions.detail = JSON.stringify({
    submissionStatus: "SUBMITTED",
    requiredActions: [
      {
        id: "ra-1",
        code: "FORMATION_NAME_OPTIONS_EXHAUSTED",
        status: "OPEN",
      },
    ],
  });
  const v = formed([step("create_provider", "confirmed", "cmp-1"), withActions]);
  expect(v.formation?.requiredActions).toEqual(["FORMATION_NAME_OPTIONS_EXHAUSTED"]);
  // The internal handle is not a thing a tenant surface has any use for.
  expect(JSON.stringify(v.formation)).not.toContain("ra-1");
});

test("a missing, malformed or empty detail blob yields no required actions", () => {
  for (const detail of [null, "not json", "{}", JSON.stringify({ requiredActions: [] })]) {
    const row = step("await_filing", "pending");
    row.detail = detail;
    // A UI that cannot read the detail must neither claim there is nothing to do NOR invent
    // something to do.
    expect(formed([row]).formation?.requiredActions, String(detail)).toEqual([]);
  }
  // A malformed ENTRY inside a good blob is skipped rather than serving `undefined`.
  const partial = step("await_filing", "pending");
  partial.detail = JSON.stringify({ requiredActions: [{ id: "ra-1" }, { code: "GOOD" }] });
  expect(formed([partial]).formation?.requiredActions).toEqual(["GOOD"]);
});

test("documents are projected as metadata with a DERIVED name, and never the storage path", () => {
  const v = toEntityView(
    { ...BASE, formationProvider: "doola", formationEnvironment: "sandbox" },
    {
      formationSteps: () => [step("create_provider", "confirmed", "cmp-1")],
      documents: {
        listByEntity: () => [
          {
            id: "abc123",
            entityKey: BASE.idempotencyKey,
            docType: "ArticlesOfOrganization",
            sha256: "f".repeat(64),
            contentType: "application/pdf",
            size: 4096,
            providerDocId: "doola-doc-1",
            path: "/data/documents/doc-t-agent-1-ArticlesOfOrganization-doola-doc-1.pdf",
            createdAt: "2026-08-21 12:00:00",
          },
        ],
      } as never,
    },
  );
  expect(v.formation?.documents).toEqual([
    {
      id: "abc123",
      type: "ArticlesOfOrganization",
      name: "ArticlesOfOrganization.pdf",
      size: 4096,
      sha256: "f".repeat(64),
    },
  ]);
  // Neither the on-disk path nor doola's own document id belongs on a tenant surface.
  const json = JSON.stringify(v.formation);
  expect(json).not.toContain("/data/documents");
  expect(json).not.toContain("doola-doc-1");
});

test("no documents lookup wired reads as no documents, not as an error", () => {
  const v = formed([step("create_provider", "confirmed", "cmp-1")]);
  expect(v.formation?.documents).toEqual([]);
  expect(v.formation?.requiredActions).toEqual([]);
});

// ── M5: the LIST projection reads once for the page, not twice per entity ──────────────────

test("M5: toEntityViews batches the formation and document reads across the whole page", () => {
  const rows: EntityRecord[] = Array.from({ length: 5 }, (_, i) => ({
    ...BASE,
    idempotencyKey: `t:agent-${i}`,
    formationProvider: "doola",
    formationEnvironment: "sandbox" as const,
  }));
  // …plus an unpinned row, which must not be looked up at all.
  rows.push({ ...BASE, idempotencyKey: "t:stub" });

  const askedSteps: string[][] = [];
  const askedDocs: string[][] = [];
  const views = toEntityViews(rows, {
    formationSteps: () => {
      throw new Error("the per-row lookup must not be used when a batched one is wired");
    },
    formationStepsMany: (keys) => {
      askedSteps.push([...keys]);
      return new Map(keys.map((k) => [k, [step("create_provider", "confirmed", `cmp-${k}`)]]));
    },
    documents: {
      listByEntity: () => {
        throw new Error("the per-row lookup must not be used when a batched one is wired");
      },
      listByEntities: (keys) => {
        askedDocs.push([...keys]);
        return new Map();
      },
    },
  });

  // ONE call each, for the PINNED rows only — an unpinned entity has no formation to describe,
  // and on most deployments most rows are unpinned.
  expect(askedSteps).toHaveLength(1);
  expect(askedDocs).toHaveLength(1);
  expect(askedSteps[0]).toEqual(rows.slice(0, 5).map((r) => r.idempotencyKey));
  expect(views).toHaveLength(6);
  expect(views[0]!.formation!.providerRef).toBe("cmp-t:agent-0");
  expect(views[5]!.formation).toBeNull();
});

test("M5: with no batched lookups wired, the list falls back to the per-row path", () => {
  let calls = 0;
  const rows = [{ ...BASE, formationProvider: "doola", formationEnvironment: "sandbox" as const }];
  const views = toEntityViews(rows, {
    formationSteps: () => {
      calls++;
      return [step("create_provider", "confirmed", "cmp-1")];
    },
  });
  expect(calls).toBe(1);
  expect(views[0]!.formation!.providerRef).toBe("cmp-1");
});
