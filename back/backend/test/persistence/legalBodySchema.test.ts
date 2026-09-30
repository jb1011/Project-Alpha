import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";

const TENANT = "0x00000000000000000000000000000000000000A1";
const OWNER = "0x00000000000000000000000000000000000000A2";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const BODY = "0x00000000000000000000000000000000000000B1";
const H = (c: string) => `0x${c.repeat(64)}`;
/** Well-formed ids for rows written by raw SQL: `lb_` and 36 characters; a 36-character public id. */
const lb = (label: string | number) => `lb_${String(label).padStart(36, "0")}`;
const pub = (label: string | number) => String(label).padStart(36, "0");

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
});

function insertDraft(id = lb("1"), publicId = pub("1")) {
  db.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
     VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
  ).run(id, publicId, TENANT, FACTORY, TENANT);
}
const freeze = (id = lb("1")) =>
  db
    .prepare(
      "UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = 1 WHERE legal_body_id = ?",
    )
    .run(H("a"), id);
const reserve = (id = lb("1"), agent = "42", body = BODY) =>
  db
    .prepare(
      `UPDATE legal_bodies SET agent_id = ?, identity_owner = ?, link_digest = ?, link_deadline = 1900000000,
         link_signature = '0x01', body_address = ?, binding_state = 'reserved' WHERE legal_body_id = ?`,
    )
    .run(agent, OWNER, H("b"), body, id);
const deploy = (id = lb("1")) =>
  db
    .prepare(
      "UPDATE legal_bodies SET create_tx_hash = ?, deployed_at = 1800000000, binding_state = 'deployed' WHERE legal_body_id = ?",
    )
    .run(H("c"), id);

test("migrate is idempotent and creates both tables", () => {
  expect(() => migrate(db)).not.toThrow();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'legal_bod%'")
    .all()
    .map((r) => (r as { name: string }).name)
    .sort();
  expect(names).toEqual(["legal_bodies", "legal_body_events"]);
});

test("a draft needs no link fields; binding_state defaults to draft", () => {
  insertDraft();
  expect(db.prepare("SELECT binding_state FROM legal_bodies").get()).toEqual({
    binding_state: "draft",
  });
});

test("guardian must equal tenant, structurally", () => {
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES ('${lb("x")}', '${pub("x")}', ?, 'co_1', 5042002, ?, ?, 172800)`,
      )
      .run(TENANT, FACTORY, OWNER),
  ).toThrow(/CHECK/);
});

test("amendment delay outside 48 hours .. 30 days is refused", () => {
  for (const d of [172799, 2592001])
    expect(() =>
      db
        .prepare(
          `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
           VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, ?)`,
        )
        .run(lb(`${d}`), pub(`${d}`), TENANT, FACTORY, TENANT, d),
    ).toThrow(/CHECK/);
});

test("a company that does not exist is refused (foreign key)", () => {
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES ('${lb("y")}', '${pub("y")}', ?, 'co_missing', 5042002, ?, ?, 172800)`,
      )
      .run(TENANT, FACTORY, TENANT),
  ).toThrow(/FOREIGN KEY/);
});

test("leaving draft requires every link field and a frozen agreement", () => {
  insertDraft();
  expect(() => reserve()).toThrow(/CHECK/); // no frozen agreement yet
  freeze();
  expect(() => reserve()).not.toThrow();
});

test("deployed requires the deploy facts", () => {
  insertDraft();
  freeze();
  reserve();
  expect(() =>
    db
      .prepare(
        `UPDATE legal_bodies SET binding_state = 'deployed' WHERE legal_body_id = '${lb("1")}'`,
      )
      .run(),
  ).toThrow(/CHECK/);
  expect(() => deploy()).not.toThrow();
});

test("illegal state transitions are refused by the database", () => {
  insertDraft();
  freeze();
  const to = (s: string) =>
    db
      .prepare(`UPDATE legal_bodies SET binding_state = ? WHERE legal_body_id = '${lb("1")}'`)
      .run(s);
  expect(() => to("deployed")).toThrow(/illegal binding_state transition|CHECK/);
  reserve();
  expect(() => to("linked")).toThrow(/illegal binding_state transition/);
  expect(() => to("draft")).toThrow(/illegal binding_state transition/);
  deploy();
  expect(() => to("reserved")).toThrow(/illegal binding_state transition/);
  db.prepare(
    `UPDATE legal_bodies SET binding_state = 'linked', pointer_seen_at = 1800000100 WHERE legal_body_id = '${lb("1")}'`,
  ).run();
  expect(() => to("superseded")).toThrow(/illegal binding_state transition/);
  expect(() => to("broken")).not.toThrow();
  expect(() => to("linked")).not.toThrow();
});

test("identity, agreement and link fields are write-once", () => {
  insertDraft();
  freeze();
  reserve();
  for (const [col, v] of [
    ["tenant_id", OWNER],
    ["guardian", OWNER],
    ["company_id", "co_1"],
    ["chain_id", 1],
    ["factory", OWNER],
    ["amendment_delay", 172801],
    ["public_id", "other"],
    ["oa_manifest_hash", H("d")],
    ["agent_id", "43"],
    ["identity_owner", TENANT],
    ["link_digest", H("e")],
    ["body_address", OWNER],
  ] as const) {
    if (col === "company_id") continue; // same value: allowed by construction
    expect(
      () =>
        db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = '${lb("1")}'`).run(v),
      col,
    ).toThrow(/write-once/);
  }
});

test("the write-once fields the loop above cannot reach are pinned too", () => {
  // A second company of the same tenant, so moving a body to it is a real change of company.
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_2', ?, 'ready', 'customer', 'sandbox', '["Other LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  insertDraft();
  freeze();
  reserve();
  deploy();
  for (const [col, v] of [
    ["legal_body_id", lb("other")],
    ["company_id", "co_2"],
    ["oa_manifest_version", 2],
    ["link_deadline", 1900000001],
    ["link_signature", "0x02"],
    ["deployed_at", 1800000001],
    // Clearing a field is a change too: a reservation cannot be un-set to be re-pointed later.
    ["agent_id", null],
    ["body_address", null],
    ["oa_manifest_hash", null],
    ["deployed_at", null],
  ] as const) {
    expect(
      () =>
        db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = '${lb("1")}'`).run(v),
      `${col} = ${v}`,
    ).toThrow(/write-once/);
  }
  expect(db.prepare("SELECT company_id, agent_id FROM legal_bodies").get()).toEqual({
    company_id: "co_1",
    agent_id: "42",
  });
});

test("rows are never deleted", () => {
  insertDraft();
  expect(() => db.prepare("DELETE FROM legal_bodies").run()).toThrow(/never deleted/);
});

test("one live body per agentId per chain; a lapsed one frees the agentId", () => {
  insertDraft(lb("1"), pub("1"));
  insertDraft(lb("2"), pub("2"));
  freeze(lb("1"));
  freeze(lb("2"));
  reserve(lb("1"), "42", BODY);
  expect(() => reserve(lb("2"), "42", OWNER)).toThrow(/UNIQUE/);
  db.prepare(
    `UPDATE legal_bodies SET binding_state = 'lapsed' WHERE legal_body_id = '${lb("1")}'`,
  ).run();
  expect(() => reserve(lb("2"), "42", OWNER)).not.toThrow();
});

