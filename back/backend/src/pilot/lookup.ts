import type { ByAgentAnswer } from "../api/routes/legalBodyStatements";
import { withDeadline } from "../util/deadline";

/**
 * THE PILOT'S LEGAL-BODY LOOKUP: what Novi Corpus's public route states about an agent, read the
 * way a seller that has never heard of us reads it, over HTTP.
 *
 * The pilot asks before it moves money: both agents of a job must have a legal body in good
 * standing. One GET, bounded at 15 seconds with the request aborted, and any answer that is not
 * a 2xx is an error rather than an absence: a throttled or failing route says nothing about the
 * agent.
 */
export interface LookupClient {
  byAgent(agentId: string): Promise<ByAgentAnswer>;
}

const LOOKUP_DEADLINE_MS = 15_000;

/** GET `<base>/legal-bodies/by-agent/<id>`. `base` may carry a trailing slash. */
export function httpLookupClient(base: string, fetchImpl: typeof fetch = fetch): LookupClient {
  const root = base.replace(/\/+$/, "");
  return {
    byAgent: (agentId) =>
      withDeadline(
        LOOKUP_DEADLINE_MS,
        async (signal) => {
          const url = `${root}/legal-bodies/by-agent/${encodeURIComponent(agentId)}`;
          const res = await fetchImpl(url, {
            method: "GET",
            headers: { accept: "application/json" },
            signal,
          });
          if (!res.ok)
            throw new Error(`the legal-body lookup for agent ${agentId} answered ${res.status}`);
          return (await res.json()) as ByAgentAnswer;
        },
        () =>
          new Error(
            `the legal-body lookup for agent ${agentId} did not answer within ${LOOKUP_DEADLINE_MS / 1000} s`,
          ),
      ),
  };
}

/** The body's legal name and standing, when the answer names a legal body and carries a signed
 *  statement; undefined otherwise. The name is "" when the statement withholds it. */
export function activeLegalName(
  a: ByAgentAnswer,
): { legalName: string; standing: string } | undefined {
  if (!a.legalBody || a.statement === null) return undefined;
  return { legalName: a.statement.message.legalName, standing: a.standing };
}
