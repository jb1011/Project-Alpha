import { type Config, canFormEntities } from "./config/env";
import type { FormationPin } from "./types";

/**
 * The ONE resolution of "what does this deployment pin a NEW entity to?" (design §2/§5).
 *
 * Two conditions, both necessary:
 *  - the doola block is configured (`canFormEntities`) — nothing can be filed without it;
 *  - `FORMATION_REQUIRED` is on. A deployment that carries the credentials but has formation
 *    switched OFF must keep minting stub entities exactly as before, so the pin is null and
 *    `formation_provider` stays null forever on those rows. Pinning them anyway would leave the
 *    row claiming a provider that will never file for it — a lie the guardian surface would
 *    faithfully render.
 *
 * It lives OUTSIDE any composition root on purpose: the API, the CLI and the legacy onboarding
 * server all mint entities, and three copies of this rule is three ways for the doors to
 * disagree about what an entity is. The pin is stamped at CLAIM and immutable after (audit M5),
 * so a door that resolved it differently would produce permanently divergent rows.
 */
export function resolveFormationDeployment(
  cfg: Pick<Config, "doola" | "formation">,
): FormationPin | null {
  if (!canFormEntities(cfg) || !cfg.formation?.required) return null;
  // canFormEntities is exactly "cfg.doola is present", so the non-null assertion holds by the
  // guard above; the predicate is shared so the two can never drift.
  return { provider: "doola", environment: cfg.doola!.environment };
}
