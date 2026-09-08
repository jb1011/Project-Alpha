import type { PublicConfig } from "@/lib/api/types";

/**
 * THE FORMATION COPY, served-or-fallback, in ONE place (design §7).
 *
 * `/config.formationCopy` is the authority and stays it: every sentence in it makes a CLAIM about
 * what the backend does — that an SSN dies with the company id, that one edit buys one retry,
 * that agents sharing a company are publicly linkable — and copy in a browser bundle drifts from
 * the code that keeps it, silently, in the direction of the older promise.
 *
 * What was wrong was the FALLBACK, or rather three different answers to its absence:
 *
 *  - the SSN field was gated on `copy?.ssn` being present, so a deployment whose `/config`
 *    predates `formationCopy` — or whose `/config` had not arrived yet — rendered a production
 *    create form with NO SSN INPUT AT ALL. The field is the fast-EIN route; its absence is not a
 *    cosmetic degradation, it silently files every US person under the slow one;
 *  - `ParkCard` rendered a bare fallback title and dropped the two explanatory sentences, so a
 *    parked filing showed a heading and a form with nothing saying what had happened;
 *  - `FormationCard` carried a THIRD paraphrase of the same three parks (`PARK_SUMMARY`), written
 *    by hand, in the summary register.
 *
 * So there is one table. Served copy WINS, field by field — a backend that grows a sentence
 * overrides ours the moment it ships — and the fallback is what renders when it has not answered
 * yet or does not know the field. The fallback text is copied from the backend constants
 * (`SSN_COPY`, `PARK_COPY`, `COMPANY_REUSE_DISCLOSURE`) and is deliberately the CAUTIOUS half of
 * each claim: where the served sentence promises something specific, the bundled one says the
 * same thing or less.
 */

/** The shape both halves satisfy — the served field, and the bundled one. */
export type FormationCopy = NonNullable<PublicConfig["formationCopy"]>;

/**
 * The bundled fallback.
 *
 * ⚠ Kept in step with `back/backend/src/formation.ts` by hand, and that is acceptable for exactly
 * one reason: it is only ever rendered when the backend has not answered. A drift here shows up
 * as a slightly older sentence on a box that could not tell us its newer one, which is the honest
 * failure. It is NOT acceptable for anything the served copy is the authority on to be decided
 * here — which is why this is a copy table and not a policy.
 */
export const FALLBACK_FORMATION_COPY: FormationCopy = {
  ssn: {
    label: "Social Security Number or ITIN (optional)",
    help: "US persons: supplying this lets the IRS issue your EIN in days instead of weeks. It is encrypted immediately, sent once to our filing partner, and deleted from our records the moment the company is filed. Leave it blank if you are not a US person — we will file the SS-4 signature route instead.",
    retention:
      "Deleted in the same transaction that records your company id, and in any case within 7 days if the filing never starts.",
  },
  park: {
    awaitingIntakeEdit: {
      title: "The filing agent refused this company's details",
      what: "The provider looked at the company you asked for — the names, the purpose, the industry — and refused it. Re-sending the same request cannot succeed, so nothing is being retried and nothing more will be spent until you change something.",
      youCan:
        "Edit the company details below. One edit buys one retry, with the new details, and you will see the result here.",
    },
    awaitingPartyEdit: {
      title: "The filing agent refused the responsible person's details",
      what: "The provider refused the identity the company would be filed under — a name, an email, a phone number or an address it will not accept. This is a different refusal from the company's own details, and changing those would not fix it.",
      youCan:
        "Correct the responsible person below. One correction buys one retry. We do not repeat the provider's own wording, which can name the person.",
    },
    awaitingSsnDecision: {
      title: "The SSN you supplied was deleted before the filing was sent",
      what: "We delete an SSN within 7 days if the filing has not started, and this filing had not. Sending it now would file under the slower EIN route you did not choose, so nothing has been sent.",
      youCan:
        "Supply the number again, or confirm you want the slower SS-4 route. Either choice starts the filing; we will not choose for you.",
    },
  },
  reuseDisclosure:
    "Agents that share a company are publicly linkable. Each agent anchors a record on-chain naming the company it is filed under, so anyone can see that these agents belong to the same legal body — and, through it, to each other. Create a separate company if two agents should not be publicly connected.",
};

/**
 * The copy this render should use: served where the backend answered, bundled where it did not.
 *
 * Merged per FIELD rather than all-or-nothing, so a backend that ships `ssn` before `park` (or the
 * reverse) is not made to look as though it shipped neither.
 */
export function formationCopyOf(config: { formationCopy?: FormationCopy } | undefined): FormationCopy {
  const served = config?.formationCopy;
  if (!served) return FALLBACK_FORMATION_COPY;
  return {
    ssn: served.ssn ?? FALLBACK_FORMATION_COPY.ssn,
    park: {
      awaitingIntakeEdit:
        served.park?.awaitingIntakeEdit ?? FALLBACK_FORMATION_COPY.park.awaitingIntakeEdit,
      awaitingPartyEdit:
        served.park?.awaitingPartyEdit ?? FALLBACK_FORMATION_COPY.park.awaitingPartyEdit,
      awaitingSsnDecision:
        served.park?.awaitingSsnDecision ?? FALLBACK_FORMATION_COPY.park.awaitingSsnDecision,
    },
    reuseDisclosure: served.reuseDisclosure ?? FALLBACK_FORMATION_COPY.reuseDisclosure,
  };
}

/** The three park keys, in the order a page renders them. */
export type ParkKey = keyof FormationCopy["park"];

/**
 * The dashboard's ONE-LINE version of each park — derived from the same table, never a fourth
 * paraphrase.
 *
 * `FormationCard` needs the shorter register (it names which of the three it is, so an owner
 * knows whether the next click is theirs; the Companies page renders the full explanation beside
 * the form that fixes it). It used to hold its own hand-written table, which is a second set of
 * words describing one behaviour — and the one that goes stale is always the one nobody is
 * looking at.
 */
export function parkSummary(copy: FormationCopy, key: ParkKey): string {
  return copy.park[key].title;
}
