/**
 * The two Kleros deployments, one per key, and the Court interface link of a case.
 *
 * The chain decides whose Court a case lives in, so it is a constant that nothing overrides; the
 * court id is a preset fact Kleros may renumber, so config may override it. The case URL pattern
 * was checked by hand on public case 186 (testnet) and case 287 (arbitrum-one).
 */
import { describe, expect, it } from "vitest";
import {
  KLEROS_DEPLOYMENTS,
  type KlerosChain,
  type KlerosDeployment,
  deploymentFor,
  klerosCaseUrl,
} from "../../../src/adapters/kleros/deployments";

describe("KLEROS_DEPLOYMENTS", () => {
  it("holds the two deployments", () => {
    expect(KLEROS_DEPLOYMENTS).toEqual({
      testnet: {
        chain: "arbitrum-sepolia-testnet",
        courtId: 8,
        jurors: 5,
        label: "Kleros testnet court",
        courtUrlBase: "https://v2-testnet.kleros.builders/#/cases/",
      },
      live: {
        chain: "arbitrum-one",
        courtId: 34,
        jurors: 5,
        label: "Kleros Agentic Commerce Court",
        courtUrlBase: "https://v2.kleros.builders/#/cases/",
      },
    });
  });

  it("never uses the stage name 'live' as a public label", () => {
    for (const d of Object.values(KLEROS_DEPLOYMENTS)) {
      expect(d.label).not.toMatch(/live/i);
    }
  });

  it("cannot be changed at run time", () => {
    expect(Object.isFrozen(KLEROS_DEPLOYMENTS)).toBe(true);
    expect(Object.isFrozen(KLEROS_DEPLOYMENTS.testnet)).toBe(true);
    expect(Object.isFrozen(KLEROS_DEPLOYMENTS.live)).toBe(true);
    expect(() => {
      (KLEROS_DEPLOYMENTS.live as KlerosDeployment).chain = "arbitrum-sepolia-testnet";
    }).toThrow(TypeError);
    expect(() => {
      (KLEROS_DEPLOYMENTS as Record<string, KlerosDeployment>).testnet = {
        ...KLEROS_DEPLOYMENTS.live,
      };
    }).toThrow(TypeError);
    expect(KLEROS_DEPLOYMENTS.live.chain).toBe("arbitrum-one");
    expect(KLEROS_DEPLOYMENTS.testnet.chain).toBe("arbitrum-sepolia-testnet");
  });
});

describe("deploymentFor", () => {
  it("without an override answers a copy of the table row", () => {
    const d = deploymentFor("testnet");
    expect(d).toEqual(KLEROS_DEPLOYMENTS.testnet);
    expect(d).not.toBe(KLEROS_DEPLOYMENTS.testnet);
    expect(deploymentFor("live")).toEqual(KLEROS_DEPLOYMENTS.live);
  });

  it("the copy is the caller's: changing it leaves the table alone", () => {
    const d = deploymentFor("live");
    d.courtId = 99;
    expect(KLEROS_DEPLOYMENTS.live.courtId).toBe(34);
    expect(deploymentFor("live").courtId).toBe(34);
  });

  it("an override changes the court id and nothing else", () => {
    expect(deploymentFor("live", 41)).toEqual({ ...KLEROS_DEPLOYMENTS.live, courtId: 41 });
    expect(deploymentFor("testnet", 1)).toEqual({ ...KLEROS_DEPLOYMENTS.testnet, courtId: 1 });
    expect(KLEROS_DEPLOYMENTS.live.courtId).toBe(34);
    expect(KLEROS_DEPLOYMENTS.testnet.courtId).toBe(8);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 53]])(
    "refuses the override %s",
    (courtId) => {
      expect(() => deploymentFor("testnet", courtId)).toThrow(/court id/);
    },
  );

  it("refuses a name that is not a deployment", () => {
    expect(() => deploymentFor("fake" as "testnet")).toThrow(/deployment/);
    expect(() => deploymentFor("toString" as "testnet")).toThrow(/deployment/);
  });
});

describe("klerosCaseUrl", () => {
  it("links a case on arbitrum-one to the v2 Court interface", () => {
    expect(klerosCaseUrl("arbitrum-one", "287")).toBe(
      "https://v2.kleros.builders/#/cases/287/overview",
    );
  });

  it("links a case on the testnet to the v2-testnet Court interface", () => {
    expect(klerosCaseUrl("arbitrum-sepolia-testnet", "186")).toBe(
      "https://v2-testnet.kleros.builders/#/cases/186/overview",
    );
  });

  it("follows the chain, not an overridden court id", () => {
    const d = deploymentFor("testnet", 12);
    expect(klerosCaseUrl(d.chain, "7")).toBe(
      "https://v2-testnet.kleros.builders/#/cases/7/overview",
    );
  });

  it.each([[""], ["12a"], [" 12"], ["12 "], ["-1"], ["1.5"], ["0x1f"], ["../287"], ["287/x"]])(
    "makes no link from the malformed id %j",
    (id) => {
      expect(() => klerosCaseUrl("arbitrum-one", id)).toThrow(/decimal/);
    },
  );

  it("makes no link for a chain outside the table", () => {
    expect(() => klerosCaseUrl("fake" as KlerosChain, "1")).toThrow(/chain/);
  });
});
