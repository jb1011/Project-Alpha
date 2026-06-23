import { keccak256, toHex } from "viem";
import { describe, expect, test } from "vitest";
import { TrivialWorker } from "../../src/jobs/worker";

describe("JobWorker", () => {
  test("trivial worker is deterministic and hashes content", async () => {
    const w = new TrivialWorker();
    const a = await w.produceDeliverable({
      jobKey: "k1",
      description: "summarize",
    });
    const b = await w.produceDeliverable({
      jobKey: "k1",
      description: "summarize",
    });
    expect(a.content).toBe(b.content);
    expect(a.deliverableHash).toBe(keccak256(toHex(a.content)));
  });
});
