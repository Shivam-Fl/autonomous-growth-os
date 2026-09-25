// Repositories own all SQL: SQLite implementations of the persistence
// interfaces the domain and workflows depend on. Every query binds tenant_id,
// so isolation holds on every path; raw_events and audit_events expose no
// update or delete surface (append-only, TR-20), and replayRawToDerived()
// rebuilds derived_metrics from raw_events alone.

import { utcNow } from './db.js';

function parseJson(text, fallback) {
  if (text === null || text === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function createTenantRepository(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO tenants (id, name, currency, created_at) VALUES (?, ?, ?, ?)');
  const selectOne = db.prepare('SELECT id, name, currency, created_at FROM tenants WHERE id = ?');
  const selectAll = db.prepare('SELECT id, name, currency, created_at FROM tenants ORDER BY created_at, id');

  return {
    /** Idempotent by fixed id: re-creating an existing tenant is a no-op. */
    create({ id, name, currency }) {
      insert.run(id, name, currency, utcNow());
      return this.get(id);
    },

    get(id) {
      return selectOne.get(id) ?? null;
    },

    list() {
      return selectAll.all();
    },
  };
}

function toEnvelope(row) {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    tenant_id: row.tenant_id,
    schema_version: row.schema_version,
    payload: parseJson(row.payload, {}),
  };
}

function createRawEventRepository(db) {
  // Append-only: the only writes are inserts. There is no update or delete
  // function here, and the storage triggers in db.js block raw SQL too.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO raw_events (tenant_id, event_id, event_type, occurred_at, schema_version, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectForTenant = db.prepare(
    'SELECT event_id, event_type, occurred_at, tenant_id, schema_version, payload FROM raw_events WHERE tenant_id = ? ORDER BY occurred_at, event_id LIMIT ?',
  );
  const countForTenant = db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE tenant_id = ?');

  return {
    /**
     * Append an envelope; duplicate (tenant_id, event_id) deliveries are
     * no-ops. Returns { appended } so callers can tell new from duplicate.
     */
    append(envelope) {
      const result = insert.run(
        envelope.tenant_id,
        envelope.event_id,
        envelope.event_type,
        envelope.occurred_at,
        envelope.schema_version,
        JSON.stringify(envelope.payload ?? {}),
        utcNow(),
      );
      return { appended: result.changes > 0 };
    },

    list(tenantId, { limit = 200 } = {}) {
      return selectForTenant.all(tenantId, limit).map(toEnvelope);
    },

    count(tenantId) {
      return countForTenant.get(tenantId).n;
    },
  };
}

function createAuditEventRepository(db) {
  const insert = db.prepare(
    'INSERT INTO audit_events (tenant_id, actor, action, subject, capability_id, details, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectForTenant = db.prepare(
    'SELECT id, tenant_id, actor, action, subject, capability_id, details, occurred_at FROM audit_events WHERE tenant_id = ? ORDER BY id LIMIT ?',
  );

  return {
    /** Append-only by design: no update or delete exists for audit rows. */
    append({ tenant_id: tenantId, actor, action, subject = null, capability_id: capabilityId = null, details = {}, occurred_at: occurredAt }) {
      const result = insert.run(tenantId, actor, action, subject, capabilityId, JSON.stringify(details), occurredAt ?? utcNow());
      return { appended: result.changes > 0, id: Number(result.lastInsertRowid) };
    },

    list(tenantId, { limit = 200 } = {}) {
      return selectForTenant.all(tenantId, limit).map((row) => ({
        ...row,
        details: parseJson(row.details, {}),
      }));
    },
  };
}

function createIdempotencyRepository(db) {
  const claimInsert = db.prepare(
    'INSERT OR IGNORE INTO idempotency_keys (tenant_id, event_id, consumer, claimed_at) VALUES (?, ?, ?, ?)',
  );
  const recordUpdate = db.prepare(
    'UPDATE idempotency_keys SET effect = ?, recorded_at = ? WHERE tenant_id = ? AND event_id = ? AND consumer = ?',
  );
  const releaseDelete = db.prepare(
    'DELETE FROM idempotency_keys WHERE tenant_id = ? AND event_id = ? AND consumer = ?',
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, event_id, consumer, effect, claimed_at, recorded_at FROM idempotency_keys WHERE tenant_id = ? AND event_id = ? AND consumer = ?',
  );

  return {
    /** Try to own a delivery: true iff this call created the claim. */
    claim(tenantId, eventId, consumer) {
      const result = claimInsert.run(tenantId, eventId, consumer, utcNow());
      return result.changes > 0;
    },

    /** Record the receipt once the effect has succeeded. */
    record(tenantId, eventId, consumer, effect = null) {
      recordUpdate.run(JSON.stringify(effect), utcNow(), tenantId, eventId, consumer);
    },

    /** Drop a claim so a failed effect can be delivered again. */
    release(tenantId, eventId, consumer) {
      releaseDelete.run(tenantId, eventId, consumer);
    },

    get(tenantId, eventId, consumer) {
      const row = selectOne.get(tenantId, eventId, consumer);
      if (!row) {
        return null;
      }
      return { ...row, effect: parseJson(row.effect, null) };
    },
  };
}

