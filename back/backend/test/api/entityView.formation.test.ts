/**
 * `EntityView`'s formation fields (design §2/§8). Two rules, and the second one is the one that
 * matters legally: NULL means legacy/stub (the convention every optional view field follows), and
 * an environment is REQUIRED whenever a formation block is present — a sandbox filing must never
 * be renderable as a real one by omission.
 */
import { expect, test } from "vitest";
import { toEntityView } from "../../src/api/views";
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
});

const formed = (steps: FormationRequestRecord[]) =>
  toEntityView(
    { ...BASE, formationProvider: "doola", formationEnvironment: "sandbox" },
    () => steps,
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
    () => [step("create_provider", "confirmed", "cmp_1"), step("await_ein", "confirmed")],
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
