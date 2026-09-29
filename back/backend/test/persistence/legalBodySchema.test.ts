import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";

const TENANT = "0x172B7952b0F711b8B372410E81d51Dcba7D4BB02";
const OWNER = "0x26b2f179Db35D912C141A71de547d21bF8665D0E";
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456";
const BODY = "0x079cE31a43867Bcb4DBF80764c1da9c32515BfD4";
const H = (c: string) => `0x${c.repeat(64)}`;

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

function insertDraft(id = "lb_1", pub = "pub-1") {
  db.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
     VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
  ).run(id, pub, TENANT, FACTORY, TENANT);
}
const freeze = (id = "lb_1") =>
  db
    .prepare(
      "UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = 1 WHERE legal_body_id = ?",
    )
    .run(H("a"), id);
const reserve = (id = "lb_1", agent = "42", body = BODY) =>
  db
    .prepare(
      `UPDATE legal_bodies SET agent_id = ?, identity_owner = ?, link_digest = ?, link_deadline = 1900000000,
         link_signature = '0x01', body_address = ?, binding_state = 'reserved' WHERE legal_body_id = ?`,
    )
    .run(agent, OWNER, H("b"), body, id);
const deploy = (id = "lb_1") =>
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
         VALUES ('lb_x', 'p', ?, 'co_1', 5042002, ?, ?, 172800)`,
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
        .run(`lb_${d}`, `p${d}`, TENANT, FACTORY, TENANT, d),
    ).toThrow(/CHECK/);
});

test("a company that does not exist is refused (foreign key)", () => {
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES ('lb_y', 'py', ?, 'co_missing', 5042002, ?, ?, 172800)`,
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
      .prepare("UPDATE legal_bodies SET binding_state = 'deployed' WHERE legal_body_id = 'lb_1'")
      .run(),
  ).toThrow(/CHECK/);
  expect(() => deploy()).not.toThrow();
});

test("illegal state transitions are refused by the database", () => {
  insertDraft();
  freeze();
  const to = (s: string) =>
    db.prepare("UPDATE legal_bodies SET binding_state = ? WHERE legal_body_id = 'lb_1'").run(s);
  expect(() => to("deployed")).toThrow(/illegal binding_state transition|CHECK/);
  reserve();
  expect(() => to("linked")).toThrow(/illegal binding_state transition/);
  expect(() => to("draft")).toThrow(/illegal binding_state transition/);
  deploy();
  expect(() => to("reserved")).toThrow(/illegal binding_state transition/);
  db.prepare(
    "UPDATE legal_bodies SET binding_state = 'linked', pointer_seen_at = 1800000100 WHERE legal_body_id = 'lb_1'",
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
      () => db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = 'lb_1'`).run(v),
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
    ["legal_body_id", "lb_other"],
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
      () => db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = 'lb_1'`).run(v),
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
  insertDraft("lb_1", "p1");
  insertDraft("lb_2", "p2");
  freeze("lb_1");
  freeze("lb_2");
  reserve("lb_1", "42", BODY);
  expect(() => reserve("lb_2", "42", OWNER)).toThrow(/UNIQUE/);
  db.prepare("UPDATE legal_bodies SET binding_state = 'lapsed' WHERE legal_body_id = 'lb_1'").run();
  expect(() => reserve("lb_2", "42", OWNER)).not.toThrow();
});

test("one row per deployed body address per chain", () => {
  insertDraft("lb_1", "p1");
  insertDraft("lb_2", "p2");
  freeze("lb_1");
  freeze("lb_2");
  reserve("lb_1", "42", BODY);
  db.prepare("UPDATE legal_bodies SET binding_state = 'lapsed' WHERE legal_body_id = 'lb_1'").run();
  expect(() => reserve("lb_2", "43", BODY)).toThrow(/UNIQUE/);
});

