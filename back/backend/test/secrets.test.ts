import { expect, test } from "vitest";
import { EnvSecretStore } from "../src/secrets/index";

test("EnvSecretStore returns present secrets and undefined for missing", () => {
  const store = new EnvSecretStore({ FOO: "bar" });
  expect(store.get("FOO")).toBe("bar");
  expect(store.get("MISSING")).toBeUndefined();
});

test("require() throws a clear error when a secret is absent", () => {
  const store = new EnvSecretStore({});
  expect(() => store.require("PLATFORM_PRIVATE_KEY")).toThrow(/PLATFORM_PRIVATE_KEY/);
});
