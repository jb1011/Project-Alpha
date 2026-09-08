/**
 * `GET /formation/rules` (design §5/§7) — the create-company form's discovery surface for every
 * rule it enforces.
 *
 * The property that matters is not "it returns an array": it is that what the form offers and
 * what `createCompany` accepts are the SAME thing. A picker built from a second copy is a form
 * that lets a founder choose a label the door then refuses — or, worse, one doola refuses on a
 * real fee — and four MIRRORED constants in the browser are four more of exactly that.
 *
 * Wyoming's restricted words are deliberately NOT served: the matcher (letter boundaries, so
 * "Banksy" survives "bank") is the rule rather than the data, and shipping the words without it
 * would produce a client check that disagrees with the server's in both directions.
 */
import { expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { FORMATION_RULES_ETAG } from "../../src/api/routes/formationRules";
import {
  DEFAULT_INDUSTRY,
  NAME_CHARSET_SOURCE,
  NAME_MAX_LENGTH,
  NAME_OPTION_COUNT,
  PURPOSE_MAX_LENGTH,
  firstIllegalNameChar,
} from "../../src/formation/intake";
import { NAICS_LABELS } from "../../src/formation/naicsLabels";

const get = () => buildApiApp({ webOrigin: "*" } as never).request("/formation/rules");

/**
 * ONE test for the route's contract, because it is one claim in three clauses.
 *
 * It was three: the list, "it is PUBLIC" (which called the same unauthenticated `get()` and
 * asserted the same 200 — a second copy of clause one), and the cache header. The list test also
 * looped `isKnownIndustryLabel` over every label it had just asserted was `NAICS_LABELS`, which
 * is the same array the predicate is built from: a loop that cannot fail while the line above it
 * passes.
 *
 * What the contract actually is: the array the picker offers is the array `createCompany`
 * validates against, it is reachable with no token, and it is cacheable for a day. A picker built
 * from a second copy is a form that lets a founder choose a label the door then refuses — or,
 * worse, one doola refuses on a real fee.
 */
test("the SHIPPED list, in order, public and cacheable for a day", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { industries: string[] };
  // The identity that makes this a contract rather than a copy — asserted once, by equality.
  expect(body.industries).toEqual([...NAICS_LABELS]);
  expect(body.industries).toContain(DEFAULT_INDUSTRY);
  // No token, on a deployment that forms nothing: the list is a federal reference table compiled
  // into the build, and putting a token dance in front of a form field would buy nothing.
  expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
});

test("a STRONG ETag, and a conditional request gets a bodiless 304", async () => {
  // `max-age` alone means a client that has held the list for a day re-downloads ~20 KB to
  // discover it has not changed. The validator turns that into a 304 and no body at all — which
  // is the difference between a deploy costing every open tab 20 KB and costing them nothing.
  const first = await get();
  const etag = first.headers.get("etag");
  expect(etag).toBe(FORMATION_RULES_ETAG);
  // STRONG, not weak: the bytes are literally identical between responses (one constant,
  // serialized once at module load), which is exactly what a strong validator asserts.
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

  const conditional = await buildApiApp({ webOrigin: "*" } as never).request("/formation/rules", {
    headers: { "if-none-match": etag! },
  });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe("");
  // …and the caching headers still ride the 304, or a client revalidates again immediately.
  expect(conditional.headers.get("etag")).toBe(etag);
  expect(conditional.headers.get("cache-control")).toBe("public, max-age=86400");
});

test("a STALE validator gets the whole list back, not a 304", async () => {
  const res = await buildApiApp({ webOrigin: "*" } as never).request("/formation/rules", {
    headers: { "if-none-match": '"0000000000000000000000000000beef"' },
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { industries: string[] }).industries).toEqual([...NAICS_LABELS]);
});

test("the ETag is a hash of the BODY — a refreshed list cannot forget to bump it", async () => {
  // A version string would be a second thing to remember on the day somebody runs
  // `refresh-naics.mts`. The hash changes when and only when the bytes do.
  const { createHash } = await import("node:crypto");
  const body = JSON.stringify({
    industries: NAICS_LABELS,
    nameOptionCount: NAME_OPTION_COUNT,
    nameMaxLength: NAME_MAX_LENGTH,
    purposeMaxLength: PURPOSE_MAX_LENGTH,
    nameCharset: NAME_CHARSET_SOURCE,
  });
  expect(FORMATION_RULES_ETAG).toBe(
    `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
  );
});

test("the four INTAKE RULES are served, and they are the door's own constants", async () => {
  // They were mirrored in the browser bundle, each with a `Mirrors …` comment naming the constant
  // it copied. A mirror is a second copy with a promise attached: the day one moves, the form
  // either refuses a name the door would take, or PROMISES one the door refuses — after the
  // founder has typed three of them.
  const body = (await (await get()).json()) as {
    nameOptionCount: number;
    nameMaxLength: number;
    purposeMaxLength: number;
    nameCharset: string;
  };
  expect(body.nameOptionCount).toBe(NAME_OPTION_COUNT);
  expect(body.nameMaxLength).toBe(NAME_MAX_LENGTH);
  expect(body.purposeMaxLength).toBe(PURPOSE_MAX_LENGTH);

  // The charset is a class BODY, so a client compiles `^[…]$` around it — and the result must
  // agree with `firstIllegalNameChar`, character for character.
  const client = new RegExp(`^[${body.nameCharset}]$`);
  for (const ch of "Acme-Robotics & Co. (Ltd)+,'0")
    expect(client.test(ch), ch).toBe(firstIllegalNameChar(ch) === null);
  for (const ch of 'éüß€/*?<>#@!"') expect(client.test(ch), ch).toBe(false);
});

test("Wyoming's RESTRICTED WORDS are never served — the matcher is the rule, not the data", async () => {
  // ~80 words matched on LETTER BOUNDARIES, so "Banksy" is not refused for containing "bank".
  // Shipping the words without the matcher gives a client check that disagrees with the server's
  // in both directions; the server's refusal names the offending word and the form shows it.
  const text = await (await get()).text();
  for (const word of ["bank", "trust", "insurance", "credit union"])
    expect(text.toLowerCase(), word).not.toContain(`"${word}"`);
});
