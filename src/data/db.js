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
    // Additive knowledge-layer tables (issue #21): learnings (TR-10) and the
    // model-call ledger (TR-23). Both tenant-bound. Learnings are upserted by
    // fixed id (re-seeding is a no-op, never a delete); model_calls only ever
    // grows, recording the call record the router returns.
    name: '003_knowledge_tables',
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
];

/** Open the database at dbPath, applying any migrations not yet recorded. */
export function openDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  // DatabaseSync cannot create the parent directory itself, and the default
  // ./data/ is gitignored, so a clean checkout has to have it made on boot.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