test("one row per deployed body address per chain", () => {
  insertDraft(lb("1"), pub("1"));
  insertDraft(lb("2"), pub("2"));
  freeze(lb("1"));
  freeze(lb("2"));
  reserve(lb("1"), "42", BODY);
  db.prepare(
    `UPDATE legal_bodies SET binding_state = 'lapsed' WHERE legal_body_id = '${lb("1")}'`,
  ).run();
  expect(() => reserve(lb("2"), "43", BODY)).toThrow(/UNIQUE/);
});

test("the event log is append-only and bound to an existing legal body", () => {
  insertDraft();
  const ins = db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES (?, 'created', 'system')",
  );
  ins.run(lb("1"));
  expect(() => ins.run(lb("missing"))).toThrow(/FOREIGN KEY/);
  expect(() => db.prepare("UPDATE legal_body_events SET kind = 'x'").run()).toThrow(/append-only/);
  expect(() => db.prepare("DELETE FROM legal_body_events").run()).toThrow(/append-only/);
});

test("the new tables leave entities untouched", () => {
  const cols = (db.prepare("PRAGMA table_info(entities)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).not.toContain("kind");
  expect(cols).not.toContain("binding_state");
});

// ── The guards against SQLite's REPLACE conflict resolution, and every state reached legally ──

type State =
  | "draft"
  | "reserved"
  | "deployed"
  | "linked"
  | "broken"
  | "lapsed"
  | "superseded"
  | "abandoned";
const STATES: readonly State[] = [
  "draft",
  "reserved",
  "deployed",
  "linked",
  "broken",
  "lapsed",
  "superseded",
  "abandoned",
];

// The columns each state's CHECKs require, as SET clauses holding exactly the values `bodyIn`
// writes: a move that sets them again changes no write-once field, so when such a move is
// refused, it is the transition rule that refused it, never a missing column.
const LINK_SET = `agent_id = '42', identity_owner = '${OWNER}', link_digest = '${H("b")}',
  link_deadline = 1900000000, link_signature = '0x01', body_address = '${BODY}'`;
const DEPLOY_SET = `create_tx_hash = '${H("c")}', deployed_at = 1800000000`;
const NEEDS: Record<State, string> = {
  draft: "",
  abandoned: "",
  reserved: LINK_SET,
  lapsed: LINK_SET,
  deployed: `${LINK_SET}, ${DEPLOY_SET}`,
  superseded: `${LINK_SET}, ${DEPLOY_SET}`,
  broken: `${LINK_SET}, ${DEPLOY_SET}`,
  linked: `${LINK_SET}, ${DEPLOY_SET}, pointer_seen_at = 1800000100`,
};
/** The legal path from a frozen draft to each state. */
const PATH: Record<State, State[]> = {
  draft: [],
  reserved: ["reserved"],
  deployed: ["reserved", "deployed"],
  linked: ["reserved", "deployed", "linked"],
  broken: ["reserved", "deployed", "linked", "broken"],
  lapsed: ["reserved", "lapsed"],
  superseded: ["reserved", "deployed", "superseded"],
  abandoned: ["abandoned"],
};

/** Move body `lb("1")` to `to` (NULL included), setting what the target's CHECKs need in one UPDATE. */
const moveTo = (d: Database.Database, to: State | null, verb = "UPDATE") =>
  d
    .prepare(
      `${verb} legal_bodies SET binding_state = ?${to && NEEDS[to] ? `, ${NEEDS[to]}` : ""}
        WHERE legal_body_id = '${lb("1")}'`,
    )
    .run(to);
const stateOf = (d: Database.Database) =>
  (
    d
      .prepare(`SELECT binding_state FROM legal_bodies WHERE legal_body_id = '${lb("1")}'`)
      .get() as {
      binding_state: State;
    }
  ).binding_state;

/** A fresh, migrated database with the tenant's company `co_1`. */
function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  d.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  return d;
}

/** A frozen draft `id` in `d`, with its `created` event unless `withEvent` is false. */
function frozenDraftIn(d: Database.Database, id: string, withEvent = true) {
  d.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
     VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
  ).run(id, id.slice(3), TENANT, FACTORY, TENANT);
  if (withEvent)
    d.prepare(
      "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES (?, 'created', 'system')",
    ).run(id);
  d.prepare(
    "UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = 1 WHERE legal_body_id = ?",
  ).run(H("a"), id);
}

/** A fresh database holding body `lb("1")` (with its `created` event), walked legally into `state`. */
function bodyIn(state: State): Database.Database {
  const d = freshDb();
  frozenDraftIn(d, lb("1"));
  for (const s of PATH[state]) moveTo(d, s);
  expect(stateOf(d)).toBe(state);
  return d;
}

const addCompany = (id: string, tenant: string) =>
  db
    .prepare(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
       VALUES (?, ?, 'ready', 'customer', 'sandbox', '["Other LLC"]', 'existing', 'existing')`,
    )
    .run(id, tenant);
const OTHER_BODY = "0x00000000000000000000000000000000000000b2";

test("REPLACE INTO cannot rewrite an existing body: rows are never replaced", () => {
  // REPLACE swaps the old row for a new one rather than updating it, so the UPDATE guards never
  // see it: the INSERT guard is what refuses it.
  addCompany("co_2", OWNER);
  insertDraft();
  db.prepare(
    `INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('${lb("1")}', 'created', 'system')`,
  ).run();
  freeze();
  reserve();
  deploy();
  const before = db.prepare("SELECT * FROM legal_bodies").all();
  // Same primary key; a new tenant, guardian, company, agent and body, born straight into linked.
  expect(() =>
    db
      .prepare(
        `REPLACE INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian,
           amendment_delay, oa_manifest_hash, oa_manifest_version, agent_id, identity_owner, link_digest,
           link_deadline, link_signature, body_address, create_tx_hash, deployed_at, binding_state, pointer_seen_at)
         VALUES ('${lb("1")}', '${pub("1")}', ?, 'co_2', 5042002, ?, ?, 172800, ?, 9, '99', ?, ?, 1, '0x09', ?, ?, 1, 'linked', 1)`,
      )
      .run(OWNER, FACTORY, OWNER, H("f"), TENANT, H("e"), OTHER_BODY, H("d")),
  ).toThrow(/born draft and never replaced/);
  // Not even a well-formed draft may land on an existing primary key or public id.
  for (const [id, publicId] of [
    [lb("1"), pub("new")],
    [lb("new"), pub("1")],
  ])
    expect(
      () =>
        db
          .prepare(
            `REPLACE INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
             VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
          )
          .run(id, publicId, TENANT, FACTORY, TENANT),
      `${id} / ${publicId}`,
    ).toThrow(/born draft and never replaced/);
  expect(db.prepare("SELECT * FROM legal_bodies").all()).toEqual(before);
});

