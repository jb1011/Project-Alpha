/**
 * A1 MERGE GATE — is doola's idempotency comparison BYTE-wise or SEMANTIC? (design §4.7)
 *
 * Intake immutability rests on this. Name options, purpose, party fields and (from A2) the SSN
 * are frozen once the first create is sent, because a same-key retry must rebuild a body doola
 * accepts as "the same request". If the comparison is byte-wise over the serialized JSON, then a
 * key order that changes between two runs — a field added to an interface, a `JSON.stringify` of
 * an object built in a different order, an SSN column NULLed by erasure — is a
 * `409 E_IDEMPOTENCY_KEY_REUSED` and a formation parked for a human.
 *
 * One request settles it: the SAME key, the SAME values, the keys REORDERED.
 *
 *   - `200`/`201` with the same company id -> SEMANTIC. Field order is free; §4.7's
 *     canonicalization is belt-and-braces.
 *   - `409 E_IDEMPOTENCY_KEY_REUSED`        -> BYTE-WISE. The stored body must be replayed
 *     verbatim, and `expedited`-frozen-in-detail (§4.5) is load-bearing rather than tidy.
 *
 * This creates ONE sandbox company (the first call). The second call must not create a second
 * one; if it does, that is the most important line of the output.
 *
 * NOT a test: it costs a real sandbox company and needs a live key, so it never runs in CI, and
 * no test in this repo makes a live doola call.
 *
 *   DOOLA_API_KEY=dk_test_… npx tsx scripts/doola-idempotency-reorder-probe.mts
 */
import "dotenv/config";
import { type DoolaApiError, buildDoolaApi } from "../src/adapters/doola/doolaClient";
import type { CreateCompanyInput } from "../src/adapters/doola/types";
import { DOOLA_BASE_URLS } from "../src/config/env";

const apiKey = process.env.DOOLA_API_KEY;
if (!apiKey) throw new Error("DOOLA_API_KEY is required (sandbox key: dk_test_…)");
if (!apiKey.startsWith("dk_test_"))
  throw new Error("refusing to run: this probe CREATES A COMPANY and is sandbox-only (dk_test_…)");

const api = buildDoolaApi({
  apiKey,
  baseUrl: process.env.DOOLA_BASE_URL ?? DOOLA_BASE_URLS.sandbox,
  environment: "sandbox",
});

const RUN = process.env.PROBE_RUN ?? String(Math.floor(Date.now() / 1000));
const key = (label: string) => `reorder:${RUN}:${label}`;

const ADDRESS = {
  line1: "30 N Gould St",
  line2: "STE R",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  country: "USA",
  phone: "+13075550142",
};

const PARTY = {
  legalFirstName: "Novi",
  legalLastName: "SandboxGuardian",
  email: `sandbox+reorder-${RUN}@novicorpus.com`,
};

const NAME = `Novi Reorder Probe ${RUN}`;

/** The body as our filer builds it. */
function inOrder(customerId: string): CreateCompanyInput {
  return {
    doolaCustomerId: customerId,
    entityType: "LLC",
    state: "WY",
    nameOptions: [{ name: NAME, entityTypeEnding: "LLC", position: 1 }],
    industry: "Software development",
    description: "Idempotency key-order probe for the Novi formation integration.",
    responsibleParty: { ...PARTY, address: ADDRESS },
    addresses: [
      { provider: "registeredAgent", type: "mailing" },
      { provider: "registeredAgent", type: "business" },
    ],
    members: [{ ...PARTY, isNaturalPerson: true, address: ADDRESS, ownershipPercent: 100 }],
  };
}

/**
 * The SAME VALUES with every object's keys in a different order — including the nested address
 * and the name option, which is where a real drift would show up first.
 *
 * `JSON.stringify` preserves insertion order, so this is genuinely different bytes and
 * semantically identical content. Nothing here changes a value.
 */
function reordered(customerId: string): CreateCompanyInput {
  const address = {
    phone: ADDRESS.phone,
    country: ADDRESS.country,
    postalCode: ADDRESS.postalCode,
    state: ADDRESS.state,
    city: ADDRESS.city,
    line2: ADDRESS.line2,
    line1: ADDRESS.line1,
  };
  const party = {
    email: PARTY.email,
    legalLastName: PARTY.legalLastName,
    legalFirstName: PARTY.legalFirstName,
  };
  return {
    members: [{ ownershipPercent: 100, address, isNaturalPerson: true, ...party }],
    addresses: [
      { type: "mailing", provider: "registeredAgent" },
      { type: "business", provider: "registeredAgent" },
    ],
    responsibleParty: { address, ...party },
    description: "Idempotency key-order probe for the Novi formation integration.",
    industry: "Software development",
    nameOptions: [{ position: 1, entityTypeEnding: "LLC", name: NAME }],
    state: "WY",
    entityType: "LLC",
    doolaCustomerId: customerId,
  } as CreateCompanyInput;
}

async function main() {
  console.log(`run ${RUN}`);
  const customer = await api.createCustomer(
    {
      firstName: PARTY.legalFirstName,
      lastName: PARTY.legalLastName,
      email: PARTY.email,
      countryOfResidence: "USA",
      phoneNumber: ADDRESS.phone,
    },
    key("customer"),
  );
  console.log("customer:", customer.doolaCustomerId);

  const first = await api.createCompany(inOrder(customer.doolaCustomerId), key("company"));
  console.log("first create  ->", first.doolaCompanyId);
  console.log("body bytes    ->", JSON.stringify(inOrder(customer.doolaCustomerId)).length);
  console.log("reorder bytes ->", JSON.stringify(reordered(customer.doolaCustomerId)).length);

  try {
    // THE request the gate is about: same key, same values, different key order.
    const second = await api.createCompany(reordered(customer.doolaCustomerId), key("company"));
    console.log("\nstatus: ACCEPTED (2xx)");
    console.log(`second create -> ${second.doolaCompanyId}`);
    console.log(
      second.doolaCompanyId === first.doolaCompanyId
        ? "VERDICT: SEMANTIC — the replay returned the SAME company. Field order is free."
        : "⚠ VERDICT: A SECOND COMPANY WAS CREATED. Stop and re-read §4.7 before shipping A2.",
    );
  } catch (e) {
    const err = e as DoolaApiError;
    console.log("\nstatus:", err.status ?? "(transport)", err.code ?? "");
    console.log(
      err.code === "E_IDEMPOTENCY_KEY_REUSED"
        ? "VERDICT: BYTE-WISE — the stored body must be replayed VERBATIM. Intake immutability and\n         the frozen `expedited` flag (§4.5) are load-bearing, not tidiness."
        : `VERDICT: inconclusive — ${err.message}`,
    );
  }

  // Whatever the answer, exactly ONE company must exist under this customer.
  const companies = await api.listCompanies(customer.doolaCustomerId);
  console.log(`\ncompanies under this customer: ${companies.length} (expected 1)`);
  console.log("Record the verdict in docs/runbooks/doola-idempotency-verification-2026-08.md.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