test("the event log is append-only and bound to an existing legal body", () => {
  insertDraft();
  const ins = db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES (?, 'created', 'system')",
  );
  ins.run("lb_1");
  expect(() => ins.run("lb_missing")).toThrow(/FOREIGN KEY/);
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

type State = "draft" | "reserved" | "deployed" | "linked" | "broken" | "lapsed" | "superseded";
const STATES: readonly State[] = [
  "draft",
  "reserved",
  "deployed",
  "linked",
  "broken",
  "lapsed",
  "superseded",
];

// The columns each state's CHECKs require, as SET clauses holding exactly the values `bodyIn`
// writes: a move that sets them again changes no write-once field, so when such a move is
// refused, it is the transition rule that refused it, never a missing column.
const LINK_SET = `agent_id = '42', identity_owner = '${OWNER}', link_digest = '${H("b")}',
  link_deadline = 1900000000, link_signature = '0x01', body_address = '${BODY}'`;
const DEPLOY_SET = `create_tx_hash = '${H("c")}', deployed_at = 1800000000`;
const NEEDS: Record<State, string> = {
  draft: "",
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
};

/** Move `lb_1` to `to` (NULL included), setting what the target's CHECKs need in one UPDATE. */
const moveTo = (d: Database.Database, to: State | null, verb = "UPDATE") =>
  d
    .prepare(
      `${verb} legal_bodies SET binding_state = ?${to && NEEDS[to] ? `, ${NEEDS[to]}` : ""}
        WHERE legal_body_id = 'lb_1'`,
    )
    .run(to);
const stateOf = (d: Database.Database) =>
  (
    d.prepare("SELECT binding_state FROM legal_bodies WHERE legal_body_id = 'lb_1'").get() as {
      binding_state: State;
    }
  ).binding_state;

/** A fresh database holding `lb_1` (with its `created` event), walked legally into `state`. */
function bodyIn(state: State): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  d.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
     VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Acme LLC"]', 'existing', 'existing')`,
  ).run(TENANT);
  d.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
     VALUES ('lb_1', 'pub-1', ?, 'co_1', 5042002, ?, ?, 172800)`,
  ).run(TENANT, FACTORY, TENANT);
  d.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('lb_1', 'created', 'system')",
  ).run();
  d.prepare(
    "UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = 1 WHERE legal_body_id = 'lb_1'",
  ).run(H("a"));
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
const OTHER_BODY = "0x01392702dA9487a1E3B49BeC9c6Fb1DD676fF6F1";

test("REPLACE INTO cannot rewrite an existing body: rows are never replaced", () => {
  // Without an INSERT guard, REPLACE deletes the old row (firing no delete trigger) and inserts
  // the new one, and none of the UPDATE guards ever sees it.
  addCompany("co_2", OWNER);
  insertDraft();
  db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('lb_1', 'created', 'system')",
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
         VALUES ('lb_1', 'pub-1', ?, 'co_2', 5042002, ?, ?, 172800, ?, 9, '99', ?, ?, 1, '0x09', ?, ?, 1, 'linked', 1)`,
      )
      .run(OWNER, FACTORY, OWNER, H("f"), TENANT, H("e"), OTHER_BODY, H("d")),
  ).toThrow(/born draft and never replaced/);
  // Not even a well-formed draft may land on an existing primary key or public id.
  for (const [id, pub] of [
    ["lb_1", "pub-new"],
    ["lb_new", "pub-1"],
  ])
    expect(
      () =>
        db
          .prepare(
            `REPLACE INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
             VALUES (?, ?, ?, 'co_1', 5042002, ?, ?, 172800)`,
          )
          .run(id, pub, TENANT, FACTORY, TENANT),
      `${id} / ${pub}`,
    ).toThrow(/born draft and never replaced/);
  expect(db.prepare("SELECT * FROM legal_bodies").all()).toEqual(before);
});

