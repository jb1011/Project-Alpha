/**
 * THE HONESTY INVARIANT (design §2), asserted rather than reviewed.
 *
 * **Green is a claim: that a real company exists in a real register.** Every surface that shows a
 * filing makes this decision — the agent dashboard's `FormationCard`, the Companies list and
 * detail's `CompanyStatePill`, and the reuse picker inside the wizard — and before A3 each made it
 * with its own predicate. `environment !== "sandbox"` is the shape that fails: two values cannot
 * carry three facts, and the one that gets lost is "we don't know", which then renders as "it's
 * real". A founder on a slow box confirmed a real filing believing nothing real would happen;
 * the mirror bug is a `/config` failure painting a genuine Wyoming filing as a demo.
 *
 * So there is ONE function, and these are its rules.
 */
import { expect, test } from "vitest";
import type { FormationEnvironment } from "@/lib/api/formationEnvironment";
import {
  companyTone,
  filingTone,
  legalBodyTitle,
  mayRenderConfirmed,
} from "@/lib/formation/honesty";
import { COMPANY_STATES, FORMATION_STATUSES } from "@/lib/api/types";

const NOT_PRODUCTION: FormationEnvironment[] = ["sandbox", "unknown", "loading"];

test("CONFIRMED requires an explicit production environment — nothing else ever earns it", () => {
  for (const status of FORMATION_STATUSES) {
    if (status === "failed") continue; // its own tone, asserted below
    expect(mayRenderConfirmed(filingTone("production", status)), status).toBe(true);
    for (const env of NOT_PRODUCTION)
      expect(mayRenderConfirmed(filingTone(env, status)), `${env}/${status}`).toBe(false);
  }
});

test("`loading` and `unknown` are NOT sandbox — they are their own answer", () => {
  // The whole point of the four-state vocabulary. A `/config` still in flight and a `/config` that
  // FAILED are neither "demo" nor "real", and a surface that collapsed them into either is making
  // a claim on behalf of a deployment it could not reach.
  expect(filingTone("loading", "filed")).toBe("unverified");
  expect(filingTone("unknown", "filed")).toBe("unverified");
  expect(filingTone("sandbox", "filed")).toBe("demo");
  expect(filingTone("production", "filed")).toBe("confirmed");
});

test("a status from a NEWER backend is unverified, never green", () => {
  // The backend derives this status and deploys independently of the interface, so there is a
  // window after every release where a word arrives that this bundle has never seen. Rendering it
  // green would be a claim made on behalf of a backend we cannot read.
  expect(filingTone("production", "escrowed_pending_notary")).toBe("unverified");
  expect(mayRenderConfirmed(filingTone("production", "escrowed_pending_notary"))).toBe(false);
});

test("FAILED is its own tone, in every environment — a demo failure is still a failure", () => {
  for (const env of [...NOT_PRODUCTION, "production" as const])
    expect(filingTone(env, "failed"), env).toBe("failed");
});

test("the COMPANY vocabulary follows the identical rules", () => {
  // Two vocabularies, one invariant. `companyState` has eight words where `FormationStatus` has
  // five, and a second definition of "may I say this is real?" is how one of them ends up
  // rendering green over a sandbox company.
  for (const state of COMPANY_STATES) {
    if (state === "failed" || state === "abandoned") {
      expect(companyTone("production", state), state).toBe("failed");
      continue;
    }
    expect(mayRenderConfirmed(companyTone("production", state)), state).toBe(true);
    for (const env of NOT_PRODUCTION)
      expect(mayRenderConfirmed(companyTone(env, state)), `${env}/${state}`).toBe(false);
  }
  expect(companyTone("production", "a_state_from_the_future")).toBe("unverified");
  expect(companyTone("sandbox", "complete")).toBe("demo");
});

test("an ABANDONED company reads as failed, not as a quiet amber", () => {
  // Terminal and consequential: the company is over, and an owner who reads it as "still amber,
  // still coming" waits for something that will never happen.
  expect(companyTone("production", "abandoned")).toBe("failed");
  expect(companyTone("sandbox", "abandoned")).toBe("failed");
});

/* ── the legal-body header (§7, A3) ────────────────────────────────────────── */

test("A3: once a company is attached, the heading describes THAT COMPANY", () => {
  // The bug: the "(demo filing)" suffix came from `/config`. A user attaching an agent to a
  // company they minted in sandbox, on a box since re-pointed at production, read a heading that
  // said nothing about a demo over a filing that is one — and the reverse, which is worse.
  expect(legalBodyTitle({ environment: "sandbox", attached: true, mode: "attach" })).toBe(
    "Legal body (demo filing)",
  );
  expect(legalBodyTitle({ environment: "production", attached: true, mode: "attach" })).toBe(
    "Legal body",
  );
  // Neither claim while the row is still being read.
  for (const environment of ["loading", "unknown"] as const)
    expect(legalBodyTitle({ environment, attached: true, mode: "create" })).toBe("Legal body");
});

test("A3: before anything is attached, the DEPLOYMENT's answer is the right one", () => {
  // The next action is to create a company, and a new company takes the deployment's pin.
  expect(legalBodyTitle({ environment: "sandbox", attached: false, mode: "create" })).toBe(
    "Legal body (demo filing)",
  );
  expect(legalBodyTitle({ environment: "production", attached: false, mode: "attach" })).toBe(
    "Which company is this agent filed under?",
  );
  expect(legalBodyTitle({ environment: "production", attached: false, mode: "create" })).toBe(
    "Create the company this agent is filed under",
  );
  // …and an unknown deployment claims nothing at all — the neutral panel owns the screen.
  for (const environment of ["loading", "unknown"] as const)
    for (const mode of ["attach", "create"] as const)
      expect(legalBodyTitle({ environment, attached: false, mode })).toBe("Legal body");
});