test("a row is born draft: an INSERT straight into any other state, or NULL, is refused", () => {
  for (const s of [
    "reserved",
    "deployed",
    "linked",
    "broken",
    "lapsed",
    "superseded",
    "abandoned",
    null,
  ])
    expect(
      () =>
        db
          .prepare(
            `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian,
               amendment_delay, oa_manifest_hash, oa_manifest_version, agent_id, identity_owner, link_digest,
               link_deadline, link_signature, body_address, create_tx_hash, deployed_at, binding_state,
               pointer_seen_at)
             VALUES ('${lb("9")}', '${pub("9")}', ?, 'co_1', 5042002, ?, ?, 172800, ?, 1, '42', ?, ?, 1900000000, '0x01', ?, ?,
               1800000000, ?, 1800000100)`,
          )
          .run(TENANT, FACTORY, TENANT, H("a"), OWNER, H("b"), BODY, H("c"), s),
      String(s),
    ).toThrow(/born draft and never replaced/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
});

test("REPLACE INTO cannot rewrite an event: no INSERT lands on an existing event id", () => {
  insertDraft();
  db.prepare(
    `INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('${lb("1")}', 'created', 'system')`,
  ).run();
  const before = db.prepare("SELECT * FROM legal_body_events").all() as { id: number }[];
  expect(() =>
    db
      .prepare(
        `REPLACE INTO legal_body_events (id, legal_body_id, kind, actor, detail)
         VALUES (?, '${lb("1")}', 'note', 'operator:x', 'rewritten')`,
      )
      .run(before[0]?.id),
  ).toThrow(/append-only/);
  expect(db.prepare("SELECT * FROM legal_body_events").all()).toEqual(before);
  // Appending is untouched.
  db.prepare(
    `INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('${lb("1")}', 'note', 'system')`,
  ).run();
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_body_events").get()).toEqual({ n: 2 });
});

test("UPDATE OR REPLACE cannot send a body back to draft through a NULL state", () => {
  // OR REPLACE turns a NOT NULL violation into the column default, 'draft', so the transition
  // rule has to refuse the NULL target itself, before that substitution can happen.
  for (const from of ["reserved", "deployed", "linked", "broken"] as const) {
    const d = bodyIn(from);
    expect(() => moveTo(d, null, "UPDATE OR REPLACE"), from).toThrow(
      /illegal binding_state transition/,
    );
    expect(
      d.prepare("SELECT binding_state, agent_id, body_address FROM legal_bodies").get(),
    ).toEqual({ binding_state: from, agent_id: "42", body_address: BODY });
    d.close();
  }
});

test("the deploy hash may be re-sent while reserved, and is locked once the body is deployed", () => {
  insertDraft();
  freeze();
  reserve();
  const submit = (h: string) =>
    db
      .prepare(
        `UPDATE legal_bodies SET create_tx_hash = ? WHERE legal_body_id = '${lb("1")}' AND binding_state = 'reserved'`,
      )
      .run(h);
  expect(submit(H("1")).changes).toBe(1);
  expect(submit(H("2")).changes).toBe(1); // re-sent with a new nonce, so a new hash
  deploy(); // the transaction that landed: create_tx_hash = H("c")
  for (const v of [H("9"), null])
    expect(
      () =>
        db
          .prepare(`UPDATE legal_bodies SET create_tx_hash = ? WHERE legal_body_id = '${lb("1")}'`)
          .run(v),
      String(v),
    ).toThrow(/write-once/);
  expect(db.prepare("SELECT create_tx_hash FROM legal_bodies").get()).toEqual({
    create_tx_hash: H("c"),
  });
});

test("a draft holds no link fields: it cannot squat on a body address or an agentId", () => {
  insertDraft();
  freeze();
  for (const [col, v] of [
    ["body_address", BODY],
    ["agent_id", "42"],
    ["identity_owner", OWNER],
    ["link_digest", H("b")],
    ["link_deadline", 1900000000],
    ["link_signature", "0x01"],
  ] as const)
    expect(
      () =>
        db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = '${lb("1")}'`).run(v),
      col,
    ).toThrow(/CHECK/);
  // Nor can a draft be born holding one.
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian,
           amendment_delay, body_address)
         VALUES ('${lb("2")}', '${pub("2")}', ?, 'co_1', 5042002, ?, ?, 172800, ?)`,
      )
      .run(TENANT, FACTORY, TENANT, BODY),
  ).toThrow(/CHECK/);
  // So the address and the agentId are still free for a real reservation.
  insertDraft(lb("3"), pub("3"));
  freeze(lb("3"));
  expect(() => reserve(lb("3"), "42", BODY)).not.toThrow();
});

/** A distinct, well-formed body address per index, so reservations never collide on it. */
const bodyN = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

test("an agentId has one spelling at the database: canonical decimal, at most 78 digits", () => {
  insertDraft(lb("1"), pub("1"));
  freeze(lb("1"));
  reserve(lb("1"), "42", BODY);
  let n = 0;
  const reserveAs = (agent: string) => {
    n += 1;
    insertDraft(lb(`a${n}`), pub(`a${n}`));
    freeze(lb(`a${n}`));
    return () => reserve(lb(`a${n}`), agent, bodyN(n));
  };
  // '042' is agent 42 on chain but a different TEXT to the unique index: while '42' is live, it
  // would otherwise slip past as a second live body for the same identity.
  expect(reserveAs("042")).toThrow(/CHECK/);
  for (const bad of ["00", "", " 42", "42 ", "4a", "-1", "4.2", "1e3", "1".repeat(79)])
    expect(reserveAs(bad), JSON.stringify(bad)).toThrow(/CHECK/);
  // agentId 0 exists on real registries, and a uint256 is at most 78 digits long.
  for (const good of ["0", "7", "1".repeat(78)])
    expect(reserveAs(good), JSON.stringify(good)).not.toThrow();
});

test("numbers are stored as integers: a fractional value is refused, never kept as REAL", () => {
  const insert = (chainId: number, delay: number) =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES ('${lb("r")}', '${pub("r")}', ?, 'co_1', ?, ?, ?, ?)`,
      )
      .run(TENANT, chainId, FACTORY, TENANT, delay);
  expect(() => insert(5042002, 172800.5)).toThrow(/CHECK/);
  expect(() => insert(5042002.5, 172800)).toThrow(/CHECK/);
  insertDraft();
  freeze();
  expect(() =>
    db
      .prepare(
        `UPDATE legal_bodies SET agent_id = '42', identity_owner = ?, link_digest = ?, link_deadline = 1900000000.5,
           link_signature = '0x01', body_address = ?, binding_state = 'reserved' WHERE legal_body_id = '${lb("1")}'`,
      )
      .run(OWNER, H("b"), BODY),
  ).toThrow(/CHECK/);
  reserve();
  expect(() =>
    db
      .prepare(
        `UPDATE legal_bodies SET create_tx_hash = ?, deployed_at = 1800000000.5, binding_state = 'deployed' WHERE legal_body_id = '${lb("1")}'`,
      )
      .run(H("c")),
  ).toThrow(/CHECK/);
  deploy();
  expect(() =>
    db
      .prepare(
        `UPDATE legal_bodies SET binding_state = 'linked', pointer_seen_at = 1.5 WHERE legal_body_id = '${lb("1")}'`,
      )
      .run(),
  ).toThrow(/CHECK/);
  for (const col of ["next_binding_check_at", "binding_check_interval_ms"])
    expect(
      () =>
        db.prepare(`UPDATE legal_bodies SET ${col} = 1.5 WHERE legal_body_id = '${lb("1")}'`).run(),
      col,
    ).toThrow(/CHECK/);
  // Whole numbers, and NULL where a column allows it, are untouched.
  db.prepare(
    `UPDATE legal_bodies SET next_binding_check_at = 1800000000000, binding_check_interval_ms = 60000 WHERE legal_body_id = '${lb("1")}'`,
  ).run();
  db.prepare(
    `UPDATE legal_bodies SET next_binding_check_at = NULL, binding_check_interval_ms = NULL WHERE legal_body_id = '${lb("1")}'`,
  ).run();
});

test("a body is created only under a company of its own tenant", () => {
  addCompany("co_2", OWNER);
  const insert = (tenant: string) =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES ('${lb("c")}', '${pub("c")}', ?, 'co_2', 5042002, ?, ?, 172800)`,
      )
      .run(tenant, FACTORY, tenant);
  expect(() => insert(TENANT)).toThrow(/another tenant/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
  expect(() => insert(OWNER)).not.toThrow(); // the company's own tenant can
});

