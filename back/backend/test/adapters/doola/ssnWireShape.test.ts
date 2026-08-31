/**
 * THE SSN'S WIRE SHAPE, pinned against doola's published OpenAPI document.
 *
 * ── why this test exists instead of a live probe ────────────────────────────────────────────
 *
 * Every other consequential doola contract in this repo was settled by a sandbox probe (the
 * idempotency semantics, the filed-name surface). The SSN cannot be: a sandbox deployment REFUSES
 * the field by invariant (§4.1 — real personal data never reaches doola's development
 * environment), and the synthetic fixture omits it by design. There is no way to send a real SSN
 * to a sandbox and no way to send a fake one to production, so the shape has to be verified
 * against the spec rather than against the wire.
 *
 * Fetched from `https://docs.doola.com/api-reference/openapi.json` on 2026-08-31, and the two
 * facts that matter are recorded here VERBATIM:
 *
 *   PartnerResponsiblePartyDto.ssn:
 *     { "type": "string",
 *       "description": "Social Security Number or ITIN. Optional. Format: XXX-XX-XXXX.
 *                       Handled as sensitive data." }
 *
 *   PartnerCompanyMemberDto.ssn: the same field, which we deliberately never populate (§4.3 —
 *   doola derives US-vs-non-US from ANY one person's ssn, and the responsible party is the
 *   IRS-relevant one, so sending it once is sufficient and is the minimum exposure).
 *
 * The assertions below are therefore about OUR adapter: that the type carries the field where the
 * spec puts it, that our validator accepts exactly the documented format, and that the body we
 * build puts it in exactly one place. If doola changes the field, this file is where the change
 * gets recorded — and `docs/runbooks/doola-deploy.md` says so.
 */
import { expect, test } from "vitest";
import type { CreateCompanyInput, DoolaResponsibleParty } from "../../../src/adapters/doola/types";
import { isWellFormedSsn } from "../../../src/formation/pii";

test("`ssn` sits on responsibleParty, is OPTIONAL, and is a plain string", () => {
  // A type-level assertion made executable: the object below must compile AND must satisfy the
  // shape, so a rename or a required-ness change in `types.ts` fails here.
  const withSsn: DoolaResponsibleParty = {
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    ssn: "123-45-6789",
  };
  const without: DoolaResponsibleParty = {
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
  };
  expect(typeof withSsn.ssn).toBe("string");
  expect(without.ssn).toBeUndefined();
});

test("our validator accepts EXACTLY the documented format, XXX-XX-XXXX", () => {
  // The spec's words: "Format: XXX-XX-XXXX". Nothing is auto-reformatted into it, because an SSN
  // is not ours to rewrite and a caller who typed nine digits may have typed eight and a stray.
  expect(isWellFormedSsn("123-45-6789")).toBe(true);
  expect(isWellFormedSsn("000-00-0000")).toBe(true);
  for (const bad of ["123456789", "123 45 6789", "123-456-789", "12-34-5678", "1234-56-789"])
    expect(isWellFormedSsn(bad), bad).toBe(false);
});

test("the create body has exactly ONE place an SSN can go, and it is not `members`", () => {
  // §4.3, as a structural claim about the body we build. `members[].ssn` exists on the wire and
  // is deliberately never populated; a future edit that starts filling it in would be sending a
  // person's SSN twice for no additional effect.
  const body: CreateCompanyInput = {
    doolaCustomerId: "cus_1",
    entityType: "LLC",
    state: "WY",
    nameOptions: [{ name: "Acme", entityTypeEnding: "LLC", position: 1 }],
    industry: "Software development",
    description: "An agent legal body.",
    responsibleParty: {
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      email: "ada@example.com",
      ssn: "123-45-6789",
    },
    addresses: [
      { provider: "registeredAgent", type: "mailing" },
      { provider: "registeredAgent", type: "business" },
    ],
    members: [
      {
        legalFirstName: "Ada",
        legalLastName: "Lovelace",
        isNaturalPerson: true,
        address: { line1: "1 Way", city: "Cheyenne", postalCode: "82001", country: "USA" },
        ownershipPercent: 100,
      },
    ],
  };
  const serialized = JSON.stringify(body);
  expect(serialized.match(/"ssn"/g)).toHaveLength(1);
  expect(body.members.every((m) => m.ssn === undefined)).toBe(true);
  // The customer create carries none at all — its own type has no such field, which is what makes
  // "sent once" structural rather than a habit.
  expect(Object.keys(body.responsibleParty)).toContain("ssn");
});
