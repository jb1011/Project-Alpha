import { KLEROS_DEPLOYMENTS, type KlerosDeployment } from "../adapters/kleros/deployments";
import type { CourtClock } from "../adapters/kleros/disputeService";
import { KlerosHttpError } from "../adapters/kleros/errors";
import { FakeDisputeService } from "../adapters/kleros/fakeDisputeService";
import { publicErrorMessage } from "../workflow/publicError";
import type { KlerosStage } from "./composition";

/**
 * THE KLEROS CHECK: what the stage's Dispute Service answers to the three reads a filing believes,
 * and every problem in the answers. Reads only; nothing here can write.
 *
 *  - `tools/list` must hold the three write tools the key's preset grants.
 *  - The `instructions` string a key answers on `initialize` names its deployment, court, juror
 *    count and broadcast setting, and the docs say to believe it over any page. It is printed in
 *    full and refused only on a clear mismatch: the other deployment's chain as a whole word, or a
 *    court phrase naming another court than the stage's. On a real deployment a missing string is
 *    a problem too, since a filing has nothing to believe then. A stage with no deployment (a
 *    rehearsal) must answer the fake's own string: a rehearsal files with the fake only.
 *  - `court_get` on the stage's own chain and court must answer, with an evidence period of at
 *    least five minutes: the evidence is submitted within it, and a shorter one is not the court
 *    Kleros described.
 *
 * Every read is tried, so one run names every problem. A refused key (HTTP 401) is named once,
 * by a fixed sentence: the key itself never reaches a problem.
 */
export interface KlerosCheckResult {
  deployment: KlerosDeployment | null;
  tools: string[];
  instructions: string | null;
  court: CourtClock | null;
  problems: string[];
}

/** The three writes of a filing, which the key's preset must grant. */
export const WRITE_TOOLS: readonly string[] = Object.freeze([
  "evidence_pin",
  "dispute_create",
  "evidence_submit",
]);

/** The shortest evidence period a filing accepts, in seconds. */
export const MIN_EVIDENCE_PERIOD_SECONDS = 300;

/** The one problem a refused key gives, whichever read met it. */
export const UNAUTHORIZED_PROBLEM =
  "the Dispute Service refused this stage's key (HTTP 401): the key is wrong or revoked";

/** A court named in the instructions: "court 8", "Court ID 34", "court #8". */
const COURT_PHRASE = /\bcourt\s*(?:id\s*)?#?\s*(\d+)\b/gi;

/** A chain name as a whole word: not inside a longer name such as "arbitrum-one-archive". */
const wholeWord = (name: string) => new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`, "i");

/**
 * The court a stage without a deployment reads: a rehearsal rehearses the testnet stage, which
 * Kleros asks every flow to go through first.
 */
const REHEARSAL_COURT_ID = KLEROS_DEPLOYMENTS.testnet.courtId;

/** tools/list, instructions(), court_get on the stage's chain and court: reads only. */
export async function checkKleros(stage: KlerosStage): Promise<KlerosCheckResult> {
  const { deployment } = stage;
  const problems: string[] = [];
  const result: KlerosCheckResult = {
    deployment,
    tools: [],
    instructions: null,
    court: null,
    problems,
  };
  // A stage with no deployment is a rehearsal's, and only the fake may answer for it: the real
  // client is not even asked.
  if (deployment === null && !(stage.service instanceof FakeDisputeService)) {
    problems.push(
      "a stage with no Kleros deployment answers with the fake Dispute Service only, and this one holds another client: nothing was read",
    );
    return result;
  }
  const failed = (what: string, e: unknown) => {
    if (e instanceof KlerosHttpError && e.status === 401) {
      if (!problems.includes(UNAUTHORIZED_PROBLEM)) problems.push(UNAUTHORIZED_PROBLEM);
    } else problems.push(`${what}: ${publicErrorMessage(e)}`);
  };

  try {
    result.tools = await stage.service.listTools();
    const missing = WRITE_TOOLS.filter((t) => !result.tools.includes(t));
    if (missing.length > 0)
      problems.push(
        `tools/list does not list the write tool${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      );
  } catch (e) {
    failed("tools/list did not answer", e);
  }

  try {
    result.instructions = await stage.service.instructions();
    problems.push(...(await instructionsProblems(result.instructions, deployment)));
  } catch (e) {
    failed("initialize did not answer", e);
  }

  const chain = deployment?.chain ?? "fake";
  const courtId = deployment?.courtId ?? REHEARSAL_COURT_ID;
  try {
    const court = await stage.service.getCourt({ chain, courtId });
    result.court = court;
    const evidence = court.timesPerPeriod[0];
    if (evidence < MIN_EVIDENCE_PERIOD_SECONDS)
      problems.push(
        `the evidence period of court ${courtId} on ${chain} is ${evidence} s, under ${MIN_EVIDENCE_PERIOD_SECONDS} s`,
      );
  } catch (e) {
    failed(`court_get for court ${courtId} on ${chain} did not answer`, e);
  }
  return result;
}

/** What the instructions string says against the stage, as problems; none when it agrees. */
async function instructionsProblems(
  text: string | null,
  deployment: KlerosDeployment | null,
): Promise<string[]> {
  if (deployment === null) {
    const fake = await new FakeDisputeService({ script: "pay" }).instructions();
    return text === fake
      ? []
      : [
          "the rehearsal's Dispute Service does not answer the fake's own instructions: a rehearsal files with the fake only",
        ];
  }
  if (text === null)
    return [
      "the instructions string could not be read: it names the key's deployment and court, and a filing believes it over any document",
    ];
  const found: string[] = [];
  for (const other of Object.values(KLEROS_DEPLOYMENTS))
    if (other.chain !== deployment.chain && wholeWord(other.chain).test(text))
      found.push(
        `the instructions name ${other.chain}, and this stage files on ${deployment.chain}`,
      );
  for (const m of text.matchAll(COURT_PHRASE))
    if (Number(m[1]) !== deployment.courtId)
      found.push(
        `the instructions name court ${m[1]}, and this stage files in court ${deployment.courtId}`,
      );
  return [...new Set(found)];
}