test("the transition matrix: exactly the legal edges move; every other pair, and NULL, is refused", () => {
  const LEGAL = new Set([
    "draft>reserved",
    "draft>abandoned",
    "reserved>deployed",
    "reserved>lapsed",
    "deployed>linked",
    "deployed>superseded",
    "linked>broken",
    "broken>linked",
    "broken>superseded",
    "superseded>linked",
  ]);
  const moved: string[] = [];
  for (const from of STATES) {
    for (const to of STATES) {
      // Each pair on a fresh row, walked legally into `from`; the move sets every column the
      // target's CHECKs need (see NEEDS), so a refusal can only be the transition rule's.
      const d = bodyIn(from);
      const pair = `${from}>${to}`;
      if (from === to) {
        // Keeping the state is not a transition: the rule lets it through.
        expect(moveTo(d, to).changes, pair).toBe(1);
      } else if (LEGAL.has(pair)) {
        expect(moveTo(d, to).changes, pair).toBe(1);
        moved.push(pair);
      } else {
        expect(() => moveTo(d, to), pair).toThrow(/illegal binding_state transition/);
      }
      expect(stateOf(d), pair).toBe(LEGAL.has(pair) ? to : from);
      d.close();
    }
    // A NULL target is refused from every state, plainly and through OR REPLACE.
    for (const verb of ["UPDATE", "UPDATE OR REPLACE"]) {
      const d = bodyIn(from);
      expect(() => moveTo(d, null, verb), `${from}>NULL (${verb})`).toThrow(
        /illegal binding_state transition/,
      );
      expect(stateOf(d), `${from}>NULL (${verb})`).toBe(from);
      d.close();
    }
  }
  expect(moved.sort()).toEqual([...LEGAL].sort());
});

test("an event id is always positive: zero and negative ids are refused, and appends keep working", () => {
  insertDraft();
  // The premise: SQLite shows a BEFORE INSERT trigger an auto-generated id as a placeholder that
  // is not a real id (-1 today), and the no-replace trigger looks that value up. A stored id of -1
  // would therefore make every ordinary append look like an INSERT over an existing event.
  db.exec(`CREATE TEMP TABLE seen_ids (id INTEGER);
    CREATE TEMP TRIGGER log_new_id BEFORE INSERT ON legal_body_events
    BEGIN INSERT INTO seen_ids VALUES (NEW.id); END;`);
  const append = (id = lb("1")) =>
    db
      .prepare(
        "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES (?, 'note', 'system')",
      )
      .run(id);
  append();
  expect((db.prepare("SELECT id FROM seen_ids").get() as { id: number }).id).toBeLessThanOrEqual(0);
  for (const id of [-1, 0])
    expect(
      () =>
        db
          .prepare(
            `INSERT INTO legal_body_events (id, legal_body_id, kind, actor) VALUES (?, '${lb("1")}', 'note', 'operator:x')`,
          )
          .run(id),
      String(id),
    ).toThrow(/CHECK/);
  // Ordinary appends keep working, for this body and for a new body's first event.
  expect(append().changes).toBe(1);
  insertDraft(lb("2"), pub("2"));
  expect(append(lb("2")).changes).toBe(1);
  // REPLACE over an existing id is still refused.
  expect(() =>
    db
      .prepare(
        `REPLACE INTO legal_body_events (id, legal_body_id, kind, actor) VALUES (1, '${lb("1")}', 'note', 'operator:x')`,
      )
      .run(),
  ).toThrow(/append-only/);
  expect(db.prepare("SELECT MIN(id) AS lo, COUNT(*) AS n FROM legal_body_events").get()).toEqual({
    lo: 1,
    n: 3,
  });
});

test("an agentId is TEXT with no hidden bytes: a BLOB or an embedded NUL cannot spell agent 42 again", () => {
  // length() stops at the first NUL, and GLOB and substr read a BLOB as text, while the unique
  // index compares full bytes and storage class: each of these was a second live row for 42.
  insertDraft(lb("1"), pub("1"));
  freeze(lb("1"));
  reserve(lb("1"), "42", BODY);
  let n = 0;
  for (const [label, agentSql] of [
    ["BLOB '42'", "X'3432'"],
    ["BLOB '042'", "X'303432'"],
    ["'42' + NUL + 'x'", "'42' || char(0) || 'x'"],
    ["'0' + NUL + '42'", "'0' || char(0) || '42'"],
  ]) {
    n += 1;
    insertDraft(lb(`x${n}`), pub(`x${n}`));
    freeze(lb(`x${n}`));
    expect(
      () =>
        db
          .prepare(
            `UPDATE legal_bodies SET agent_id = ${agentSql}, identity_owner = ?, link_digest = ?,
               link_deadline = 1900000000, link_signature = '0x01', body_address = ?,
               binding_state = 'reserved' WHERE legal_body_id = ?`,
          )
          .run(OWNER, H("b"), bodyN(n), lb(`x${n}`)),
      label,
    ).toThrow(/CHECK/);
  }
  expect(
    db
      .prepare(
        "SELECT legal_body_id, agent_id FROM legal_bodies WHERE binding_state IN ('reserved','deployed','linked')",
      )
      .all(),
  ).toEqual([{ legal_body_id: lb("1"), agent_id: "42" }]);
});

test("the agreement version is an integer", () => {
  insertDraft();
  for (const v of [1.5, "v1"])
    expect(
      () =>
        db
          .prepare(
            `UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = ? WHERE legal_body_id = '${lb("1")}'`,
          )
          .run(H("a"), v),
      String(v),
    ).toThrow(/CHECK/);
  freeze();
  expect(
    db
      .prepare(
        "SELECT oa_manifest_version AS v, typeof(oa_manifest_version) AS t FROM legal_bodies",
      )
      .get(),
  ).toEqual({ v: 1, t: "integer" });
});

