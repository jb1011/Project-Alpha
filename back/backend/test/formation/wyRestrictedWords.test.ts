/**
 * Wyoming restricted words (design 2026-08-26 §5) — the list is DATA, and this is the test the
 * design asks for beside it.
 *
 * Two properties matter and they pull in opposite directions: every restricted term must be
 * caught (a miss costs a real filing fee and a parked company), and an ordinary name that merely
 * CONTAINS one of them as a substring must not be refused (a false refusal is a caller who
 * cannot proceed and cannot tell why).
 */
import { expect, test } from "vitest";
import { WY_RESTRICTED_WORDS, findRestrictedWord } from "../../src/formation/wyRestrictedWords";

test("every listed term is caught, in isolation and inside a plausible name", () => {
  for (const word of WY_RESTRICTED_WORDS) {
    expect(findRestrictedWord(word), word).toBe(word);
    // …and in the shape a caller would actually type it.
    expect(findRestrictedWord(`Novi ${word} Holdings`), word).toBe(word);
  }
});

test("matching is case- and separator-insensitive", () => {
  expect(findRestrictedWord("ACME BANK")).toBe("bank");
  expect(findRestrictedWord("Acme Credit  Union")).toBe("credit union");
  expect(findRestrictedWord("Acme Credit-Union")).toBe("credit union");
  expect(findRestrictedWord("Acme Savings And Loan")).toBe("savings and loan");
});

test("a word that merely CONTAINS a restricted term is NOT refused", () => {
  // The substring trap. Each of these is a name a caller may legitimately file, and a naive
  // `includes` refuses all of them with a message they cannot act on.
  for (const ok of [
    "Banksy Robotics", // bank
    "Trustworthy Systems", // trust
    "Bancroft Analytics", // banc
    "Engineered Coffee Co", // engineer  (no: "engineered" is not "engineer")
    "Lawrence Media", // law
    "Doctorow Publishing", // doctor
    "Realtorship Data", // realtor
    "Assurances Unlimited", // assurance (plural is not the listed term)
  ])
    expect(findRestrictedWord(ok), ok).toBeNull();
});

test("an ordinary agent name passes", () => {
  for (const ok of ["Acme Robotics", "Novi Corpus", "Café Agents", "Zeta 9 Labs"])
    expect(findRestrictedWord(ok), ok).toBeNull();
});

test("an accented letter is a letter, not a word boundary", () => {
  // `\w` would end the word after "Bank" and refuse this. `\p{L}` does not.
  expect(findRestrictedWord("Banké Systems")).toBeNull();
  // …while a real separator still delimits.
  expect(findRestrictedWord("Bank-of-Agents")).toBe("bank");
});

test("the FIRST offending word is the one reported, so the message is stable", () => {
  expect(findRestrictedWord("Bank Insurance Group")).toBe("bank");
});

test("the patterns are STATELESS — the same name answers the same way every time", () => {
  // The compiled-once patterns are shared across calls, which is the whole point of compiling
  // them once. A `/g` flag would carry `lastIndex` between calls and make the second answer about
  // a name differ from the first — a filing refused on Tuesday and accepted on Wednesday.
  for (const name of ["Acme Bank Holdings", "Acme Robotics", "Trustworthy Systems"]) {
    const first = findRestrictedWord(name);
    for (let i = 0; i < 5; i++) expect(findRestrictedWord(name), `${name} #${i}`).toBe(first);
  }
});

test("an untrimmed or denormalized name is judged like the canonical one", () => {
  // `canonicalizeIntakeText` is what the intake stores and what the filer sends, so the refusal
  // has to be asked of the same string — otherwise a name can pass the door and be filed in a
  // form the door would have refused.
  expect(findRestrictedWord("  Acme Bank  ")).toBe("bank");
  // NFD "é" (e + combining acute) normalizes to the NFC form the boundary rule was written for.
  expect(findRestrictedWord("Banke\u0301 Robotics")).toBeNull();
});
