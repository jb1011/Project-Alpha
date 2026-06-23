import { expect, test } from "vitest";
import { toJobView } from "../../src/api/jobViews";
import type { JobRecord } from "../../src/jobs/types";

test("toJobView maps JobRecord to JobView with all fields", () => {
  const record: JobRecord = {
    jobKey: "job-key-123",
    jobId: "job-id-456",
    entityKey: "entity-key-789",
    ownerTenantId: "tenant-001",
    status: "reputed",
    clientAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evaluatorAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    providerAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    budgetAmount: "1000000000000000000", // 1 token
    description: "Complete the task",
    deliverableHash: "QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    deliverablePath: "/ipfs/QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    createTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    fundTxHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    submitTxHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    completeTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    sweepTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    reputationTxHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    error: null,
  };

  const view = toJobView(record);

  expect(view.jobKey).toBe("job-key-123");
  expect(view.jobId).toBe("job-id-456");
  expect(view.entityKey).toBe("entity-key-789");
  expect(view.ownerTenantId).toBe("tenant-001");
  expect(view.status).toBe("reputed");
  expect(view.clientAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(view.evaluatorAddress).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  expect(view.providerAddress).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
  expect(view.budgetAmount).toBe("1000000000000000000");
  expect(view.description).toBe("Complete the task");
  expect(view.deliverableHash).toBe("QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  expect(view.deliverablePath).toBe("/ipfs/QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  expect(view.createTxHash).toBe(
    "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  );
  expect(view.fundTxHash).toBe(
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  );
  expect(view.submitTxHash).toBe(
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  );
  expect(view.completeTxHash).toBe(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  expect(view.sweepTxHash).toBe(
    "0x2222222222222222222222222222222222222222222222222222222222222222",
  );
  expect(view.reputationTxHash).toBe(
    "0x3333333333333333333333333333333333333333333333333333333333333333",
  );
  expect(view.error).toBe(null);
});

test("toJobView handles optional fields (ownerTenantId, error undefined)", () => {
  const record: JobRecord = {
    jobKey: "job-key-abc",
    jobId: null,
    entityKey: "entity-key-def",
    status: "pending",
    clientAddress: "0x0000000000000000000000000000000000000001",
    evaluatorAddress: "0x0000000000000000000000000000000000000002",
    providerAddress: "0x0000000000000000000000000000000000000003",
    budgetAmount: "500000000000000000",
    description: "Initial job",
    deliverableHash: null,
    deliverablePath: null,
    createTxHash: null,
    fundTxHash: null,
    submitTxHash: null,
    completeTxHash: null,
    sweepTxHash: null,
    reputationTxHash: null,
  };

  const view = toJobView(record);

  expect(view.jobKey).toBe("job-key-abc");
  expect(view.jobId).toBe(null);
  expect(view.entityKey).toBe("entity-key-def");
  expect(view.status).toBe("pending");
  expect(view.deliverableHash).toBe(null);
  expect(view.createTxHash).toBe(null);
  expect(view.reputationTxHash).toBe(null);
});
