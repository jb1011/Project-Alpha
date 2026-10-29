import type { Address } from "viem";
import type { FeedbackEntry } from "./reputationRead";

/** Who may count, and under which tags: the configured poster, both tags exactly. */
export interface FeedbackFilter {
  poster: Address;
  tag1: string;
  tag2: string;
}

export interface FeedbackCounts {
  graded: number;
  correct: number;
  wrong: number;
  unrecognised: number;
}

/**
 * Count the poster's graded calls (design section 4.1.2).
 *
 * The registry already filters on the poster and both tags, and drops revoked entries when asked
 * to. The same filter runs again here on every row, because `giveFeedback` needs no authorisation
 * (anyone can post on any agent) and the card must never count a row this code did not ask for.
 *
 * `100` with 0 decimals is correct, `0` with 0 decimals is wrong; anything else from the poster is
 * unrecognised, counted apart and never folded into either.
 */
export function classifyFeedback(entries: FeedbackEntry[], filter: FeedbackFilter): FeedbackCounts {
  const poster = filter.poster.toLowerCase();
  let correct = 0;
  let wrong = 0;
  let unrecognised = 0;
  for (const e of entries) {
    if (e.revoked) continue;
    if (e.client.toLowerCase() !== poster) continue;
    if (e.tag1 !== filter.tag1 || e.tag2 !== filter.tag2) continue;
    if (e.valueDecimals === 0 && e.value === 100n) correct++;
    else if (e.valueDecimals === 0 && e.value === 0n) wrong++;
    else unrecognised++;
  }
  return { graded: correct + wrong, correct, wrong, unrecognised };
}
