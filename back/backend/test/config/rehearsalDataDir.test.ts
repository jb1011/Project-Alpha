import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { REHEARSAL_DATA_DIR, resolveRehearsalDataDir } from "../../src/config/rehearsalDataDir";

/** A fresh scratch directory standing in for `back/backend`, so no test depends on cwd or on
 *  the real repo. Nothing under it needs to exist unless a test creates it. */
function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "rehearsal-data-dir-"));
}

test("unset REHEARSAL_DATA_DIR resolves to data-p3 under the package root", () => {
  const root = freshRoot();
  expect(resolveRehearsalDataDir({}, root)).toBe(resolve(root, "data-p3"));
});

test("blank REHEARSAL_DATA_DIR is treated the same as unset", () => {
  const root = freshRoot();
  expect(resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "  " }, root)).toBe(
    resolve(root, "data-p3"),
  );
});

test("an explicit scratch dir is honored and returned absolute", () => {
  const root = freshRoot();
  expect(resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "./scratch" }, root)).toBe(
    resolve(root, "scratch"),
  );
});

test("REHEARSAL_DATA_DIR=./data throws and names the live dir", () => {
  const root = freshRoot();
  expect(() => resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "./data" }, root)).toThrow(
    'REHEARSAL_DATA_DIR="./data"',
  );
});

test("a subdirectory of the live dir throws", () => {
  const root = freshRoot();
  expect(() => resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "./data/p3" }, root)).toThrow();
});

test("an absolute path equal to the live dir throws", () => {
  const root = freshRoot();
  expect(() =>
    resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: resolve(root, "data") }, root),
  ).toThrow();
});

test("the operator-configured DATA_DIR is refused too, even when REHEARSAL_DATA_DIR points straight at it", () => {
  const root = freshRoot();
  expect(() =>
    resolveRehearsalDataDir(
      { DATA_DIR: "./data-sandbox", REHEARSAL_DATA_DIR: "./data-sandbox" },
      root,
    ),
  ).toThrow();
});

test("DATA_DIR never selects the rehearsal dir when REHEARSAL_DATA_DIR is unset", () => {
  const root = freshRoot();
  expect(resolveRehearsalDataDir({ DATA_DIR: "./data-sandbox" }, root)).toBe(
    resolve(root, "data-p3"),
  );
});

test("a symlink whose real path is inside the live dir throws", () => {
  const root = freshRoot();
  mkdirSync(resolve(root, "data"));
  symlinkSync(resolve(root, "data"), resolve(root, "live-link"));
  expect(() => resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "./live-link" }, root)).toThrow();
});

test("a sibling dir whose name merely starts with the live dir's name is not refused", () => {
  const root = freshRoot();
  mkdirSync(resolve(root, "data"));
  expect(resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "./data-p3" }, root)).toBe(
    resolve(root, "data-p3"),
  );
});

test("a not-yet-created subdir reached through a symlinked live dir throws", () => {
  const root = freshRoot();
  const realLive = freshRoot();
  symlinkSync(realLive, resolve(root, "data"));
  expect(() => resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: "./data/p3" }, root)).toThrow();
});

test("a not-yet-created subdir of the live dir's real path throws even when the live dir is configured through a symlink", () => {
  const root = freshRoot();
  const realLive = freshRoot();
  symlinkSync(realLive, resolve(root, "data"));
  expect(() =>
    resolveRehearsalDataDir({ REHEARSAL_DATA_DIR: resolve(realLive, "p3") }, root),
  ).toThrow();
});

test("REHEARSAL_DATA_DIR is exported as the default scratch dir", () => {
  expect(REHEARSAL_DATA_DIR).toBe("./data-p3");
});
