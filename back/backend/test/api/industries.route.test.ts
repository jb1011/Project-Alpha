/**
 * `GET /formation/industries` (design §5/§7) — the create-company form's only discovery surface
 * for the one enumerated field.
 *
 * The property that matters is not "it returns an array": it is that the array the picker offers
 * and the array `createCompany` validates against are the SAME array. A picker built from a
 * second copy is a form that lets a founder choose a label the door then refuses — or, worse, one
 * doola refuses on a real fee.
 */
import { expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { NAICS_LABELS, isKnownIndustryLabel } from "../../src/formation/naicsLabels";

const get = () => buildApiApp({ webOrigin: "*" } as never).request("/formation/industries");

test("the route serves the SHIPPED list, in order, and every label passes the door's own check", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { industries: string[] };
  expect(body.industries).toEqual([...NAICS_LABELS]);
  // The one assertion that makes this a contract rather than a copy: everything the picker can
  // offer is something `createCompany` accepts.
  for (const label of body.industries) expect(isKnownIndustryLabel(label), label).toBe(true);
  expect(body.industries).toContain(DEFAULT_INDUSTRY);
});

test("it is PUBLIC — no token, on a deployment that forms nothing", async () => {
  // The list is a federal reference table compiled into the build. It says nothing about this
  // deployment, and putting a token dance in front of a form field would buy nothing.
  const res = await get();
  expect(res.status).toBe(200);
});

test("it is cacheable for a day: the list changes on a deploy, never on a request", async () => {
  const res = await get();
  expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
});