test("a row is born draft: an INSERT straight into any other state, or NULL, is refused", () => {
  for (const s of ["reserved", "deployed", "linked", "broken", "lapsed", "superseded", null])
    expect(
      () =>
        db
          .prepare(
            `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian,
               amendment_delay, oa_manifest_hash, oa_manifest_version, agent_id, identity_owner, link_digest,
               link_deadline, link_signature, body_address, create_tx_hash, deployed_at, binding_state,
               pointer_seen_at)
             VALUES ('lb_9', 'p9', ?, 'co_1', 5042002, ?, ?, 172800, ?, 1, '42', ?, ?, 1900000000, '0x01', ?, ?,
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
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('lb_1', 'created', 'system')",
  ).run();
  const before = db.prepare("SELECT * FROM legal_body_events").all() as { id: number }[];
  expect(() =>
    db
      .prepare(
        `REPLACE INTO legal_body_events (id, legal_body_id, kind, actor, detail)
         VALUES (?, 'lb_1', 'note', 'operator:x', 'rewritten')`,
      )
      .run(before[0]?.id),
  ).toThrow(/append-only/);
  expect(db.prepare("SELECT * FROM legal_body_events").all()).toEqual(before);
  // Appending is untouched.
  db.prepare(
    "INSERT INTO legal_body_events (legal_body_id, kind, actor) VALUES ('lb_1', 'note', 'system')",
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
        "UPDATE legal_bodies SET create_tx_hash = ? WHERE legal_body_id = 'lb_1' AND binding_state = 'reserved'",
      )
      .run(h);
  expect(submit(H("1")).changes).toBe(1);
  expect(submit(H("2")).changes).toBe(1); // re-sent with a new nonce, so a new hash
  deploy(); // the transaction that landed: create_tx_hash = H("c")
  for (const v of [H("9"), null])
    expect(
      () =>
        db
          .prepare("UPDATE legal_bodies SET create_tx_hash = ? WHERE legal_body_id = 'lb_1'")
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
      () => db.prepare(`UPDATE legal_bodies SET ${col} = ? WHERE legal_body_id = 'lb_1'`).run(v),
      col,
    ).toThrow(/CHECK/);
  // Nor can a draft be born holding one.
  expect(() =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian,
           amendment_delay, body_address)
         VALUES ('lb_2', 'p2', ?, 'co_1', 5042002, ?, ?, 172800, ?)`,
      )
      .run(TENANT, FACTORY, TENANT, BODY),
  ).toThrow(/CHECK/);
  // So the address and the agentId are still free for a real reservation.
  insertDraft("lb_3", "p3");
  freeze("lb_3");
  expect(() => reserve("lb_3", "42", BODY)).not.toThrow();
});

/** A distinct, well-formed body address per index, so reservations never collide on it. */
const bodyN = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

test("an agentId has one spelling at the database: canonical decimal, at most 78 digits", () => {
  insertDraft("lb_1", "p1");
  freeze("lb_1");
  reserve("lb_1", "42", BODY);
  let n = 0;
  const reserveAs = (agent: string) => {
    n += 1;
    insertDraft(`lb_a${n}`, `pa${n}`);
    freeze(`lb_a${n}`);
    return () => reserve(`lb_a${n}`, agent, bodyN(n));
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
         VALUES ('lb_r', 'pr', ?, 'co_1', ?, ?, ?, ?)`,
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
           link_signature = '0x01', body_address = ?, binding_state = 'reserved' WHERE legal_body_id = 'lb_1'`,
      )
      .run(OWNER, H("b"), BODY),
  ).toThrow(/CHECK/);
  reserve();
  expect(() =>
    db
      .prepare(
        "UPDATE legal_bodies SET create_tx_hash = ?, deployed_at = 1800000000.5, binding_state = 'deployed' WHERE legal_body_id = 'lb_1'",
      )
      .run(H("c")),
  ).toThrow(/CHECK/);
  deploy();
  expect(() =>
    db
      .prepare(
        "UPDATE legal_bodies SET binding_state = 'linked', pointer_seen_at = 1.5 WHERE legal_body_id = 'lb_1'",
      )
      .run(),
  ).toThrow(/CHECK/);
  for (const col of ["next_binding_check_at", "binding_check_interval_ms"])
    expect(
      () => db.prepare(`UPDATE legal_bodies SET ${col} = 1.5 WHERE legal_body_id = 'lb_1'`).run(),
      col,
    ).toThrow(/CHECK/);
  // Whole numbers, and NULL where a column allows it, are untouched.
  db.prepare(
    "UPDATE legal_bodies SET next_binding_check_at = 1800000000000, binding_check_interval_ms = 60000 WHERE legal_body_id = 'lb_1'",
  ).run();
  db.prepare(
    "UPDATE legal_bodies SET next_binding_check_at = NULL, binding_check_interval_ms = NULL WHERE legal_body_id = 'lb_1'",
  ).run();
});

