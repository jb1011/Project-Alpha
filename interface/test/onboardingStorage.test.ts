/**
 * The wizard's localStorage allowlist (design §3, audit 16/L8) — asserted BY VALUE.
 *
 * The onboarding wizard collects the legal name, email, phone and home address of a real person,
 * and writes its state to `localStorage` on every keystroke-driven re-render. Those two facts must
 * never meet. The rule the design sets is structural rather than careful: persistence is an
 * ALLOWLIST, so a field nobody thought about is not persisted, instead of a denylist where a field
 * nobody thought about IS.
 *
 * This guard used to live in the backend suite and read the module as TEXT, because this package
 * had no runner. Text is the wrong instrument for this: it can check that a name does not appear
 * in the source of `storage.ts`, and it cannot check the thing that actually matters — that a home
 * address handed to `buildPersistedOnboarding` does not come out the other end. So the important
 * cases below call the function and inspect the bytes it produced.
 *
 * `PII_FIELDS` is typed `Record<keyof FormationParty, string>`: adding a field to the PII slice
 * fails to COMPILE here until somebody adds it to this map, which is the moment to ask whether it
 * belongs in a browser store. That is the property the old string-array version did not have.
 */
import { expect, test } from "vitest";
import {
  buildPersistedOnboarding,
  PERSISTED_CONFIG_KEYS,
  PERSISTED_SESSION_KEYS,
} from "@/lib/onboarding/storage";
import {
  emptyConfig,
  emptySession,
  type AgentConfig,
  type FormationParty,
  type OnboardingSession,
} from "@/components/onboarding/types";
import type { EntityView } from "@/lib/api/types";

/** Every field of the PII slice, with a value distinctive enough to grep a JSON blob for. */
const PII_FIELDS: Record<keyof FormationParty, string> = {
  legalFirstName: "Augusta",
  legalLastName: "Kingnoorlaceborough",
  email: "augusta@pii-must-never-persist.test",
  phone: "+13075550100",
  line1: "12 Analytical Engine Way",
  line2: "Suite 1843",
  city: "Cheyennewegian",
  region: "WY",
  postalCode: "82001",
  country: "USA",
};

const PII_VALUES = Object.values(PII_FIELDS);
const PII_KEYS = Object.keys(PII_FIELDS) as (keyof FormationParty)[];

/** An entity view carrying the two owner-only facts formation adds: the EIN and the document index. */
function entityWithFormation(): EntityView {
  return {
    id: "ent_1",
    name: "Wizard agent",
    status: "funded",
    agentId: "881938",
    proxy: "0x1111111111111111111111111111111111111111",
    treasury: "0x2222222222222222222222222222222222222222",
    operator: null,
    manager: "0x3333333333333333333333333333333333333333",
    guardian: "0x4444444444444444444444444444444444444444",
    oaHash: null,
    metadataURI: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    error: null,
    perTxCap: null,
    trustPolicy: null,
    formation: {
      provider: "doola",
      environment: "sandbox",
      status: "complete",
      ein: "88-EIN-MUST-NOT-PERSIST",
      documents: [
        {
          id: "doc_1",
          type: "OperatingAgreement",
          name: "operating-agreement.pdf",
          size: 1024,
          sha256: "deadbeef",
        },
      ],
    },
  };
}

test("G6: no field of the PII slice is named in either persistence allowlist", () => {
  const persisted: string[] = [...PERSISTED_CONFIG_KEYS, ...PERSISTED_SESSION_KEYS];
  for (const field of PII_KEYS) expect(persisted, field).not.toContain(field);
});

test("G6: buildPersistedOnboarding strips PII BY VALUE, not by where it came from", () => {
  // The shape this guard exists to catch: somebody flattens the PII slice onto `AgentConfig`
  // (every key of which IS persisted), or hangs a `party` off the session "just until the user
  // comes back". Both leave the wizard working perfectly and put a home address in a browser
  // store, and both are one line.
  const config = { ...emptyConfig(), name: "Wizard agent", ...PII_FIELDS } as unknown as AgentConfig;
  const session = {
    ...emptySession(),
    companyId: "company_opaque_handle",
    party: { ...PII_FIELDS },
    // The one field that would be worst of all. A2 gave the wizard an SSN to collect, and the
    // shape this guard exists to catch is somebody hanging it off the session "just until the
    // user comes back" — one line, and the wizard keeps working perfectly.
    ssn: "123-45-6789",
  } as unknown as OnboardingSession;

  const bytes = JSON.stringify(
    buildPersistedOnboarding({ phase: "custody", config, done: {}, session }),
  );

  for (const value of PII_VALUES) expect(bytes, value).not.toContain(value);
  for (const field of PII_KEYS) expect(bytes, field).not.toContain(field);
  // ⚠ THE SSN, by value AND by key name. It never belongs in a browser store, in any shape.
  expect(bytes).not.toContain("123-45-6789");
  expect(bytes).not.toContain("ssn");
  // …and the handle, which identifies a FILING rather than a person, does survive — otherwise
  // this test would pass just as happily against a function that persisted nothing at all.
  expect(bytes).toContain("company_opaque_handle");
});

test("G6: only the OPAQUE COMPANY handle survives a reload — never the credential", () => {
  const session: string[] = [...PERSISTED_SESSION_KEYS];
  // A3: `companyId` REPLACES `partyId` and `partySynthetic`. The party handle is no longer an
  // onboard concept (the door refuses one), and "is this a demo?" is no longer wizard state at
  // all — it is read from the company row, whose pin is stamped at creation and immutable after,
  // so a remembered boolean would get a re-pointed deployment exactly backwards.
  expect(session).toContain("companyId");
  expect(session).not.toContain("partyId");
  expect(session).not.toContain("partySynthetic");
  // A passkey attestation is a single-use credential: a restored session re-does the ceremony
  // rather than replaying a stale one.
  expect(session).not.toContain("guardianPasskey");
});

test("G6: the entity's formation block never reaches storage, EIN and documents with it", () => {
  const persisted = buildPersistedOnboarding({
    phase: "fund",
    config: emptyConfig(),
    done: {},
    session: { ...emptySession(), entityId: "ent_1", entity: entityWithFormation() },
  });

  expect(persisted.session.entity?.formation).toBeNull();
  const bytes = JSON.stringify(persisted);
  expect(bytes).not.toContain("88-EIN-MUST-NOT-PERSIST");
  expect(bytes).not.toContain("operating-agreement.pdf");
  // The rest of the view is untouched — a wizard that lost the entity id could not resume.
  expect(persisted.session.entityId).toBe("ent_1");
  expect(persisted.session.entity?.id).toBe("ent_1");
});
