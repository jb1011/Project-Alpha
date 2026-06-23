import { Hono } from "hono";
import { buildPaywall } from "../payments/seller";
import type { SettleFn } from "../payments/settle";
import type { Address } from "../types";
import { getDataset } from "./datasets";

export function buildVendor(cfg: {
  payTo: Address;
  asset: Address;
  network: string;
  settle?: SettleFn;
}): Hono {
  const app = new Hono();
  app.get("/data/:id", async (c) => {
    const ds = getDataset(c.req.param("id"));
    if (!ds) return c.json({ error: "unknown dataset" }, 404);
    const paywall = buildPaywall({
      price: ds.price,
      payTo: cfg.payTo,
      asset: cfg.asset,
      network: cfg.network,
      resource: `/data/${ds.id}`,
      settle: cfg.settle,
      resourceUrl: `vendor://data/${ds.id}`,
      serve: () => ({ id: ds.id, title: ds.title, body: ds.body }),
    });
    // Delegate the incoming request to the paywall sub-app.
    // The paywall registers GET at `/data/${ds.id}`, so we hand it a Request
    // at that same path — preserving all headers (including X-PAYMENT).
    return paywall.fetch(new Request(new URL(`/data/${ds.id}`, "http://vendor.local"), c.req.raw));
  });
  return app;
}
