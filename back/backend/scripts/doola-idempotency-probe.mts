/**
 * PR 2 MERGE GATE — verify doola's `Idempotency-Key` contract LIVE against the sandbox.
 *
 * The create_provider step's crash-window rule ("adopt, never re-file") rests entirely on this
 * contract. A miss in production is a duplicate real Wyoming LLC and a real fee, so the contract
 * is verified against the live host rather than assumed from the docs.
 *
 * Three properties, one run:
 *   1. same key + same body, twice  -> the SAME company id, and no second company exists;
 *   2. same key + a DIFFERENT body  -> 409 E_IDEMPOTENCY_KEY_REUSED (never a silent second file);
 *   3. a FAILED create RELEASES its key -> the same key then succeeds with a corrected body.
 *
 * NOT a test: it costs real sandbox companies and needs a live key, so it never runs in CI.
 *
 *   DOOLA_API_KEY=dk_test_… npx tsx scripts/doola-idempotency-probe.mts
 *
 * The key is read from the environment and is written to no file — as with every other live
 * probe script in this directory. Companies it creates are named "Novi PR2 Idem Probe <n>" so
 * they are identifiable in the doola portal.
 *
 * Results of the 2026-08 run: docs/runbooks/doola-idempotency-verification-2026-08.md.
 */
import "dotenv/config";
import { DoolaApiError, buildDoolaApi } from "../src/adapters/doola/doolaClient";
import type { CreateCompanyInput } from "../src/adapters/doola/types";
import { DOOLA_BASE_URLS } from "../src/config/env";

const apiKey = process.env.DOOLA_API_KEY;
if (!apiKey) throw new Error("DOOLA_API_KEY is required (sandbox key: dk_test_…)");
if (!apiKey.startsWith("dk_test_"))
  throw new Error("refusing to run: this probe CREATES COMPANIES and is sandbox-only (dk_test_…)");

const api = buildDoolaApi({
  apiKey,
  baseUrl: process.env.DOOLA_BASE_URL ?? DOOLA_BASE_URLS.sandbox,
  environment: "sandbox",
});

/** One run's key namespace, so a re-run never collides with a previous run's keys. */
const RUN = process.env.PROBE_RUN ?? String(Math.floor(Date.now() / 1000));
const key = (label: string) => `probe:${RUN}:${label}`;

/** doola's own registered-agent address, and a placeholder phone: doola REQUIRES a phone on a
 *  natural person's address. */
const ADDRESS = {
  line1: "30 N Gould St",
  line2: "STE R",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  country: "USA",
  phone: "+13075550142",
};

function companyBody(customerId: string, name: string): CreateCompanyInput {
  return {
    doolaCustomerId: customerId,
    entityType: "LLC",
    state: "WY",
    nameOptions: [{ name, entityTypeEnding: "LLC", position: 1 }],
    industry: "Software development",
    description: "Idempotency-key contract probe for the Novi formation integration.",
    responsibleParty: {
      legalFirstName: "Novi",
      legalLastName: "SandboxGuardian",
      email: `sandbox+probe-${RUN}@novicorpus.com`,
      address: ADDRESS,
    },
    addresses: [
      { provider: "registeredAgent", type: "mailing" },
      { provider: "registeredAgent", type: "business" },
    ],
    members: [
      {
        legalFirstName: "Novi",
        legalLastName: "SandboxGuardian",
        isNaturalPerson: true,
        address: ADDRESS,
        ownershipPercent: 100,
      },
    ],
  };
}

function show(label: string, value: unknown): void {
  console.log(`\n── ${label}\n${JSON.stringify(value, null, 2)}`);
}

function errorOf(e: unknown): Record<string, unknown> {
  if (e instanceof DoolaApiError)
    return { name: e.name, code: e.code, status: e.status, message: e.message, fields: e.fields };
  return { name: (e as Error).name, message: (e as Error).message };
}