test("a legal body id is never NULL", () => {
  // SQLite lets a non-INTEGER PRIMARY KEY hold NULL (a legacy behaviour), unless it says NOT NULL.
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES (NULL, '${pub("n")}', ?, 'co_1', 5042002, ?, ?, 172800)`,
      )
      .run(TENANT, FACTORY, TENANT),
  ).toThrow(/NOT NULL/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
});

test("one body address per chain, whatever its casing, and only a well-formed 0x address fits", () => {
  insertDraft(lb("1"), pub("1"));
  freeze(lb("1"));
  reserve(lb("1"), "42", BODY); // recorded in its checksummed form
  let n = 0;
  const reserveAs = (bodySql: string) => {
    n += 1;
    insertDraft(lb(`b${n}`), pub(`b${n}`));
    freeze(lb(`b${n}`));
    return () =>
      db
        .prepare(
          `UPDATE legal_bodies SET agent_id = ?, identity_owner = ?, link_digest = ?,
             link_deadline = 1900000000, link_signature = '0x01', body_address = ${bodySql},
             binding_state = 'reserved' WHERE legal_body_id = ?`,
        )
        .run(String(100 + n), OWNER, H("b"), lb(`b${n}`));
  };
  // The same address in lower or upper case is the same address.
  for (const variant of [BODY.toLowerCase(), `0x${BODY.slice(2).toUpperCase()}`])
    expect(reserveAs(`'${variant}'`), variant).toThrow(
      "UNIQUE constraint failed: index 'idx_legal_bodies_body'",
    );
  // Anything but 0x and exactly 40 hex digits, as TEXT with no hidden bytes, is refused. A NUL
  // would otherwise hide a second spelling of the recorded address from length() and GLOB.
  for (const [label, bodySql] of [
    ["41 characters", `'${BODY.slice(0, 41)}'`],
    ["43 characters", `'${BODY}0'`],
    ["no 0x prefix", `'00${BODY.slice(2)}'`],
    ["0X prefix", `'0X${BODY.slice(2)}'`],
    ["a non-hex digit", `'${BODY.slice(0, 41)}g'`],
    ["a BLOB", `CAST('${OTHER_BODY}' AS BLOB)`],
    ["the recorded address, then a NUL and more", `'${BODY}' || char(0) || 'x'`],
    ["the recorded address, then a NUL", `'${BODY}' || char(0)`],
  ] as const)
    expect(reserveAs(bodySql), label).toThrow(/CHECK/);
  expect(
    db.prepare("SELECT legal_body_id FROM legal_bodies WHERE body_address IS NOT NULL").all(),
  ).toEqual([{ legal_body_id: lb("1") }]);
});

test("each unique index names itself in its own way, which the repository's mapping relies on", () => {
  for (const [id, publicId] of [
    [lb("1"), pub("1")],
    [lb("2"), pub("2")],
    [lb("3"), pub("3")],
  ]) {
    insertDraft(id, publicId);
    freeze(id);
  }
  reserve(lb("1"), "42", BODY);
  // A column index is named by its columns; an expression index only by its name.
  expect(() => reserve(lb("2"), "42", OTHER_BODY)).toThrow(
    "UNIQUE constraint failed: legal_bodies.chain_id, legal_bodies.agent_id",
  );
  expect(() => reserve(lb("3"), "43", BODY)).toThrow(
    "UNIQUE constraint failed: index 'idx_legal_bodies_body'",
  );
});

test("a body that has events stays in place: no conflict-resolving write removes or replaces it", () => {
  // The holder is a linked body with its history, as the repository writes every body: together
  // with its `created` event. Each write below would have to remove the holder to succeed.
  const reserveSet = (agent: string, body: string) =>
    `agent_id = '${agent}', identity_owner = '${OWNER}', link_digest = '${H("b")}',
     link_deadline = 1900000000, link_signature = '0x01', body_address = '${body}',
     binding_state = 'reserved'`;
  const holder = lb("holder");
  const mover = lb("mover");
  const setUp = () => {
    const d = freshDb();
    frozenDraftIn(d, holder);
    d.prepare(`UPDATE legal_bodies SET ${reserveSet("42", BODY)} WHERE legal_body_id = ?`).run(
      holder,
    );
    d.prepare(
      `UPDATE legal_bodies SET ${DEPLOY_SET}, binding_state = 'deployed' WHERE legal_body_id = ?`,
    ).run(holder);
    d.prepare(
      "UPDATE legal_bodies SET binding_state = 'linked', pointer_seen_at = 1800000100 WHERE legal_body_id = ?",
    ).run(holder);
    frozenDraftIn(d, mover);
    return d;
  };
  const holderRowid = (d: Database.Database) =>
    (
      d.prepare("SELECT rowid AS r FROM legal_bodies WHERE legal_body_id = ?").get(holder) as {
        r: number;
      }
    ).r;
  const writes: readonly (readonly [string, RegExp, (d: Database.Database) => unknown])[] = [
    [
      "a reservation of the agentId it holds",
      /FOREIGN KEY/,
      (d) =>
        d
          .prepare(
            `UPDATE OR REPLACE legal_bodies SET ${reserveSet("42", OTHER_BODY)} WHERE legal_body_id = ?`,
          )
          .run(mover),
    ],
    [
      "a reservation of its body address",
      /FOREIGN KEY/,
      (d) =>
        d
          .prepare(
            `UPDATE OR REPLACE legal_bodies SET ${reserveSet("43", BODY)} WHERE legal_body_id = ?`,
          )
          .run(mover),
    ],
    [
      "a move onto its rowid",
      /write-once/,
      (d) =>
        d
          .prepare("UPDATE OR REPLACE legal_bodies SET rowid = ? WHERE legal_body_id = ?")
          .run(holderRowid(d), mover),
    ],
    [
      "a new row that names its rowid",
      /born draft and never replaced/,
      (d) =>
        d
          .prepare(
            `INSERT OR REPLACE INTO legal_bodies (rowid, legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
             VALUES (?, ?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
          )
          .run(holderRowid(d), lb("new"), pub("new"), TENANT, FACTORY, TENANT),
    ],
    [
      "a new row that names its id",
      /born draft and never replaced/,
      (d) =>
        d
          .prepare(
            `REPLACE INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
             VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
          )
          .run(holder, pub("new"), TENANT, FACTORY, TENANT),
    ],
  ];
  for (const [label, refusal, write] of writes) {
    const d = setUp();
    const before = {
      bodies: d.prepare("SELECT rowid, * FROM legal_bodies ORDER BY rowid").all(),
      events: d.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
    };
    expect(() => write(d), label).toThrow(refusal);
    expect(
      {
        bodies: d.prepare("SELECT rowid, * FROM legal_bodies ORDER BY rowid").all(),
        events: d.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
      },
      label,
    ).toEqual(before);
    d.close();
  }
  // The same holds for a re-link: a broken body is not linked again over the body that now
  // holds its agentId live.
  const d = setUp();
  d.prepare("UPDATE legal_bodies SET binding_state = 'broken' WHERE legal_body_id = ?").run(holder);
  d.prepare(`UPDATE legal_bodies SET ${reserveSet("42", OTHER_BODY)} WHERE legal_body_id = ?`).run(
    mover,
  );
  expect(() =>
    d
      .prepare(
        "UPDATE OR REPLACE legal_bodies SET binding_state = 'linked', pointer_seen_at = 1800000200 WHERE legal_body_id = ?",
      )
      .run(holder),
  ).toThrow(/FOREIGN KEY/);
  expect(
    d.prepare("SELECT legal_body_id, binding_state FROM legal_bodies ORDER BY rowid").all(),
  ).toEqual([
    { legal_body_id: holder, binding_state: "broken" },
    { legal_body_id: mover, binding_state: "reserved" },
  ]);
  d.close();
});

test("a draft can be closed: abandoned is reached only from draft, and nothing leaves it", () => {
  for (const frozen of [false, true]) {
    const d = freshDb();
    d.prepare(
      `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
       VALUES ('${lb("1")}', '${pub("1")}', ?, 'co_1', 5042002, ?, ?, 172800)`,
    ).run(TENANT, FACTORY, TENANT);
    if (frozen)
      d.prepare(
        `UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = 1 WHERE legal_body_id = '${lb("1")}'`,
      ).run(H("a"));
    expect(moveTo(d, "abandoned").changes, `frozen: ${frozen}`).toBe(1);
    for (const to of STATES.filter((s) => s !== "abandoned"))
      expect(() => moveTo(d, to), `abandoned>${to}`).toThrow(/illegal binding_state transition/);
    expect(stateOf(d)).toBe("abandoned");
    d.close();
  }
});

test("an abandoned row holds no link fields, like a draft", () => {
  insertDraft();
  freeze();
  // Not on the way in...
  expect(() =>
    db
      .prepare(
        `UPDATE legal_bodies SET binding_state = 'abandoned', ${LINK_SET} WHERE legal_body_id = '${lb("1")}'`,
      )
      .run(),
  ).toThrow(/CHECK/);
  expect(moveTo(db, "abandoned").changes).toBe(1);
  // ...and not afterwards: it can never squat on an agentId or a body address.
  for (const [col, v] of [
    ["body_address", BODY],
    ["agent_id", "42"],
    ["identity_owner", OWNER],
    ["link_digest", H("b")],
    ["link_deadline", 1900000000],
    ["link_signature", "0x01"],
  ] as const)
    expect(
      () =>
        db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = '${lb("1")}'`).run(v),
      col,
    ).toThrow(/CHECK/);
  insertDraft(lb("2"), pub("2"));
  freeze(lb("2"));
  expect(() => reserve(lb("2"), "42", BODY)).not.toThrow();
});

