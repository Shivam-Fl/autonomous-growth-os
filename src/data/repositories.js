// Repositories own all SQL: SQLite implementations of the persistence
// interfaces the domain and workflows depend on. Every query binds tenant_id,
// so isolation holds on every path; raw_events and audit_events expose no
// update or delete surface (append-only, TR-20), decisions are append-only
// and state_snapshots immutable (TR-6, storage triggers in db.js), and
// replayRawToDerived() rebuilds derived_metrics from raw_events alone.

import { randomUUID } from 'node:crypto';
import { utcNow } from './db.js';
import { SCOPE_FIELDS } from '../memory/learnings.js';

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

    /**
     * Tenant-bound funnel read: envelopes whose event_type is one of `types`,
     * ordered deterministically. The types filter runs server-side so the
     * domain never loads the tenant's full event list for a funnel read.
     */
    listByTypes(tenantId, types, { limit = 10_000 } = {}) {
      const placeholders = types.map(() => '?').join(', ');
      const select = db.prepare(
        `SELECT event_id, event_type, occurred_at, tenant_id, schema_version, payload FROM raw_events WHERE tenant_id = ? AND event_type IN (${placeholders}) ORDER BY occurred_at, event_id LIMIT ?`,
      );
      return select.all(tenantId, ...types, limit).map(toEnvelope);
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

function createSnapshotRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO state_snapshots (tenant_id, snapshot_id, created_at, kpis, budgets, funnel, health, memories) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, snapshot_id, created_at, kpis, budgets, funnel, health, memories FROM state_snapshots WHERE tenant_id = ? AND snapshot_id = ?',
  );
  const selectAll = db.prepare(
    'SELECT tenant_id, snapshot_id, created_at, kpis, budgets, funnel, health, memories FROM state_snapshots WHERE tenant_id = ? ORDER BY created_at, snapshot_id',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    return {
      tenant_id: row.tenant_id,
      snapshot_id: row.snapshot_id,
      created_at: row.created_at,
      kpis: parseJson(row.kpis, {}),
      budgets: parseJson(row.budgets, []),
      funnel: parseJson(row.funnel, {}),
      health: parseJson(row.health, {}),
      memories: parseJson(row.memories, []),
    };
  }

  return {
    /**
     * Immutable by design (TR-6): the only write is this append. Re-creating
     * an existing snapshot_id is a no-op, so a retry that re-posts a body
     * never duplicates the row.
     */
    create({ tenant_id: tenantId, snapshot_id: snapshotId, kpis = {}, budgets = [], funnel = {}, health = {}, memories = [] }) {
      insert.run(tenantId, snapshotId, utcNow(), JSON.stringify(kpis), JSON.stringify(budgets), JSON.stringify(funnel), JSON.stringify(health), JSON.stringify(memories));
      return this.get(tenantId, snapshotId);
    },

    get(tenantId, snapshotId) {
      return shape(selectOne.get(tenantId, snapshotId));
    },

    list(tenantId) {
      return selectAll.all(tenantId).map(shape);
    },
  };
}

function createDecisionRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO decisions (tenant_id, decision_id, state_snapshot_id, action_class, selected_action, record, decided_at, expected_evaluation_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare(
    'SELECT decision_id, tenant_id, state_snapshot_id, action_class, selected_action, record, decided_at, expected_evaluation_at, status FROM decisions WHERE tenant_id = ? AND decision_id = ?',
  );
  const selectAll = db.prepare(
    'SELECT decision_id, tenant_id, state_snapshot_id, action_class, selected_action, record, decided_at, expected_evaluation_at, status FROM decisions WHERE tenant_id = ? ORDER BY decided_at, decision_id',
  );
  // Status/class filters for the journal table (deterministic decided_at,
  // decision_id order, ui.md: every table sorts deterministically).
  const selectFiltered = db.prepare(
    'SELECT decision_id, tenant_id, state_snapshot_id, action_class, selected_action, record, decided_at, expected_evaluation_at, status FROM decisions WHERE tenant_id = ? AND (? IS NULL OR action_class = ?) AND (? IS NULL OR status = ?) ORDER BY decided_at, decision_id',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    const record = parseJson(row.record, {});
    return {
      decision_id: row.decision_id,
      tenant_id: row.tenant_id,
      state_snapshot_id: row.state_snapshot_id,
      action_class: row.action_class,
      selected_action: row.selected_action,
      record,
      decided_at: row.decided_at,
      expected_evaluation_at: row.expected_evaluation_at,
      status: row.status,
      // Outcomes ride on the record itself; calibration counts read here.
      ...record,
    };
  }

  return {
    /**
     * Append-only: the only write is this insert. Idempotent on decision_id
     * (TR-5) — a re-posted body returns the existing row and reports
     * {created: false, ...it} so callers can tell new from duplicate.
     */
    create(input) {
      const result = insert.run(
        input.tenant_id,
        input.decision_id,
        input.state_snapshot_id,
        input.action_class,
        input.selected_action,
        JSON.stringify(input),
        input.decided_at,
        input.expected_evaluation_at,
        input.status,
      );
      const created = result.changes > 0;
      return { created, ...this.get(input.tenant_id, input.decision_id) };
    },

    get(tenantId, decisionId) {
      return shape(selectOne.get(tenantId, decisionId));
    },

    /**
     * Tenant-scoped rows in deterministic order, optionally filtered by
     * action class and status (the journal's two selects).
     */
    list(tenantId, { class: classFilter = null, status = null } = {}) {
      return selectFiltered.all(tenantId, classFilter, classFilter, status, status).map(shape);
    },

    /** Evaluated rows (the record carries an outcome) — live calibration's
     * precision and false-intervention denominators. */
    listEvaluated(tenantId) {
      return this.list(tenantId).filter((row) => row.record.evaluation !== undefined && row.record.evaluation !== null);
    },

    /** Rows awaiting maturity: no outcome written onto the record yet. */
    listAwaiting(tenantId) {
      return this.list(tenantId).filter((row) => row.record.evaluation === undefined || row.record.evaluation === null);
    },
  };
}

