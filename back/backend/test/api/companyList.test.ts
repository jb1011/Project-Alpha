/**
 * The company list projection (design 2026-08-26 §7).
 *
 * `GET /companies` and MCP `list_companies` are ONE API-level contract — the reuse picker's
 * ordering and its labels — and they render through one function for that reason. This file
 * pins the two properties that made the old pair of literals a problem: the cost of a page, and
 * the fields it carries.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { listCompanyViews } from "../../src/api/views";
import { companyNameOptions } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";

const TENANT = "0x000000000000000000000000000000000000000A";

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
});
afterEach(() => db.close());

function seed(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = companies.create({
      tenantId: TENANT,
      status: "ready",
      provider: "doola",
      environment: "sandbox",
      synthetic: false,
      nameOptions: companyNameOptions(`Acme ${i} LLC`),
      businessPurpose: `purpose ${i}`,
      industryLabel: "Software development",
      intakeSynthesized: true,
    });
    ids.push(id);
    // Two agents each, so the batched count has something to group.
    for (const suffix of ["a", "b"])
      db.prepare(
        `INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay,
                               ein, formation_date, company_id)
         VALUES (?, ?, 'bound', '0x1', '0x2', '86400', 'STUB', 0, ?)`,
      ).run(`${id}-${suffix}`, `${id}-${suffix}`, id);
    requests.claimStep(id, "create_provider");
  }
  return ids;
}

test("a page of companies costs FOUR queries, however many rows it has", () => {
  seed(6);
  // Every row used to ask for its own steps, its own live-payment count and its own agent count:
  // 3N+1 per page view, on two authenticated surfaces, for three answers one grouped scan gives.
  const calls: string[] = [];
  const spyCompanies: SqliteCompanyRepository = Object.create(companies);
  for (const m of [
    "listByTenant",
    "countAgents",
    "countAgentsMany",
    "livePaymentCount",
    "livePaymentCountMany",
  ] as const)
    Object.defineProperty(spyCompanies, m, {
      value: (...args: never[]) => {
        calls.push(m);
        return (companies[m] as (...a: never[]) => unknown)(...args);
      },
    });
  const spyRequests: SqliteFormationRepository = Object.create(requests);
  for (const m of ["stepsOf", "stepsOfMany"] as const)
    Object.defineProperty(spyRequests, m, {
      value: (...args: never[]) => {
        calls.push(m);
        return (requests[m] as (...a: never[]) => unknown)(...args);
      },
    });

  const views = listCompanyViews(
    {
      companies: spyCompanies,
      formationStepsMany: (ids) => spyRequests.stepsOfMany(ids),
      formationSteps: (id) => spyRequests.stepsOf(id),
    },
    TENANT,
  );

  expect(views).toHaveLength(6);
  expect(calls.sort()).toEqual([
    "countAgentsMany",
    "listByTenant",
    "livePaymentCountMany",
    "stepsOfMany",
  ]);
});

test("the batched counts agree with the per-row ones, including for a company with none", () => {
  const [withAgents] = seed(1);
  const lonely = companies.create({
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Nobody LLC"),
    businessPurpose: "p",
    industryLabel: "Software development",
    intakeSynthesized: true,
  });
  db.prepare(
    `INSERT INTO formation_payments (payment_id, company_id, status, amount_usdc, nonce, valid_before)
     VALUES ('pay-1', ?, 'quoted', '399000000', 'ff', 1)`,
  ).run(withAgents);

  const agents = companies.countAgentsMany([withAgents!, lonely]);
  const paying = companies.livePaymentCountMany([withAgents!, lonely]);
  expect(agents.get(withAgents!)).toBe(companies.countAgents(withAgents!));
  expect(paying.get(withAgents!)).toBe(companies.livePaymentCount(withAgents!));
  // Absent from the map, not zero in it: a grouped count has no row for a company with none, and
  // the caller must not be able to mistake "no rows" for "not asked".
  expect(agents.has(lonely)).toBe(false);
  expect(paying.has(lonely)).toBe(false);

  const views = listCompanyViews({ companies }, TENANT);
  expect(views.find((v) => v.companyId === lonely)).toMatchObject({ agents: 0, paying: false });
  expect(views.find((v) => v.companyId === withAgents)).toMatchObject({ agents: 2, paying: true });
});