// ── The shape of every stored value, enforced by the table itself ──

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const UINT256_MAX = (2n ** 256n - 1n).toString();

let shapeSeq = 0;
/** A new frozen draft under its own id. */
function frozenDraft(): string {
  shapeSeq += 1;
  const id = lb(`s${shapeSeq}`);
  insertDraft(id, pub(`s${shapeSeq}`));
  freeze(id);
  return id;
}
/**
 * A raw reservation of `id`. Every column holds a well-formed value (an agentId and a body address
 * of its own, so no two reservations collide) unless `over` replaces it with an SQL expression.
 */
function reserveRaw(id: string, over: Record<string, string> = {}) {
  shapeSeq += 1;
  const columns: Record<string, string> = {
    agent_id: `'${5000 + shapeSeq}'`,
    identity_owner: `'${OWNER}'`,
    link_digest: `'${H("b")}'`,
    link_deadline: "1900000000",
    link_signature: "'0x01'",
    body_address: `'${bodyN(5000 + shapeSeq)}'`,
    ...over,
  };
  const set = Object.entries(columns)
    .map(([column, sql]) => `${column} = ${sql}`)
    .join(", ");
  return db
    .prepare(`UPDATE legal_bodies SET ${set}, binding_state = 'reserved' WHERE legal_body_id = ?`)
    .run(id);
}
const setRaw = (id: string, set: string) =>
  db.prepare(`UPDATE legal_bodies SET ${set} WHERE legal_body_id = ?`).run(id);

/** Spellings that are not a lower-case 32-byte hash, as SQL expressions. */
const BAD_HASHES: readonly (readonly [string, string])[] = [
  ["empty", "''"],
  ["not hex", "'not hex'"],
  ["upper-case hex", `'0x${"A".repeat(64)}'`],
  ["one upper-case digit", `'0x${"a".repeat(63)}A'`],
  ["63 digits", `'0x${"a".repeat(63)}'`],
  ["65 digits", `'0x${"a".repeat(65)}'`],
  ["no 0x prefix", `'${"a".repeat(66)}'`],
  ["0X prefix", `'0X${"a".repeat(64)}'`],
  ["a non-hex digit", `'0x${"a".repeat(63)}g'`],
  ["a BLOB", `CAST('${H("a")}' AS BLOB)`],
  ["an integer", "7"],
  ["a NUL inside", `'0x${"a".repeat(63)}' || char(0)`],
  ["a NUL and more after it", `'${H("a")}' || char(0) || 'x'`],
];
/** Spellings that are not a 0x address, as SQL expressions. */
const BAD_ADDRESSES: readonly (readonly [string, string])[] = [
  ["empty", "''"],
  ["a word", "'junk'"],
  ["39 digits", `'0x${"a".repeat(39)}'`],
  ["41 digits", `'0x${"a".repeat(41)}'`],
  ["no 0x prefix", `'${"a".repeat(42)}'`],
  ["0X prefix", `'0X${"a".repeat(40)}'`],
  ["a non-hex digit", `'0x${"a".repeat(39)}g'`],
  ["a BLOB", `CAST('0x${"a".repeat(40)}' AS BLOB)`],
  ["a NUL inside", `'0x${"a".repeat(39)}' || char(0)`],
  ["a NUL and more after it", `'0x${"a".repeat(40)}' || char(0) || 'x'`],
];

test("the agreement is a lower-case 32-byte hash with a version of at least 1, set together", () => {
  insertDraft();
  const id = lb("1");
  for (const [label, hashSql] of BAD_HASHES)
    expect(
      () => setRaw(id, `oa_manifest_hash = ${hashSql}, oa_manifest_version = 1`),
      `hash: ${label}`,
    ).toThrow(/CHECK/);
  for (const [label, set] of [
    ["a version with no hash", "oa_manifest_version = 1"],
    ["a hash with no version", `oa_manifest_hash = '${H("a")}'`],
    ["a hash with a NULL version", `oa_manifest_hash = '${H("a")}', oa_manifest_version = NULL`],
    ["version 0", `oa_manifest_hash = '${H("a")}', oa_manifest_version = 0`],
    ["version -1", `oa_manifest_hash = '${H("a")}', oa_manifest_version = -1`],
  ] as const)
    expect(() => setRaw(id, set), label).toThrow(/CHECK/);
  expect(
    db.prepare("SELECT oa_manifest_hash AS h, oa_manifest_version AS v FROM legal_bodies").get(),
  ).toEqual({ h: null, v: null });
  // Version 1 is the first version, and it is accepted.
  expect(setRaw(id, `oa_manifest_hash = '${H("a")}', oa_manifest_version = 1`).changes).toBe(1);
});

test("the link digest and the deploy hash are lower-case 32-byte hashes; the signature is lower-case hex bytes", () => {
  for (const [label, sql] of BAD_HASHES)
    expect(() => reserveRaw(frozenDraft(), { link_digest: sql }), `digest: ${label}`).toThrow(
      /CHECK/,
    );
  for (const [label, sql] of [
    ["empty", "''"],
    ["0x and no byte", "'0x'"],
    ["half a byte", "'0x1'"],
    ["a byte and a half", "'0x012'"],
    ["no 0x prefix", "'0101'"],
    ["0X prefix", "'0X01'"],
    ["upper-case hex", "'0xAB'"],
    ["a non-hex digit", "'0x0g'"],
    ["a BLOB", "CAST('0x01' AS BLOB)"],
    ["an integer", "1"],
    ["a NUL inside", "'0x01' || char(0) || '1'"],
    ["a NUL and more after it", "'0x01' || char(0) || 'ff'"],
  ] as const)
    expect(() => reserveRaw(frozenDraft(), { link_signature: sql }), `signature: ${label}`).toThrow(
      /CHECK/,
    );
  // A signature has no fixed length: one byte, 65 bytes and a long contract signature all fit.
  for (const bytes of [1, 65, 700])
    expect(
      reserveRaw(frozenDraft(), { link_signature: `'0x${"ab".repeat(bytes)}'` }).changes,
      `${bytes} bytes`,
    ).toBe(1);
  // The deploy hash is checked from its first submission, while the row is still reserved.
  const id = frozenDraft();
  reserveRaw(id);
  for (const [label, sql] of BAD_HASHES)
    expect(() => setRaw(id, `create_tx_hash = ${sql}`), `deploy hash: ${label}`).toThrow(/CHECK/);
  expect(setRaw(id, `create_tx_hash = '${H("1")}'`).changes).toBe(1);
});

