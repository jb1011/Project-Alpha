import { expect, test } from "vitest";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
} from "../src/abis/generated";

test("generated ABIs expose the functions the backend calls", () => {
  const names = (abi: readonly unknown[]) =>
    new Set(abi.map((x) => (x as { name?: string }).name).filter(Boolean));

  expect(names(legalManagerFactoryAbi).has("createEntity")).toBe(true);
  expect(names(iIdentityRegistryAbi).has("setAgentWallet")).toBe(true);
  expect(names(iIdentityRegistryAbi).has("getAgentWallet")).toBe(true);
  expect(names(legalManagerAbi).has("status")).toBe(true);
  expect(names(agentTreasuryAbi).has("available")).toBe(true);
});
