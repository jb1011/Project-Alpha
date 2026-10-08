import type { Context, Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { SignedStatementJson } from "../../legalBody/publicStatement";
import type { Standing } from "../../legalBody/standing";
import {
  type StatementOutcome,
  isCanonicalAgentId,
  statementForAgent,
} from "../../legalBody/statements";
import { opsLog } from "../../observability/opsLog";
import type { ApiDeps } from "../app";
import {
  AnswerMemo,
  FRESH_CACHE_CONTROL,
  MEMO_MAX_ENTRIES,
  MEMO_TTL_MS,
  NO_STORE,
  RATE_LIMITED_BODY,
  THROTTLE_LOG_WINDOW_MS,
  UNAVAILABLE_BODY,
  createClientLimiter,
  errorNameOf,
} from "./legalBodies";

/**
 * GET /legal-bodies/by-agent/:agentId: what Novi states about an agent's legal body, signed on
 * each request from one block's chain reads by the statement service (`legalBody/statements.ts`).
 *
 * PUBLIC and unauthenticated, like the lookup by address beside it, for the same caller: a seller
 * that has never heard of us. Bounded the same way, and by the same instances:
 *  - a 15-second memo of definitive answers, checked before any budget, so a memo hit costs no
 *    token and no read;
 *  - on a miss, one token from the caller's own bucket (the lookup's per-client limiter, so a
 *    caller that spent its allowance on one route is refused by the other), then one from the
 *    shared read budget (the lookup's).
 *
 * A chain read that failed answers `unknown`, unsigned, `no-store` and never memoised: it is the
 * absence of an answer. Only a failed DATABASE read answers 503. No error text reaches an answer
 * or an ops line.
 */

/** The three answers. The agent id is the canonical decimal the caller supplied. */
type ByAgentAnswer =
  | { agentId: string; legalBody: false; standing: null; checkedAt: string }
  | {
      agentId: string;
      legalBody: true;
      standing: "unknown";
      publicId: null;
      network: "testnet" | "mainnet";
      links: { transparency: string };
      checkedAt: string;
      statement: null;
    }
  | {
      agentId: string;
      legalBody: true;
      standing: Standing;
      publicId: string;
      network: "testnet" | "mainnet";
      links: { transparency: string; statement: string };
      checkedAt: string;
      statement: SignedStatementJson;
    };

/** Mounts nothing without `deps.legalBodyStatements`: the route is then a 404. */
export function mountLegalBodyStatementRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: ApiDeps,
): void {
  const st = deps.legalBodyStatements;
  if (!st) return;
  const now = () => (deps.now ?? Date.now)();
  /** Keyed by the canonical agent id. */
  const memo = new AnswerMemo<ByAgentAnswer>(MEMO_TTL_MS, MEMO_MAX_ENTRIES, now);
  const clientBucket = createClientLimiter(deps);
  /** When the last throttle line was written, so a sustained drain costs one line per minute. */
  let throttleLoggedAt: number | undefined;

  /** The same refusal whichever budget ran out, plus at most one ops line per window naming
   *  WHICH budget, never who asked. */
  const throttled = (c: Context, bucket: "client" | "shared") => {
    const at = now();
    if (throttleLoggedAt === undefined || at - throttleLoggedAt >= THROTTLE_LOG_WINDOW_MS) {
      throttleLoggedAt = at;
      opsLog("legal_body_statement_throttled", { bucket });
    }
    c.header("Cache-Control", NO_STORE);
    return c.json(RATE_LIMITED_BODY, 429);
  };

  app.get("/legal-bodies/by-agent/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    // One spelling per agent: the memo is keyed by it.
    if (!isCanonicalAgentId(agentId)) {
      c.header("Cache-Control", NO_STORE);
      return c.json(
        {
          error: "validation_error",
          message: "agentId must be a decimal token id of at most 78 digits, without leading zeros",
        },
        400,
      );
    }

    const hit = memo.get(agentId);
    if (hit !== undefined) {
      // Definitive by construction: replayed as checked, with no token and no read.
      c.header("Cache-Control", FRESH_CACHE_CONTROL);
      return c.json(hit);
    }
    // The caller's own allowance first, so a scanner runs itself out before the shared one.
    if (!clientBucket(c).take()) return throttled(c, "client");
    if (!st.readBudget.take()) return throttled(c, "shared");

    let outcome: StatementOutcome;
    try {
      outcome = await statementForAgent(st, agentId);
    } catch (e) {
      // Only a DATABASE read throws out of the service: we cannot tell whether the agent has a
      // legal body at all, which no answer here has a value for.
      opsLog("legal_body_statement_db_failed", { errorName: errorNameOf(e) });
      c.header("Cache-Control", NO_STORE);
      return c.json(UNAVAILABLE_BODY, 503);
    }
    const checkedAt = new Date(now()).toISOString();

    if (outcome.kind === "unknown") {
      // Not an answer anything may reuse: never memoised, never stored downstream.
      const unknown: ByAgentAnswer = {
        agentId,
        legalBody: true,
        standing: "unknown",
        publicId: null,
        network: st.network,
        links: { transparency: st.links.transparency },
        checkedAt,
        statement: null,
      };
      c.header("Cache-Control", NO_STORE);
      return c.json(unknown);
    }
    const answer: ByAgentAnswer =
      outcome.kind === "none"
        ? { agentId, legalBody: false, standing: null, checkedAt }
        : {
            agentId,
            legalBody: true,
            standing: outcome.standing,
            publicId: outcome.publicId,
            network: st.network,
            links: {
              transparency: st.links.transparency,
              statement: `${st.links.statementBase}${agentId}`,
            },
            checkedAt,
            statement: outcome.statement,
          };
    memo.set(agentId, answer);
    c.header("Cache-Control", FRESH_CACHE_CONTROL);
    return c.json(answer);
  });
}
