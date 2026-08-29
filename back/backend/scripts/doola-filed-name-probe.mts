/**
 * A1 MERGE GATE — where is the ACCEPTED company name actually readable? (design §5)
 *
 * `manifest.legal.companyName` is a legal fact hashed onto a public chain, so it is set only by
 * MATCHING doola's reported name against one of OUR stored candidates — never from doola free
 * text. That matcher needs one thing the docs do not settle: WHICH field carries the accepted
 * name when a lower-ranked option is filed. The full company response has `nameOptions` with no
 * winner flag; the LIST item has a bare `name`; the Articles of Organization have the real one.
 *
 * So this asks the sandbox, with three DISTINCT candidates so the answer cannot be ambiguous:
 *
 *   1. create a customer and a company with three name options, ranked;
 *   2. complete the formation through the playground endpoint;
 *   3. print, side by side, what each surface reports:
 *        - `GET /companies` (list item) `.name`
 *        - `GET /companies/{id}` (full) `.nameOptions`
 *        - the ArticlesOfOrganization document's `name`
 *
 * Record the output in `docs/runbooks/doola-filed-name-2026-08.md` and point §5's matcher at
 * whichever surface actually carries it.
 *
 * NOT a test: it costs a real sandbox company and needs a live key, so it never runs in CI, and
 * no test in this repo makes a live doola call.
 *
 *   DOOLA_API_KEY=dk_test_… npx tsx scripts/doola-filed-name-probe.mts
 */
import "dotenv/config";
import { buildDoolaApi } from "../src/adapters/doola/doolaClient";
import type { CreateCompanyInput } from "../src/adapters/doola/types";
import { DOOLA_BASE_URLS } from "../src/config/env";
import { normalizeCompanyName } from "../src/formation/intake";

const apiKey = process.env.DOOLA_API_KEY;
if (!apiKey) throw new Error("DOOLA_API_KEY is required (sandbox key: dk_test_…)");
if (!apiKey.startsWith("dk_test_"))
  throw new Error("refusing to run: this probe CREATES A COMPANY and is sandbox-only (dk_test_…)");

const api = buildDoolaApi({
  apiKey,
  baseUrl: process.env.DOOLA_BASE_URL ?? DOOLA_BASE_URLS.sandbox,
  environment: "sandbox",
});

/** One run's key namespace, so a re-run never collides with a previous run's keys. */
const RUN = process.env.PROBE_RUN ?? String(Math.floor(Date.now() / 1000));
const key = (label: string) => `filed-name:${RUN}:${label}`;

/**
 * THREE DISTINCT candidates, ranked.
 *
 * Distinct on purpose: if all three shared a stem, a surface reporting "the first one" and a
 * surface reporting "the accepted one" would look identical and the probe would prove nothing.
 */
const CANDIDATES = [
  `Novi Filed Name Alpha ${RUN}`,
  `Novi Filed Name Bravo ${RUN}`,
  `Novi Filed Name Charlie ${RUN}`,
];

/** doola's own registered-agent address; doola REQUIRES a phone on a natural person's address. */
const ADDRESS = {
  line1: "30 N Gould St",
  line2: "STE R",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  country: "USA",
  phone: "+13075550142",
};

function companyBody(customerId: string): CreateCompanyInput {
  return {
    doolaCustomerId: customerId,
    entityType: "LLC",
    state: "WY",
    nameOptions: CANDIDATES.map((name, i) => ({
      name,
      entityTypeEnding: "LLC",
      position: i + 1,
    })),
    industry: "Software development",
    description: "Filed-name readability probe for the Novi formation integration.",
    responsibleParty: {
      legalFirstName: "Novi",
      legalLastName: "SandboxGuardian",
      email: `sandbox+filed-name-${RUN}@novicorpus.com`,
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

/** Would OUR matcher (§5) accept this string as one of our candidates? */
function matches(reported: string | null | undefined): string {
  if (!reported) return "(nothing reported)";
  const wanted = normalizeCompanyName(reported);
  const hit = CANDIDATES.find((c) => normalizeCompanyName(c) === wanted);
  return hit ? `MATCHES candidate #${CANDIDATES.indexOf(hit) + 1}` : "NO MATCH (would stay NULL)";
}

async function main() {
  console.log(`run ${RUN}`);
  console.log("candidates:", CANDIDATES.map((c, i) => `${i + 1}. ${c}`).join("  |  "));

  const customer = await api.createCustomer(
    {
      firstName: "Novi",
      lastName: "SandboxGuardian",
      email: `sandbox+filed-name-${RUN}@novicorpus.com`,
      countryOfResidence: "USA",
      phoneNumber: ADDRESS.phone,
    },
    key("customer"),
  );
  console.log("customer:", customer.doolaCustomerId);

  const created = await api.createCompany(companyBody(customer.doolaCustomerId), key("company"));
  console.log("company:", created.doolaCompanyId);

  // The sandbox-only fast-forward: without it the formation sits in doola's queue and this probe
  // would have nothing to read.
  const completed = await api.playgroundCompleteFormation(created.doolaCompanyId);
  console.log("playgroundCompleteFormation:", JSON.stringify(completed ?? null));

  // ── the three surfaces, side by side ─────────────────────────────────────────────────────
  const full = await api.getCompany(created.doolaCompanyId);
  const list = await api.listCompanies(customer.doolaCustomerId);
  const item = list.find((c) => c.doolaCompanyId === created.doolaCompanyId);
  const documents = await api.listDocuments(created.doolaCompanyId);
  const aoo = documents.find((d) => d.documentType === "ArticlesOfOrganization");

  console.log("\n── where the accepted name is readable ──");
  console.log(`list item .name          : ${item?.name ?? "(absent)"}   -> ${matches(item?.name)}`);
  console.log(`full .nameOptions        : ${JSON.stringify(full.nameOptions ?? null)}`);
  console.log(`full .formationFilingNum : ${full.formationFilingNumber ?? "(absent)"}`);
  console.log(
    `AOO document .name       : ${aoo?.name ?? "(no AOO yet)"}   -> ${matches(aoo?.name)}`,
  );
  console.log(
    "\nRecord this in docs/runbooks/doola-filed-name-2026-08.md, and point the §5 matcher at",
  );
  console.log("whichever surface reports a name that MATCHES one of our candidates.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