function createDerivedRepository(db) {
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO derived_metrics (tenant_id, metric, dimension, value_micros, computed_at) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteForTenant = db.prepare('DELETE FROM derived_metrics WHERE tenant_id = ?');
  const selectForTenant = db.prepare(
    'SELECT tenant_id, metric, dimension, value_micros, computed_at FROM derived_metrics WHERE tenant_id = ? ORDER BY metric, dimension',
  );

  return {
    upsert(tenantId, metric, dimension, valueMicros, computedAt = utcNow()) {
      upsert.run(tenantId, metric, dimension, valueMicros, computedAt);
    },

    /** Derived rows are rebuildable from raw, so clearing them is safe. */
    clear(tenantId) {
      deleteForTenant.run(tenantId);
    },

    list(tenantId) {
      return selectForTenant.all(tenantId);
    },
  };
}

function createSagaRepository(db) {
  const insert = db.prepare(
    'INSERT INTO saga_runs (tenant_id, run_id, name, payload, status, step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const update = db.prepare(
    'UPDATE saga_runs SET status = ?, step = ?, updated_at = ? WHERE tenant_id = ? AND run_id = ?',
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, run_id, name, payload, status, step, created_at, updated_at FROM saga_runs WHERE tenant_id = ? AND run_id = ?',
  );
  const selectRunning = db.prepare(
    "SELECT tenant_id, run_id, name, payload, status, step, created_at, updated_at FROM saga_runs WHERE tenant_id = ? AND status IN ('running', 'compensating') ORDER BY created_at, run_id",
  );
  // Operator-level enumeration for resume-all: returns tenant ids only, never
  // another tenant's rows. The per-tenant rows come from listRunning(tenantId).
  const selectRunningTenantIds = db.prepare(
    "SELECT DISTINCT tenant_id FROM saga_runs WHERE status IN ('running', 'compensating') ORDER BY tenant_id",
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    return { ...row, payload: parseJson(row.payload, {}) };
  }

  return {
    create({ tenant_id: tenantId, run_id: runId, name, payload }) {
      const now = utcNow();
      insert.run(tenantId, runId, name, JSON.stringify(payload ?? {}), 'running', 0, now, now);
      return this.get(tenantId, runId);
    },

    save(run) {
      update.run(run.status, run.step, utcNow(), run.tenant_id, run.run_id);
    },

    get(tenantId, runId) {
      return shape(selectOne.get(tenantId, runId));
    },

    /** Tenant-scoped: lists only the given tenant's running saga runs. */
    listRunning(tenantId) {
      return selectRunning.all(tenantId).map(shape);
    },

    /** Operator-level: tenant ids that currently have running sagas. */
    listRunningTenantIds() {
      return selectRunningTenantIds.all().map((row) => row.tenant_id);
    },
  };
}

export function createRepositories(db) {
  return {
    tenants: createTenantRepository(db),
    rawEvents: createRawEventRepository(db),
    auditEvents: createAuditEventRepository(db),
    idempotency: createIdempotencyRepository(db),
    derived: createDerivedRepository(db),
    sagas: createSagaRepository(db),
  };
}

/**
 * Rebuild derived_metrics for one tenant from raw_events alone, so derived
 * values are always reproducible (TR-20). Existing rows for the tenant are
 * recomputed in place; other tenants are untouched.
 */
export function replayRawToDerived(db, tenantId) {
  const repositories = createRepositories(db);
  const spendRows = db.prepare(
    "SELECT payload FROM raw_events WHERE tenant_id = ? AND event_type = 'spend.observed' ORDER BY occurred_at, event_id",
  ).all(tenantId);

  const spendByCampaign = new Map();
  for (const row of spendRows) {
    const payload = parseJson(row.payload, {});
    const campaign = payload.campaign ?? 'unattributed';
    const amount = Number(payload.amount_micros);
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`raw spend event for ${tenantId} has a non-integer amount_micros`);
    }
    spendByCampaign.set(campaign, (spendByCampaign.get(campaign) ?? 0) + amount);
  }

  repositories.derived.clear(tenantId);
  const computedAt = utcNow();
  for (const [campaign, micros] of [...spendByCampaign.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    repositories.derived.upsert(tenantId, 'spend_micros', campaign, micros, computedAt);
  }

  return { tenant_id: tenantId, metrics: spendByCampaign.size, value_micros: [...spendByCampaign.values()].reduce((a, b) => a + b, 0) };
}
