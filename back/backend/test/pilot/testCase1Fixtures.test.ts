/**
 * Test case 1's four inputs, shared by the pilot job and the evidence a juror reads: the job
 * description, the delivered report, the client's reason for contesting and the provider's reply.
 *
 * The report's bytes are what the provider submits and what the job records the fingerprint of,
 * so its size and keccak256 are pinned here: a changed byte would change the case. Each text is
 * one line ending in one LF; the LF is the file's line end, not part of the text, and the text
 * carries no quote marks of its own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import { describe, expect, test } from "vitest";

const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", "pilot", name));

describe("test case 1's delivered report", () => {
  const csv = fixture("test-case-1-report.csv");

  test("is 241 bytes with the keccak256 the provider submits", () => {
    expect(csv.length).toBe(241);
    expect(keccak256(csv)).toBe(
      "0xadedff9ae723ade4bfc2b287cd6818eb22151ed6a168c50f6df101c97d6cffb5",
    );
  });

  test("has LF line endings and one trailing newline", () => {
    const text = csv.toString("utf8");
    expect(text.includes("\r")).toBe(false);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe.each(["test-case-1-description.txt", "test-case-1-reason.txt", "test-case-1-reply.txt"])(
  "%s",
  (name) => {
    const text = fixture(name).toString("utf8");

    test("is one line that ends with one LF", () => {
      expect(text.endsWith("\n")).toBe(true);
      expect(text.indexOf("\n")).toBe(text.length - 1);
      expect(text.includes("\r")).toBe(false);
    });

    test("carries no quote marks around the text", () => {
      expect(text.startsWith('"')).toBe(false);
      expect(text.trimEnd().endsWith('"')).toBe(false);
    });
  },
);
