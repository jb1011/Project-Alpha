import type { Hono } from "hono";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AgentSpecSchema } from "../../policy/agentSpec";

const agentSpecJsonSchema = zodToJsonSchema(AgentSpecSchema, "AgentSpec");

/** Serve the AgentSpec JSON schema so the frontend can derive a typed onboard form/client. */
export function mountSchemaRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: intentional — schema route is env-agnostic
  app: Hono<any>,
) {
  app.get("/schema/agent-spec.json", (c) => c.json(agentSpecJsonSchema));
}
