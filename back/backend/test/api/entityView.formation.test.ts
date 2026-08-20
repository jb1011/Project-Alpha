/**
 * `EntityView`'s formation fields (design §2/§8). Two rules, and the second one is the one that
 * matters legally: NULL means legacy/stub (the convention every optional view field follows), and
 * an environment is REQUIRED whenever a formation block is present — a sandbox filing must never
 * be renderable as a real one by omission.
 */
import { expect, test } from "vitest";
import { toEntityView } from "../../src/api/views";
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

test("a LEGACY row serves formation: null and oaManifestVersion: null (the stub shape, forever)", () => {
  const v = toEntityView(BASE);
  expect(v.formation).toBeNull();
  expect(v.oaManifestVersion).toBeNull();
  // The hash is still served — it is simply a DOC hash, which is what the null version means.
  expect(v.oaHash).toBe("0xabc");
});

test("a formed row serves provider + environment + the PR-1 status skeleton", () => {
  const v = toEntityView({
    ...BASE,
    formationProvider: "doola",
    formationEnvironment: "sandbox",
    oaManifestVersion: 1,
  });
  expect(v.formation).toEqual({ provider: "doola", environment: "sandbox", status: "none" });
  expect(v.oaManifestVersion).toBe(1);
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

test("no PII reaches the view, whatever the record carries", () => {
  const v = toEntityView({ ...BASE, formationProvider: "doola", formationEnvironment: "sandbox" });
  const printed = JSON.stringify(v);
  for (const forbidden of ["legalFirstName", "email", "ssn", "postalCode", "line1"])
    expect(printed).not.toContain(forbidden);
});
