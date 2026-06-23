// backend/tools/passkey-capture/main.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { buildCaptureApp } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "test", "fixtures", "guardian-passkey.local.json");

const app = buildCaptureApp({ staticDir: here, fixturePath });
const port = Number(process.env.PORT ?? 8899);
serve({ fetch: app.fetch, port });
console.log(`Passkey capture on http://localhost:${port}  (writes ${fixturePath})`);