test("a body is created only under a company of its own tenant", () => {
  addCompany("co_2", OWNER);
  const insert = (tenant: string) =>
    db
      .prepare(
        `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory, guardian, amendment_delay)
         VALUES ('lb_c', 'pc', ?, 'co_2', 5042002, ?, ?, 172800)`,
      )
      .run(tenant, FACTORY, tenant);
  expect(() => insert(TENANT)).toThrow(/another tenant/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
  expect(() => insert(OWNER)).not.toThrow(); // the company's own tenant can
});

test("the transition matrix: exactly the legal edges move; every other pair, and NULL, is refused", () => {
  const LEGAL = new Set([
    "draft>reserved",
    "reserved>deployed",
    "reserved>lapsed",
    "deployed>linked",
    "deployed>superseded",
    "linked>broken",
    "broken>linked",
    "broken>superseded",
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

test("an event id is always positive, so one bad row can never block every later append", () => {
  insertDraft();
  // The premise: SQLite shows a BEFORE INSERT trigger an auto-generated id as a placeholder that
  // is not a real id (-1 today), and the no-replace trigger looks that value up. A stored id of -1
  // would therefore make every ordinary append look like an INSERT over an existing event.
  db.exec(`CREATE TEMP TABLE seen_ids (id INTEGER);
    CREATE TEMP TRIGGER log_new_id BEFORE INSERT ON legal_body_events
    BEGIN INSERT INTO seen_ids VALUES (NEW.id); END;`);
  const append = (id = "lb_1") =>
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
            "INSERT INTO legal_body_events (id, legal_body_id, kind, actor) VALUES (?, 'lb_1', 'note', 'operator:x')",
          )
          .run(id),
      String(id),
    ).toThrow(/CHECK/);
  // Ordinary appends keep working, for this body and for a new body's first event.
  expect(append().changes).toBe(1);
  insertDraft("lb_2", "p2");
  expect(append("lb_2").changes).toBe(1);
  // REPLACE over an existing id is still refused.
  expect(() =>
    db
      .prepare(
        "REPLACE INTO legal_body_events (id, legal_body_id, kind, actor) VALUES (1, 'lb_1', 'note', 'operator:x')",
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
  insertDraft("lb_1", "p1");
  freeze("lb_1");
  reserve("lb_1", "42", BODY);
  let n = 0;
  for (const [label, agentSql] of [
    ["BLOB '42'", "X'3432'"],
    ["BLOB '042'", "X'303432'"],
    ["'42' + NUL + 'x'", "'42' || char(0) || 'x'"],
    ["'0' + NUL + '42'", "'0' || char(0) || '42'"],
  ]) {
    n += 1;
    insertDraft(`lb_x${n}`, `px${n}`);
    freeze(`lb_x${n}`);
    expect(
      () =>
        db
          .prepare(
            `UPDATE legal_bodies SET agent_id = ${agentSql}, identity_owner = ?, link_digest = ?,
               link_deadline = 1900000000, link_signature = '0x01', body_address = ?,
               binding_state = 'reserved' WHERE legal_body_id = ?`,
          )
          .run(OWNER, H("b"), bodyN(n), `lb_x${n}`),
      label,
    ).toThrow(/CHECK/);
  }
  expect(
    db
      .prepare(
        "SELECT legal_body_id, agent_id FROM legal_bodies WHERE binding_state IN ('reserved','deployed','linked')",
      )
      .all(),
  ).toEqual([{ legal_body_id: "lb_1", agent_id: "42" }]);
});

test("the agreement version is an integer", () => {
  insertDraft();
  for (const v of [1.5, "v1"])
    expect(
      () =>
        db
          .prepare(
            "UPDATE legal_bodies SET oa_manifest_hash = ?, oa_manifest_version = ? WHERE legal_body_id = 'lb_1'",
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
         VALUES (NULL, 'pn', ?, 'co_1', 5042002, ?, ?, 172800)`,
      )
      .run(TENANT, FACTORY, TENANT),
  ).toThrow(/NOT NULL/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get()).toEqual({ n: 0 });
});
