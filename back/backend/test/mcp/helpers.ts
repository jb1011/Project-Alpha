import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Serve the Hono app on an ephemeral port and return a connected MCP client authed with apiKey. */
export async function startMcpTestClient(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  apiKey: string,
) {
  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
      server.close();
    },
  };
}
