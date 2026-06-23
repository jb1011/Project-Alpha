import { type Hex, keccak256, toHex } from "viem";

export interface JobWorker {
  produceDeliverable(input: {
    jobKey: string;
    description: string;
  }): Promise<{ content: string; deliverableHash: Hex }>;
}

export class TrivialWorker implements JobWorker {
  async produceDeliverable(input: {
    jobKey: string;
    description: string;
  }) {
    const content = `Deliverable for job ${input.jobKey}: ${input.description} — completed by the agent.`;
    return { content, deliverableHash: keccak256(toHex(content)) };
  }
}
