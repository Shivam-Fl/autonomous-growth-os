// SQLite bootstrap (node:sqlite DatabaseSync): migrations run on open, every
// table carries tenant_id and UTC ISO-8601 timestamps, and raw_events plus
// audit_events get storage-level append-only triggers so no UPDATE or DELETE
// can touch them even from raw SQL. Postgres replaces this module later
// behind the same repository interfaces.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = './data/app.db';

export function utcNow() {
  return new Date().toISOString();
}

const MIGRATIONS = [
  {
    name: '001_foundation_tables',
    sql: `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  capability_id TEXT,
  details TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  consumer TEXT NOT NULL,
  effect TEXT,
  claimed_at TEXT NOT NULL,
  recorded_at TEXT,
  PRIMARY KEY (tenant_id, event_id, consumer)
);

CREATE TABLE IF NOT EXISTS derived_metrics (
  tenant_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value_micros INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, metric, dimension)
);

CREATE TABLE IF NOT EXISTS saga_runs (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  step INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);`,
  },
  {
    name: '002_append_only_triggers',
    sql: `
CREATE TRIGGER IF NOT EXISTS raw_events_append_only_update
BEFORE UPDATE ON raw_events
BEGIN
  SELECT RAISE(ABORT, 'raw_events is append-only: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS raw_events_append_only_delete
BEFORE DELETE ON raw_events
BEGIN
  SELECT RAISE(ABORT, 'raw_events is append-only: DELETE denied');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE denied');
END;`,
  },
  {
    name: '003_journal_tables',
    sql: `
CREATE TABLE IF NOT EXISTS state_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kpis TEXT NOT NULL,
  budgets TEXT NOT NULL,
  funnel TEXT NOT NULL,
  health TEXT NOT NULL,
  memories TEXT NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  state_snapshot_id TEXT NOT NULL,
  action_class TEXT NOT NULL,
  selected_action TEXT NOT NULL,
  record TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  expected_evaluation_at TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (tenant_id, decision_id)
);

CREATE TRIGGER IF NOT EXISTS state_snapshots_immutable_update
BEFORE UPDATE ON state_snapshots
BEGIN
  SELECT RAISE(ABORT, 'state_snapshots are immutable: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS state_snapshots_immutable_delete
BEFORE DELETE ON state_snapshots
BEGIN
  SELECT RAISE(ABORT, 'state_snapshots are immutable: DELETE denied');
END;

CREATE TRIGGER IF NOT EXISTS decisions_append_only_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS decisions_append_only_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only: DELETE denied');
END;

CREATE INDEX IF NOT EXISTS decisions_status_idx
ON decisions (tenant_id, status, decided_at);`,
  },
  {
    // Additive knowledge-layer tables (issue #21): learnings (TR-10) and the
    // model-call ledger (TR-23). Both tenant-bound. Learnings are upserted by
    // fixed id (re-seeding is a no-op, never a delete); model_calls only ever
    // grows, recording the call record the router returns.
    // Renumbered from 003 to 004 at the merge with the journal slice, which
    // took 003 for its state_snapshots/decisions tables: the migrations table
    // records by name and every statement below is CREATE ... IF NOT EXISTS,
    // so a database that already recorded 003_knowledge_tables (pre-merge
    // boots) re-runs identically, and fresh boots apply 003 then 004 in order.
    name: '004_knowledge_tables',
    sql: `
CREATE TABLE IF NOT EXISTS learnings (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  claim TEXT NOT NULL,
  scope TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  effect_metric TEXT,
  effect_estimate REAL,
  effect_low REAL,
  effect_high REAL,
  confidence REAL NOT NULL,
  applicability REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  stale_after TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS learnings_tenant_status_idx
  ON learnings (tenant_id, status, updated_at, id);

CREATE TABLE IF NOT EXISTS model_calls (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT,
  tool_catalog_version TEXT,
  task_type TEXT,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  usefulness REAL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);`,
  },
  {
    // Opportunity and experiment working state (issue #22, spec sections
    // 26/27). opportunities and experiments rows are deliberately MUTABLE
    // working state — scores, states, evaluation columns and data_through are
    // all rewritten in place — so there is deliberately NO immutability
    // trigger on either table; only experiment_evaluations is append-only,
    // with triggers matching the decisions pattern (RAISE ABORT).
    name: '005_opportunity_experiment_tables',
    sql: `
CREATE TABLE IF NOT EXISTS opportunities (
  tenant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  record TEXT NOT NULL,
  score REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, opportunity_id)
);

CREATE INDEX IF NOT EXISTS opportunities_rank_idx
  ON opportunities (tenant_id, score DESC, opportunity_id);

CREATE TABLE IF NOT EXISTS experiments (
  tenant_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  record TEXT NOT NULL,
  state TEXT NOT NULL,
  evaluation_result TEXT,
  evaluation_reason TEXT,
  evaluated_at TEXT,
  data_through TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, experiment_id)
);

CREATE INDEX IF NOT EXISTS experiments_tenant_created_idx
  ON experiments (tenant_id, created_at, experiment_id);

CREATE TABLE IF NOT EXISTS experiment_evaluations (
  tenant_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  counts TEXT NOT NULL,
  PRIMARY KEY (tenant_id, experiment_id, evaluated_at)
);

CREATE TRIGGER IF NOT EXISTS experiment_evaluations_append_only_update
BEFORE UPDATE ON experiment_evaluations
BEGIN
  SELECT RAISE(ABORT, 'experiment_evaluations is append-only: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS experiment_evaluations_append_only_delete
BEFORE DELETE ON experiment_evaluations
BEGIN
  SELECT RAISE(ABORT, 'experiment_evaluations is append-only: DELETE denied');
END;`,
  },
  {
    // The safety slice's write path (issue #20, TR-3/4/5/19/21/24): approvals
    // and their capabilities, the receipts a provider write produces, the kill
    // switches a guardian freeze arms, the incidents it records and the trust
    // ledger a posture is derived from.
    //
    // Immutability is per table and deliberate, not uniform. approvals is
    // MUTABLE working state — deciding one rewrites its status in place — so
    // there is no trigger. capabilities and guardian_incidents are append-only
    // on BOTH verbs, matching the decisions pattern. action_records is
    // append-only on UPDATE ONLY, and that asymmetry is the one delete the
    // repository exposes anywhere: scripts/seed.js --reset-approvals must be
    // able to clear a seeded receipt so the next run of the same QA script can
    // approve the same approval again, and a DELETE trigger would make that
    // throw. The audit trail for a purged receipt is its audit_events row, not
    // the receipt row.
    name: '006_safety_slice_tables',
    sql: `
CREATE TABLE IF NOT EXISTS approvals (
  tenant_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  action_class TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  constraints TEXT NOT NULL,
  impact TEXT NOT NULL,
  downside TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, approval_id)
);

CREATE INDEX IF NOT EXISTS approvals_status_idx
  ON approvals (tenant_id, status, expires_at, approval_id);

CREATE TABLE IF NOT EXISTS capabilities (
  tenant_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, capability_id)
);

CREATE INDEX IF NOT EXISTS capabilities_expiry_idx
  ON capabilities (tenant_id, expires_at);

CREATE TRIGGER IF NOT EXISTS capabilities_append_only_update
BEFORE UPDATE ON capabilities
BEGIN
  SELECT RAISE(ABORT, 'capabilities are append-only: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS capabilities_append_only_delete
BEFORE DELETE ON capabilities
BEGIN
  SELECT RAISE(ABORT, 'capabilities are append-only: DELETE denied');
END;

-- UNIQUE (tenant_id, nonce) is both the executor's durable dedupe store and
-- the kernel's replay port: one nonce, one provider write, one receipt. No
-- UNIQUE on capabilities.nonce on purpose — a re-approval after a reset
-- legitimately issues a SECOND capability for the same approval nonce, and a
-- unique index there would abort the second insert on exactly the path the
-- reset exists to make re-runnable.
CREATE TABLE IF NOT EXISTS action_records (
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  approval_id TEXT,
  capability_id TEXT,
  nonce TEXT NOT NULL,
  action_class TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  requested TEXT NOT NULL,
  reported TEXT NOT NULL,
  reconciliation TEXT NOT NULL,
  drift TEXT NOT NULL,
  maturity_at_decision REAL,
  band_at_decision TEXT,
  actor TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, nonce)
);

CREATE INDEX IF NOT EXISTS action_records_approval_idx
  ON action_records (tenant_id, approval_id);

CREATE INDEX IF NOT EXISTS action_records_executed_idx
  ON action_records (tenant_id, executed_at, receipt_id);

CREATE TRIGGER IF NOT EXISTS action_records_append_only_update
BEFORE UPDATE ON action_records
BEGIN
  SELECT RAISE(ABORT, 'action_records is append-only: UPDATE denied');
END;

-- Mutable, no trigger: a freeze is raised and cleared, not rewritten. scope_id
-- is NOT NULL on purpose — a NULL in a rowid-composite primary key never
-- matches an ON CONFLICT target, so a re-trigger would append a second active
-- row that no re-enable could clear.
CREATE TABLE IF NOT EXISTS kill_switches (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT,
  frozen_by TEXT,
  reason TEXT,
  re_enabled_at TEXT,
  re_enabled_by TEXT,
  PRIMARY KEY (tenant_id, scope, scope_id)
);

CREATE TABLE IF NOT EXISTS guardian_incidents (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  detected_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, incident_id)
);

CREATE INDEX IF NOT EXISTS guardian_incidents_recent_idx
  ON guardian_incidents (tenant_id, frozen_at, incident_id);

CREATE TRIGGER IF NOT EXISTS guardian_incidents_append_only_update
BEFORE UPDATE ON guardian_incidents
BEGIN
  SELECT RAISE(ABORT, 'guardian_incidents is append-only: UPDATE denied');
END;

CREATE TRIGGER IF NOT EXISTS guardian_incidents_append_only_delete
BEFORE DELETE ON guardian_incidents
BEGIN
  SELECT RAISE(ABORT, 'guardian_incidents is append-only: DELETE denied');
END;

-- Mutable upsert, one row per class: a single stored row per action class is
-- what makes the displayed posture and the enforced posture the same claim.
CREATE TABLE IF NOT EXISTS trust_ledger (
  tenant_id TEXT NOT NULL,
  action_class TEXT NOT NULL,
  evaluated INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  needless INTEGER NOT NULL,
  downside_penalties INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, action_class)
);`,
  },
];

/** Open the database at dbPath, applying any migrations not yet recorded. */
export function openDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  // DatabaseSync cannot create the parent directory itself, and the default
  // ./data/ is gitignored, so a clean checkout has to have it made on boot.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL so the running server and the seed process can write the same file
  // without one blocking the other for the length of a migration. busy_timeout
  // is PER-CONNECTION, so it belongs here and nowhere else: the server and
  // scripts/seed.js both reach the database through this one function, and a
  // PRAGMA written in a route would give the server the setting and the QA
  // reset nothing.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((row) => row.name),
  );
  const insert = db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) {
      continue;
    }
    db.exec(migration.sql);
    insert.run(migration.name, utcNow());
  }
  return db;
}
