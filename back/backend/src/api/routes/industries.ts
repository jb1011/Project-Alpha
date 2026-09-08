import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { NAICS_LABELS } from "../../formation/naicsLabels";

/**
 * `GET /formation/industries` — the industry labels a company may be filed under (design §5/§7).
 *
 * A3's create-company form is a type-ahead over 821 federal labels, and it has to get them from
 * somewhere. The three candidates were: hard-code them in the bundle (two copies of a partner's
 * reference table, and the browser's copy is the one nobody re-runs the refresher against), put
 * them on `/config`, or serve them here.
 *
 * **Not `/config`.** That route is fetched by every page in the interface — the landing page
 * included — before auth, and cached for the life of the tab (`staleTime: Infinity`). 821 labels
 * is roughly 20 KB of JSON that every visitor would pay for so that one form, reached by a
 * fraction of them, can render a dropdown. `/config` is also the deployment's CAPABILITY
 * document: booleans and one environment string, read by code that decides what a surface may
 * claim. A reference table is not a capability.
 *
 * **Public, and deliberately so.** The array is a build-time constant compiled from a federal
 * reference table; it says nothing about this deployment, its tenants or its filings, and it is
 * already published verbatim in the MCP `create_company` tool description and in the REST
 * refusal. Making it authenticated would buy nothing and would put a token dance in front of a
 * form field.
 *
 * Cached for a day by anything in front of us: the list changes when somebody runs
 * `scripts/refresh-naics.mts` and redeploys, which is a deploy, not a request.
 */

/**
 * The response body, serialized ONCE at module load.
 *
 * `c.json(...)` re-serializes 821 strings — roughly 20 KB — on every request, for an array that
 * is a build-time constant. It is the hottest public route the create form touches and the
 * cheapest possible thing to get wrong: the answer cannot change without a redeploy, so the work
 * belongs at load time, not per request.
 */
const INDUSTRIES_BODY = JSON.stringify({ industries: NAICS_LABELS });

/**
 * A STRONG ETag over that exact body.
 *
 * Strong rather than weak (`W/`) because the bytes are literally identical between responses —
 * one constant, serialized once — which is precisely the condition a strong validator asserts.
 * `Cache-Control: max-age=86400` alone means a client that has held the list for a day re-downloads
 * 20 KB to discover it has not changed; with the validator that becomes a 304 and no body at all,
 * which is the difference between a deploy costing every open tab 20 KB and costing them nothing.
 *
 * It is a hash of the body rather than a version string, so it changes when and only when the
 * bytes do: `refresh-naics.mts` cannot forget to bump it.
 */
export const INDUSTRIES_ETAG = `"${createHash("sha256").update(INDUSTRIES_BODY).digest("hex").slice(0, 32)}"`;

export function mountIndustryRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: intentional — this route is env-agnostic
  app: Hono<any>,
) {
  app.get("/formation/industries", (c) => {
    c.header("Cache-Control", "public, max-age=86400");
    c.header("ETag", INDUSTRIES_ETAG);
    // The conditional request. A 304 carries NO body by definition, and the headers above are
    // already set — which is what a client revalidating after `max-age` needs to hear.
    if (c.req.header("if-none-match") === INDUSTRIES_ETAG) return c.body(null, 304);
    // The array as shipped, in the order doola published it — the picker sorts nothing for
    // itself, and the ORDER is part of what `describeIndustryLabels` caps for the two text
    // surfaces, so three renderers reading one array is what keeps them describing one list.
    c.header("Content-Type", "application/json");
    return c.body(INDUSTRIES_BODY);
  });
}
