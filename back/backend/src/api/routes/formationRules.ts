import { createHash } from "node:crypto";
import type { Hono } from "hono";
import {
  NAME_CHARSET_SOURCE,
  NAME_MAX_LENGTH,
  NAME_OPTION_COUNT,
  PURPOSE_MAX_LENGTH,
} from "../../formation/intake";
import { NAICS_LABELS } from "../../formation/naicsLabels";

/**
 * `GET /formation/rules` — THE INTAKE RULES, as the backend actually holds them (design §5/§7).
 *
 * It began as `/formation/industries`, serving the one field that obviously could not be
 * hard-coded. The four rules beside it were hard-coded anyway: the interface carried its own
 * `NAME_OPTION_COUNT = 3`, `NAME_MAX_LENGTH = 120`, `PURPOSE_MAX_LENGTH = 500` and a re-typed
 * character class, each with a `/** Mirrors … *\/` comment naming the constant it mirrored.
 *
 * A mirror is a second copy with a promise attached. The day one moves, the form either refuses a
 * name the door would take — an annoyance — or PROMISES one the door refuses, after the founder
 * has typed three of them. Serving them costs four scalars on a response that already carries
 * 20 KB of labels, and it removes the promise entirely: there is one definition, and the browser
 * reads it.
 *
 * What is NOT served, deliberately: Wyoming's ~80 restricted words. That list is matched on
 * letter boundaries (so "Banksy" is not refused for containing "bank"), the matcher is the rule
 * rather than the data, and shipping the words without it would produce a client-side check that
 * disagrees with the server's in both directions. The server's refusal NAMES the offending word
 * and the form shows it.
 *
 * The three candidates for the LABELS were: hard-code them in the bundle (two copies of a
 * partner's reference table, and the browser's copy is the one nobody re-runs the refresher
 * against), put them on `/config`, or serve them here.
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
const RULES_BODY = JSON.stringify({
  industries: NAICS_LABELS,
  // The four the interface used to mirror. Scalars, on a response that already carries the list.
  nameOptionCount: NAME_OPTION_COUNT,
  nameMaxLength: NAME_MAX_LENGTH,
  purposeMaxLength: PURPOSE_MAX_LENGTH,
  // A character-CLASS BODY, not a pattern: the client compiles `^[…]$` around it and tests one
  // character at a time, exactly as `firstIllegalNameChar` does. Handing over a whole pattern
  // would hand over an anchor and a quantifier the client did not choose.
  nameCharset: NAME_CHARSET_SOURCE,
});

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
export const FORMATION_RULES_ETAG = `"${createHash("sha256").update(RULES_BODY).digest("hex").slice(0, 32)}"`;

export function mountFormationRulesRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: intentional — this route is env-agnostic
  app: Hono<any>,
) {
  app.get("/formation/rules", (c) => {
    c.header("Cache-Control", "public, max-age=86400");
    c.header("ETag", FORMATION_RULES_ETAG);
    // The conditional request. A 304 carries NO body by definition, and the headers above are
    // already set — which is what a client revalidating after `max-age` needs to hear.
    if (c.req.header("if-none-match") === FORMATION_RULES_ETAG) return c.body(null, 304);
    // The array as shipped, in the order doola published it — the picker sorts nothing for
    // itself, and the ORDER is part of what `describeIndustryLabels` caps for the two text
    // surfaces, so three renderers reading one array is what keeps them describing one list.
    c.header("Content-Type", "application/json");
    return c.body(RULES_BODY);
  });
}
