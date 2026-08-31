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
