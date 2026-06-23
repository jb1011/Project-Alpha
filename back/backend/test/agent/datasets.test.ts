// backend/test/agent/datasets.test.ts
import { expect, test } from "vitest";
import { DATASETS, getDataset } from "../../src/agent/datasets";

test("datasets have positive atomic prices and unique ids", () => {
  const ids = Object.keys(DATASETS);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  for (const id of ids) {
    expect(DATASETS[id]?.id).toBe(id);
    expect(DATASETS[id]?.price).toBeGreaterThan(0n);
  }
  const firstId = ids[0] ?? "";
  expect(getDataset(firstId)?.id).toBe(firstId);
  expect(getDataset("nope")).toBeUndefined();
});