function createLearningRepository(db) {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO learnings
      (tenant_id, id, claim, scope, evidence_refs, evidence_type, effect_metric, effect_estimate, effect_low, effect_high,
       confidence, applicability, status, created_at, valid_from, stale_after, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(
    `SELECT tenant_id, id, claim, scope, evidence_refs, evidence_type, effect_metric, effect_estimate, effect_low, effect_high,
       confidence, applicability, status, created_at, valid_from, stale_after, updated_at
     FROM learnings WHERE tenant_id = ? AND id = ?`,
  );
  const selectAll = db.prepare(
    `SELECT tenant_id, id, claim, scope, evidence_refs, evidence_type, effect_metric, effect_estimate, effect_low, effect_high,
       confidence, applicability, status, created_at, valid_from, stale_after, updated_at
     FROM learnings WHERE tenant_id = ? ORDER BY updated_at, id LIMIT ? OFFSET ?`,
  );
  // Scope prefilter: a coarse SQL-level narrowing only. For every scope field
  // the context actually supplies, keep rows that match it or express no
  // opinion (OR IS NULL) — a row that names a field the context never supplies
  // survives this query and is cut by the structured scopeMatch gate in
  // src/memory/learnings.js, which always runs after. Keys come from the
  // fixed SCOPE_FIELDS whitelist; values are bound parameters.
  const selectForContextBase =
    `SELECT tenant_id, id, claim, scope, evidence_refs, evidence_type, effect_metric, effect_estimate, effect_low, effect_high,
       confidence, applicability, status, created_at, valid_from, stale_after, updated_at
     FROM learnings WHERE tenant_id = ? AND status = 'accepted'`;
  const selectForContextNoContext = db.prepare(`${selectForContextBase} ORDER BY updated_at, id`);
  const selectForContextPrefiltered = new Map();

  function scopePrefilterFields(context) {
    return Object.keys(context ?? {})
      .filter((key) => SCOPE_FIELDS.includes(key))
      .filter((key) => typeof context[key] === 'string' && context[key].length > 0);
  }

  function selectForContext(context) {
    const fields = scopePrefilterFields(context);
    if (fields.length === 0) {
      return selectForContextNoContext;
    }
    const cacheKey = fields.join('|');
    let statement = selectForContextPrefiltered.get(cacheKey);
    if (!statement) {
      const clauses = fields.map((key) => ` (json_extract(scope, '$.${key}') = ? OR json_extract(scope, '$.${key}') IS NULL)`);
      statement = db.prepare(`${selectForContextBase} AND${clauses.join(' AND ')} ORDER BY updated_at, id`);
      selectForContextPrefiltered.set(cacheKey, statement);
    }
    return statement;
  }
  const insertCall = db.prepare(
    `INSERT OR IGNORE INTO model_calls
      (tenant_id, id, provider, model, prompt_version, tool_catalog_version, task_type,
       tokens_in, tokens_out, latency_ms, cost_micros, usefulness, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectCalls = db.prepare(
    `SELECT tenant_id, id, provider, model, prompt_version, tool_catalog_version, task_type,
       tokens_in, tokens_out, latency_ms, cost_micros, usefulness, occurred_at
     FROM model_calls WHERE tenant_id = ? ORDER BY occurred_at, id LIMIT ?`,
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    const effect = row.effect_metric === null ? null : {
      metric: row.effect_metric,
      estimate: row.effect_estimate,
      interval: [row.effect_low, row.effect_high],
    };
    return {
      id: row.id,
      claim: row.claim,
      scope: parseJson(row.scope, {}),
      evidenceRefs: parseJson(row.evidence_refs, []),
      evidenceType: row.evidence_type,
      effect,
      confidence: row.confidence,
      applicability: row.applicability,
      status: row.status,
      createdAt: row.created_at,
      validFrom: row.valid_from,
      staleAfter: row.stale_after,
      updatedAt: row.updated_at,
      tenantId: row.tenant_id,
    };
  }

  return {
    /** Idempotent by fixed id (lrn_): re-writing a learning replaces the row
     * for that tenant only. Rejection is a status transition, never a delete,
     * so there is deliberately no delete function here. */
    upsert(tenantId, learning) {
      upsert.run(
        tenantId,
        learning.id,
        learning.claim,
        JSON.stringify(learning.scope ?? {}),
        JSON.stringify(learning.evidenceRefs ?? []),
        learning.evidenceType,
        learning.effect?.metric ?? null,
        learning.effect?.estimate ?? null,
        learning.effect?.interval?.[0] ?? null,
        learning.effect?.interval?.[1] ?? null,
        learning.confidence,
        learning.applicability,
        learning.status,
        learning.createdAt,
        learning.validFrom,
        learning.staleAfter,
        learning.updatedAt,
      );
      return this.get(tenantId, learning.id);
    },

    get(tenantId, id) {
      return shape(selectOne.get(tenantId, id));
    },

    list(tenantId, { offset = 0, limit = 200 } = {}) {
      return selectAll.all(tenantId, limit, offset).map(shape);
    },

    /** Accepted rows for the tenant, narrowed by the SQL scope prefilter;
     * the caller runs the full retrieval gate over them. */
    listForContext(tenantId, context = {}) {
      const fields = scopePrefilterFields(context);
      return selectForContext(context).all(tenantId, ...fields.map((key) => context[key])).map(shape);
    },
  };
}

function createCallLogRepository(db) {
  const insertCall = db.prepare(
    `INSERT OR IGNORE INTO model_calls
      (tenant_id, id, provider, model, prompt_version, tool_catalog_version, task_type,
       tokens_in, tokens_out, latency_ms, cost_micros, usefulness, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectCalls = db.prepare(
    `SELECT tenant_id, id, provider, model, prompt_version, tool_catalog_version, task_type,
       tokens_in, tokens_out, latency_ms, cost_micros, usefulness, occurred_at
     FROM model_calls WHERE tenant_id = ? ORDER BY occurred_at, id LIMIT ?`,
  );

  return {
    /** Append the model-router call record for the tenant. Immutable once
     * written; usefulness is stubbed null until an evaluator fills it.
     * Nothing in this slice writes call records — the router wires this
     * repository when quorum/critic flows land (out of scope here). */
    recordCall(tenantId, call, { id = `mcall_${randomUUID()}` } = {}) {
      insertCall.run(
        tenantId,
        id,
        call.provider,
        call.model,
        call.promptVersion,
        call.toolCatalogVersion,
        call.taskType,
        call.tokensIn,
        call.tokensOut,
        call.latencyMs,
        call.costMicros,
        call.usefulness ?? null,
        call.occurredAt,
      );
      return { recorded: true, id };
    },

    listCalls(tenantId, { limit = 200 } = {}) {
      return selectCalls.all(tenantId, limit);
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
    snapshots: createSnapshotRepository(db),
    decisions: createDecisionRepository(db),
    learnings: createLearningRepository(db),
    callLogs: createCallLogRepository(db),
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
