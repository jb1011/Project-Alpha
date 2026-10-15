/**
 * How the browser steps reach the wallet, read from their source: a signature only through its
 * sign gate, a transaction only through the one allowlist.
 *
 * The gates are tested on their own (a spy in the wallet's place never sees typed data the check
 * refused); these guards pin that each step uses them and has no other way to the wallet: no
 * converter called on its own, no signature asked for outside `signThroughGate`, no write but
 * `useAllowedWrite`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const source = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");

/** Every call of `fn` in `code`, by its opening. */
const callsOf = (code: string, fn: string) => code.split(`${fn}(`).length - 1;

/** The one form a signature request may take: the wallet handed to the gate's helper. */
const THROUGH_GATE = "signThroughGate(gate, (typedData) => signTypedDataAsync(typedData))";

const NO_WRITE = ["useWriteContract", "writeContract", "useSendTransaction", "sendTransaction", "sendAllowedCall"];
const NO_KEY = ["apiKey", "x-api-key"];

describe.each([
  ["LinkStep.tsx", "linkSignGate"],
  ["CompanyStep.tsx", "statementSignGate"],
])("%s signs only through its gate", (name, gate) => {
  const code = source(name);

  test(`the typed data comes from ${gate}, never from a converter called here`, () => {
    expect(callsOf(code, gate)).toBeGreaterThan(0);
    expect(code).not.toContain("toWagmiLinkTypedData");
    expect(code).not.toContain("toWagmiStatementTypedData");
  });

  test("the wallet's signature is asked for only as the gate helper's argument", () => {
    expect(callsOf(code, "signTypedDataAsync")).toBe(1);
    // Every mention, not only calls: the one taken from the hook and the one handed to the gate. A
    // bare reference or a renamed destructure changes the count.
    expect(code.split("signTypedDataAsync").length - 1).toBe(2);
    expect(code.split(THROUGH_GATE).length - 1).toBe(1);
    expect(code).not.toContain("signTypedData(");
    expect(code).not.toContain("signMessage");
  });

  test("no transaction and no key", () => {
    for (const reach of [...NO_WRITE, "useAllowedWrite", ...NO_KEY]) expect(code).not.toContain(reach);
  });
});

describe("IdentityStep.tsx sends only through the allowlist", () => {
  const code = source("IdentityStep.tsx");

  test("its one transaction goes through useAllowedWrite", () => {
    expect(code).toContain("useAllowedWrite()");
  });

  test("no other write, no signature and no key", () => {
    for (const reach of [...NO_WRITE, "useSignTypedData", "signTypedData", "signMessage", ...NO_KEY])
      expect(code).not.toContain(reach);
  });
});