test("the tenant, the factory and the identity owner are 0x addresses", () => {
  let n = 0;
  for (const [label, sql] of BAD_ADDRESSES) {
    n += 1;
    // The tenant: under a company of that same tenant, so only the shape can refuse it.
    db.exec(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
       VALUES ('co_bad${n}', ${sql}, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
    );
    expect(
      () =>
        db
          .prepare(
            `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
             VALUES (?, ?, ${sql}, 'co_bad${n}', 5042002, ?, ${sql}, 172800)`,
          )
          .run(lb(`t${n}`), pub(`t${n}`), FACTORY),
      `tenant: ${label}`,
    ).toThrow(/CHECK/);
    expect(
      () =>
        db
          .prepare(
            `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
             VALUES (?, ?, ?, 'co_1', 5042002, ${sql}, ?, 172800)`,
          )
          .run(lb(`f${n}`), pub(`f${n}`), TENANT, TENANT),
      `factory: ${label}`,
    ).toThrow(/CHECK/);
    expect(
      () => reserveRaw(frozenDraft(), { identity_owner: sql }),
      `identity owner: ${label}`,
    ).toThrow(/CHECK/);
  }
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM legal_bodies WHERE agent_id IS NOT NULL").get(),
  ).toEqual({ n: 0 });
});

test("a legal body id is lb_ and 36 characters, a public id 36 characters, and a chain id is positive", () => {
  const insert = (idSql: string, publicIdSql: string, chainId: number) =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES (${idSql}, ${publicIdSql}, ?, 'co_1', ?, ?, ?, 172800)`,
      )
      .run(TENANT, chainId, FACTORY, TENANT);
  const goodId = `'${lb("g")}'`;
  const goodPublicId = `'${pub("g")}'`;
  for (const [label, sql] of [
    ["empty", "''"],
    ["too short", "'lb_1'"],
    ["35 characters after the prefix", `'lb_${"a".repeat(35)}'`],
    ["37 characters after the prefix", `'lb_${"a".repeat(37)}'`],
    ["another prefix", `'xx_${"a".repeat(36)}'`],
    ["an upper-case prefix", `'LB_${"a".repeat(36)}'`],
    ["a BLOB", `CAST('${lb("b")}' AS BLOB)`],
    ["an integer", "7"],
    ["a NUL inside", `'lb_${"a".repeat(35)}' || char(0)`],
    ["a NUL and more after it", `'${lb("n")}' || char(0) || 'x'`],
  ] as const)
    expect(() => insert(sql, goodPublicId, 5042002), `id: ${label}`).toThrow(/CHECK/);
  for (const [label, sql] of [
    ["empty", "''"],
    ["35 characters", `'${"a".repeat(35)}'`],
    ["37 characters", `'${"a".repeat(37)}'`],
    ["a BLOB", `CAST('${pub("b")}' AS BLOB)`],
    ["an integer", "7"],
    ["a NUL inside", `'${"a".repeat(35)}' || char(0)`],
    ["a NUL and more after it", `'${pub("n")}' || char(0) || 'x'`],
  ] as const)
    expect(() => insert(goodId, sql, 5042002), `public id: ${label}`).toThrow(/CHECK/);
  for (const chainId of [0, -1])
    expect(() => insert(goodId, goodPublicId, chainId)).toThrow(/CHECK/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
  expect(insert(goodId, goodPublicId, 1).changes).toBe(1);
});

test("a body address is never the zero address, nor the factory that would create it", () => {
  for (const [label, address] of [
    ["the zero address", ZERO_ADDRESS],
    ["the factory", FACTORY],
    ["the factory in lower case", FACTORY.toLowerCase()],
    ["the factory in upper case", `0x${FACTORY.slice(2).toUpperCase()}`],
  ] as const)
    expect(() => reserveRaw(frozenDraft(), { body_address: `'${address}'` }), label).toThrow(
      /CHECK/,
    );
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM legal_bodies WHERE body_address IS NOT NULL").get(),
  ).toEqual({ n: 0 });
});

test("a time in seconds is between 1 and 99999999999, so a value in milliseconds is refused", () => {
  const BAD_SECONDS = [0, -5, 100_000_000_000, 1_900_000_000_000];
  for (const v of BAD_SECONDS)
    expect(
      () => reserveRaw(frozenDraft(), { link_deadline: String(v) }),
      `link_deadline ${v}`,
    ).toThrow(/CHECK/);
  const id = frozenDraft();
  reserveRaw(id, { link_deadline: "99999999999" }); // the upper bound fits
  for (const v of BAD_SECONDS)
    expect(
      () =>
        setRaw(id, `create_tx_hash = '${H("c")}', deployed_at = ${v}, binding_state = 'deployed'`),
      `deployed_at ${v}`,
    ).toThrow(/CHECK/);
  setRaw(id, `create_tx_hash = '${H("c")}', deployed_at = 1, binding_state = 'deployed'`); // and the lower
  for (const v of BAD_SECONDS)
    expect(
      () => setRaw(id, `binding_state = 'linked', pointer_seen_at = ${v}`),
      `pointer_seen_at ${v}`,
    ).toThrow(/CHECK/);
  expect(setRaw(id, "binding_state = 'linked', pointer_seen_at = 1800000100").changes).toBe(1);
});

test("the check schedule is a time in milliseconds and a positive interval, set together", () => {
  const id = frozenDraft();
  reserveRaw(id);
  for (const set of [
    "next_binding_check_at = -1, binding_check_interval_ms = 60000",
    "next_binding_check_at = 1000, binding_check_interval_ms = 0",
    "next_binding_check_at = 1000, binding_check_interval_ms = -5",
    "next_binding_check_at = 1000",
    "binding_check_interval_ms = 60000",
    "next_binding_check_at = 1000, binding_check_interval_ms = NULL",
    "next_binding_check_at = NULL, binding_check_interval_ms = 60000",
  ])
    expect(() => setRaw(id, set), set).toThrow(/CHECK/);
  for (const set of [
    "next_binding_check_at = 0, binding_check_interval_ms = 1",
    "next_binding_check_at = 1800000000000, binding_check_interval_ms = 60000",
    "next_binding_check_at = NULL, binding_check_interval_ms = NULL",
  ])
    expect(setRaw(id, set).changes, set).toBe(1);
});

test("the deploy time is set only by the deploy: no row before it, or closed without it, holds one", () => {
  // A row that held one early could never be deployed: the deploy facts are write-once.
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay, deployed_at)
         VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800, 1800000000)`,
      )
      .run(lb("d"), pub("d"), TENANT, FACTORY, TENANT),
  ).toThrow(/CHECK/);
  const draft = frozenDraft();
  expect(() => setRaw(draft, "deployed_at = 1800000000"), "draft").toThrow(/CHECK/);
  const reserved = frozenDraft();
  reserveRaw(reserved);
  expect(() => setRaw(reserved, "deployed_at = 1800000000"), "reserved").toThrow(/CHECK/);
  expect(
    () => setRaw(reserved, "binding_state = 'lapsed', deployed_at = 1800000000"),
    "lapsed",
  ).toThrow(/CHECK/);
  expect(
    () => setRaw(draft, "binding_state = 'abandoned', deployed_at = 1800000000"),
    "abandoned",
  ).toThrow(/CHECK/);
  // The reserved row is untouched, and deploys normally.
  expect(
    setRaw(
      reserved,
      `create_tx_hash = '${H("c")}', deployed_at = 1800000000, binding_state = 'deployed'`,
    ).changes,
  ).toBe(1);
});