async function main(): Promise<void> {
  console.log(`doola idempotency probe — run ${RUN}`);

  // ── Customer. Also property 1, on the OTHER create endpoint: the same key + the same body
  //    must return the same customer rather than minting a second one.
  const customerBody = {
    firstName: "Novi",
    lastName: "SandboxGuardian",
    email: `sandbox+probe-${RUN}@novicorpus.com`,
    countryOfResidence: "USA",
  };
  const c1 = await api.createCustomer(customerBody, key("customer"));
  const c2 = await api.createCustomer(customerBody, key("customer"));
  show("1a. POST /customers twice with the same key + body", {
    first: c1,
    second: c2,
    sameId: c1.doolaCustomerId === c2.doolaCustomerId,
  });
  const customerId = c1.doolaCustomerId;

  // ── Property 1: same key + same body on POST /companies.
  const bodyA = companyBody(customerId, `Novi PR2 Idem Probe ${RUN}A`);
  const co1 = await api.createCompany(bodyA, key("companyA"));
  const co2 = await api.createCompany(bodyA, key("companyA"));
  show("1b. POST /companies twice with the same key + body", {
    firstId: co1.doolaCompanyId,
    secondId: co2.doolaCompanyId,
    sameId: co1.doolaCompanyId === co2.doolaCompanyId,
  });

  // …and prove it structurally, not just by the echoed id: the customer must own exactly one.
  const listed = await api.listCompanies(customerId);
  show("1c. GET /companies?customerId=… after the double create", {
    count: listed.length,
    ids: listed.map((c) => c.doolaCompanyId),
  });

  // ── Property 2: same key, DIFFERENT body.
  const bodyB = companyBody(customerId, `Novi PR2 Idem Probe ${RUN}B`);
  let reuse: Record<string, unknown>;
  try {
    const co3 = await api.createCompany(bodyB, key("companyA"));
    reuse = { UNEXPECTED_SUCCESS: true, id: co3.doolaCompanyId };
  } catch (e) {
    reuse = errorOf(e);
  }
  show("2. POST /companies, SAME key, DIFFERENT body", reuse);

  // ── Property 3: a FAILED create releases its key.
  //    An empty nameOptions array is a validation failure doola commits nothing for.
  const releaseKey = key("companyC");
  let failure: Record<string, unknown>;
  try {
    await api.createCompany({ ...companyBody(customerId, "x"), nameOptions: [] }, releaseKey);
    failure = { UNEXPECTED_SUCCESS: true };
  } catch (e) {
    failure = errorOf(e);
  }
  show("3a. POST /companies with an INVALID body (burns nothing)", failure);

  let retried: Record<string, unknown>;
  try {
    const co4 = await api.createCompany(
      companyBody(customerId, `Novi PR2 Idem Probe ${RUN}C`),
      releaseKey,
    );
    retried = { id: co4.doolaCompanyId, formationSubmissionStatus: co4.formationSubmissionStatus };
  } catch (e) {
    retried = errorOf(e);
  }
  show("3b. RETRY with the SAME key and a corrected body", retried);

  const finalList = await api.listCompanies(customerId);
  show("4a. companies under the probe customer, read IMMEDIATELY", {
    count: finalList.length,
    companies: finalList.map((c) => ({ id: c.doolaCompanyId, name: c.name })),
  });

  // The same read after a pause. GET /companies is EVENTUALLY consistent with the creates, so a
  // pre-create lookup can answer "nothing here" about a company that already exists — which is
  // why the lookup may only ever ADOPT, never authorize a fresh file.
  await new Promise((r) => setTimeout(r, 15_000));
  const settled = await api.listCompanies(customerId);
  show("4b. the SAME read 15s later (eventual consistency)", {
    count: settled.length,
    companies: settled.map((c) => ({
      id: c.doolaCompanyId,
      name: c.name,
      formationSubmissionStatus: c.formationSubmissionStatus,
    })),
  });
}

main().catch((e) => {
  console.error(errorOf(e));
  process.exit(1);
});