test("nothing legitimate is refused: the whole lifecycle, with agentId 0, the largest agentId and version 1", () => {
  const state = (id: string) =>
    (
      db.prepare("SELECT binding_state FROM legal_bodies WHERE legal_body_id = ?").get(id) as {
        binding_state: string;
      }
    ).binding_state;
  // Agent 0: reserved, deployed, linked, broken, linked again, broken, set aside, linked again.
  const zero = frozenDraft(); // frozen at version 1
  reserveRaw(zero, { agent_id: "'0'", body_address: `'${BODY}'` });
  setRaw(zero, `create_tx_hash = '${H("1")}'`);
  setRaw(zero, `create_tx_hash = '${H("2")}'`);
  setRaw(
    zero,
    `create_tx_hash = '${H("2")}', deployed_at = 1800000000, binding_state = 'deployed'`,
  );
  setRaw(zero, "next_binding_check_at = 1800000000000, binding_check_interval_ms = 60000");
  setRaw(zero, "binding_state = 'linked', pointer_seen_at = 1800000100");
  setRaw(zero, "binding_state = 'broken'");
  setRaw(zero, "binding_state = 'linked', pointer_seen_at = 1800000200");
  setRaw(zero, "binding_state = 'broken'");
  setRaw(zero, "binding_state = 'superseded'");
  setRaw(zero, "binding_state = 'linked', pointer_seen_at = 1800000300");
  setRaw(zero, "next_binding_check_at = NULL, binding_check_interval_ms = NULL");
  expect(state(zero)).toBe("linked");
  // The largest uint256: reserved, then lapsed.
  const max = frozenDraft();
  reserveRaw(max, { agent_id: `'${UINT256_MAX}'`, body_address: `'${OTHER_BODY}'` });
  setRaw(max, "binding_state = 'lapsed'");
  expect(state(max)).toBe("lapsed");
  // A deployed body that is never linked, then set aside; and a draft that is closed.
  const aside = frozenDraft();
  reserveRaw(aside);
  setRaw(aside, `create_tx_hash = '${H("3")}', deployed_at = 1, binding_state = 'deployed'`);
  setRaw(aside, "binding_state = 'superseded'");
  expect(state(aside)).toBe("superseded");
  const closed = frozenDraft();
  setRaw(closed, "binding_state = 'abandoned'");
  expect(state(closed)).toBe("abandoned");
  expect(
    db
      .prepare("SELECT agent_id, oa_manifest_version FROM legal_bodies WHERE legal_body_id = ?")
      .get(max),
  ).toEqual({ agent_id: UINT256_MAX, oa_manifest_version: 1 });
});

// ── The rowid and the creation time are part of a row's identity ──

test("the rowid is pinned: no INSERT names an existing one, no UPDATE moves it, and none is zero or negative", () => {
  // Two plain rows: what refuses each write below is a guard on legal_bodies itself.
  insertDraft(lb("1"), pub("1"));
  insertDraft(lb("2"), pub("2"));
  const rowidOf = (id: string) =>
    (
      db.prepare("SELECT rowid AS r FROM legal_bodies WHERE legal_body_id = ?").get(id) as {
        r: number;
      }
    ).r;
  const first = rowidOf(lb("1"));
  const snapshot = () => db.prepare("SELECT rowid, * FROM legal_bodies ORDER BY rowid").all();
  const before = snapshot();
  const insertAt = (verb: string, column: string, rowid: number, label: string) =>
    db
      .prepare(
        `${verb} INTO legal_bodies (${column}, legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES (?, ?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
      )
      .run(rowid, lb(label), pub(label), TENANT, FACTORY, TENANT);
  // A new row, with ids of its own, that names the rowid of an existing one.
  for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"])
    for (const column of ["rowid", "_rowid_", "oid"])
      expect(() => insertAt(verb, column, first, "n"), `${verb} (${column})`).toThrow(
        /born draft and never replaced/,
      );
  // An existing row moved onto another row's rowid, or to a free one.
  for (const verb of ["UPDATE", "UPDATE OR REPLACE", "UPDATE OR IGNORE"])
    for (const target of [first, 777])
      expect(
        () =>
          db
            .prepare(`${verb} legal_bodies SET rowid = ? WHERE legal_body_id = ?`)
            .run(target, lb("2")),
        `${verb} -> ${target}`,
      ).toThrow(/write-once/);
  for (const rowid of [0, -1])
    expect(() => insertAt("INSERT", "rowid", rowid, "z"), `rowid ${rowid}`).toThrow(/CHECK/);
  expect(snapshot()).toEqual(before);
  // The premise of the insert guard: SQLite shows a BEFORE INSERT trigger an automatic rowid as a
  // placeholder that is not a real rowid (-1 today), and no stored rowid is ever zero or negative.
  db.exec(`CREATE TEMP TABLE seen_rowids (r INTEGER);
    CREATE TEMP TRIGGER log_new_rowid BEFORE INSERT ON legal_bodies
    BEGIN INSERT INTO seen_rowids VALUES (NEW.rowid); END;`);
  // An ordinary insert is untouched, and takes the next rowid.
  insertDraft(lb("3"), pub("3"));
  expect(rowidOf(lb("3"))).toBe(rowidOf(lb("2")) + 1);
  expect((db.prepare("SELECT r FROM seen_rowids").get() as { r: number }).r).toBeLessThanOrEqual(0);
});

test("created_at is write-once: it dates the record and orders the listings", () => {
  insertDraft();
  const createdAt = () =>
    (db.prepare("SELECT created_at AS c FROM legal_bodies").get() as { c: string }).c;
  const before = createdAt();
  for (const verb of ["UPDATE", "UPDATE OR REPLACE"])
    for (const v of ["1999-01-01 00:00:00", null])
      expect(
        () => db.prepare(`${verb} legal_bodies SET created_at = ?`).run(v),
        `${verb} -> ${v}`,
      ).toThrow(/write-once/);
  expect(createdAt()).toBe(before);
  // updated_at is the column that moves.
  expect(
    db.prepare("UPDATE legal_bodies SET updated_at = '2030-01-01 00:00:00'").run().changes,
  ).toBe(1);
});

test("an explicit event id is at most the next one, so event ids stay in order", () => {
  insertDraft();
  const append = () =>
    db
      .prepare(
        "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES (?, 'note', 'system')",
      )
      .run(lb("1"));
  const insertAt = (idSql: string, verb = "INSERT") =>
    db
      .prepare(
        `${verb} INTO legal_body_events (id, legal_body_id, kind, actor) VALUES (${idSql}, ?, 'note', 'operator:x')`,
      )
      .run(lb("1"));
  // On an empty log, and again once it holds rows.
  for (const round of ["empty log", "three events"]) {
    for (const idSql of [
      "9223372036854775807",
      "(SELECT IFNULL(MAX(id), 0) + 1000 FROM legal_body_events)",
      "(SELECT IFNULL(MAX(id), 0) + 2 FROM legal_body_events)",
    ])
      for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"])
        expect(() => insertAt(idSql, verb), `${round}: ${verb} ${idSql}`).toThrow(
          /ids are assigned in order/,
        );
    // The natural next id may be written out, and ordinary appends follow it.
    expect(insertAt("(SELECT IFNULL(MAX(id), 0) + 1 FROM legal_body_events)").changes).toBe(1);
    expect(append().changes).toBe(1);
    expect(append().changes).toBe(1);
  }
  // An INSERT over an existing id is still refused.
  expect(() => insertAt("1", "REPLACE")).toThrow(/append-only/);
  expect(db.prepare("SELECT group_concat(id) AS ids FROM legal_body_events").get()).toEqual({
    ids: "1,2,3,4,5,6",
  });
});
