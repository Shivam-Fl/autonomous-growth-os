// Repositories own all SQL: SQLite implementations of the persistence
// interfaces the domain and workflows depend on. Every query binds tenant_id,
// so isolation holds on every path; raw_events and audit_events expose no
// update or delete surface (append-only, TR-20), decisions are append-only
// and state_snapshots immutable (TR-6, storage triggers in db.js), and
// replayRawToDerived() rebuilds derived_metrics from raw_events alone.

import { randomUUID } from 'node:crypto';
import { utcNow } from './db.js';
import { SCOPE_FIELDS } from '../memory/learnings.js';
import { rankOpportunities, readableComponents } from '../domain/opportunities.js';

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

// Opportunity/experiment working state (issue #22): OPPORTUNITIES and
// EXPERIMENTS carry no immutability trigger — scores, states and evaluation
// columns are rewritten in place — so updateState below is a legal write.
// EXPERIMENT_EVALUATIONS is append-only: only an insert and a tenant-bound
// read exist here, and the storage triggers in db.js block raw SQL too.

function createOpportunityRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO opportunities (tenant_id, opportunity_id, record, score, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, opportunity_id, record, score, created_at FROM opportunities WHERE tenant_id = ? AND opportunity_id = ?',
  );
  // The single rank key everywhere: stored score DESC, opportunity_id ASC.
  const selectRanked = db.prepare(
    'SELECT tenant_id, opportunity_id, record, score, created_at FROM opportunities WHERE tenant_id = ? ORDER BY score DESC, opportunity_id ASC',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    const record = parseJson(row.record, {});
    return {
      tenant_id: row.tenant_id,
      opportunity_id: row.opportunity_id,
      name: record.name ?? row.opportunity_id,
      record,
      // All eight component keys, always, projected by the domain's shared
      // readability rule: a component this build cannot stand behind is
      // present-and-null, never a dropped key, because JSON.stringify removes
      // an undefined key and a caller cannot tell a component the build chose
      // not to return from a component that was never stored. The same rule
      // decides expectedContribution and what the page renderer prints, so one
      // stored record cannot be readable here and unreadable there.
      //
      // This is a wire-format change, and it applies to all eight keys, not
      // only the two money components: a client that distinguished
      // `'fit' in components` from `components.fit === null` — or did so for
      // value_micros, as the previous projection's own example did — will see
      // the difference.
      components: readableComponents(record),
      score: row.score,
      created_at: row.created_at,
    };
  }

  return {
    /**
     * Idempotent by fixed id: re-creating an existing opportunity_id is a
     * no-op. Returns {created, ...the row} so callers can tell new from
     * duplicate. The score stored is the one the caller computed and posts
     * (spec section 26: components AND score are stored at write time).
     */
    create({ tenant_id: tenantId, opportunity_id: opportunityId, record, score }) {
      const result = insert.run(tenantId, opportunityId, JSON.stringify(record), score, utcNow());
      const created = result.changes > 0;
      return { created, ...shape(selectOne.get(tenantId, opportunityId)) };
    },

    get(tenantId, opportunityId) {
      return shape(selectOne.get(tenantId, opportunityId));
    },

    /** Ranked rows in stored-score order; the view never re-sorts. The order
     * is decided by the domain's one rank function, so the shipped listing and
     * the unit-tested rankOpportunities can never drift apart. */
    list(tenantId) {
      return rankOpportunities(selectRanked.all(tenantId).map(shape));
    },
  };
}

function createExperimentRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO experiments (tenant_id, experiment_id, record, state, data_through, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const updateState = db.prepare(
    'UPDATE experiments SET state = ?, evaluation_result = ?, evaluation_reason = ?, evaluated_at = ?, data_through = ? WHERE tenant_id = ? AND experiment_id = ?',
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, experiment_id, record, state, evaluation_result, evaluation_reason, evaluated_at, data_through, created_at FROM experiments WHERE tenant_id = ? AND experiment_id = ?',
  );
  const selectAll = db.prepare(
    'SELECT tenant_id, experiment_id, record, state, evaluation_result, evaluation_reason, evaluated_at, data_through, created_at FROM experiments WHERE tenant_id = ? ORDER BY created_at, experiment_id',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    const record = parseJson(row.record, {});
    return {
      tenant_id: row.tenant_id,
      experiment_id: row.experiment_id,
      name: record.name ?? row.experiment_id,
      record,
      state: row.state,
      evaluation_result: row.evaluation_result,
      evaluation_reason: row.evaluation_reason,
      evaluated_at: row.evaluated_at,
      data_through: row.data_through,
      created_at: row.created_at,
    };
  }

  return {
    /** Idempotent by fixed id, like the opportunity repository. */
    create({ tenant_id: tenantId, experiment_id: experimentId, record, state, data_through: dataThrough }) {
      const result = insert.run(tenantId, experimentId, JSON.stringify(record), state ?? 'draft', dataThrough ?? null, utcNow());
      return { created: result.changes > 0, ...this.get(tenantId, experimentId) };
    },

    get(tenantId, experimentId) {
      return shape(selectOne.get(tenantId, experimentId));
    },

    list(tenantId) {
      return selectAll.all(tenantId).map(shape);
    },

    /**
     * Mutable working state by design: evaluating an experiment rewrites its
     * state row in place (win/loss → matured, weak evidence → inconclusive).
     * No trigger guards this table, so the UPDATE always succeeds; only
     * experiment_evaluations is append-only.
     */
    updateState(tenantId, experimentId, { state, evaluation_result: evaluationResult = null, evaluation_reason: evaluationReason = null, evaluated_at: evaluatedAt = null, data_through: dataThrough = null }) {
      updateState.run(state, evaluationResult, evaluationReason, evaluatedAt, dataThrough, tenantId, experimentId);
      return this.get(tenantId, experimentId);
    },
  };
}

function createEvaluationRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO experiment_evaluations (tenant_id, experiment_id, evaluated_at, result, reason, counts) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectForExperiment = db.prepare(
    'SELECT tenant_id, experiment_id, evaluated_at, result, reason, counts FROM experiment_evaluations WHERE tenant_id = ? AND experiment_id = ? ORDER BY evaluated_at',
  );

  function shape(row) {
    return { ...row, counts: parseJson(row.counts, {}) };
  }

  return {
    /**
     * Append-only: this insert is the only write. experiment_evaluations is
     * guarded by the storage triggers in db.js, so even raw SQL cannot
     * UPDATE or DELETE an evaluation row. A duplicate (experiment,
     * evaluated_at) is a no-op.
     */
    append({ tenant_id: tenantId, experiment_id: experimentId, evaluated_at: evaluatedAt, result, reason = null, counts }) {
      const outcome = insert.run(tenantId, experimentId, evaluatedAt, result, reason, JSON.stringify(counts ?? {}));
      return { appended: outcome.changes > 0 };
    },

    listForExperiment(tenantId, experimentId) {
      return selectForExperiment.all(tenantId, experimentId).map(shape);
    },
  };
}

// The safety slice (issue #20). Six repositories behind the same contract as
// the thirteen above: every statement binds tenant_id, JSON-bearing rows go
// through a private shape(), and a table's mutability is decided in db.js —
// approvals and kill_switches are mutable working state, capabilities,
// action_records and guardian_incidents are append-only on the verbs their
// triggers name.

// APPROVALS. Mutable working state, like opportunities: deciding an approval
// rewrites its status in place, so the table carries no immutability trigger.
// 'lapsed' is never STORED — it is derived from expires_at by
// isPendingApproval in src/domain/approvals.js, so there is one predicate
// rather than a status string two writers have to agree on.
function createApprovalRepository(db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO approvals
      (tenant_id, approval_id, action_class, action, resource, constraints, impact, downside,
       evidence_refs, expires_at, status, reason, decided_by, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  );
  const selectOne = db.prepare(
    'SELECT * FROM approvals WHERE tenant_id = ? AND approval_id = ?',
  );
  const selectAll = db.prepare(
    'SELECT * FROM approvals WHERE tenant_id = ? ORDER BY status, expires_at, approval_id',
  );
  const updateDecision = db.prepare(
    'UPDATE approvals SET status = ?, reason = ?, decided_by = ?, decided_at = ? WHERE tenant_id = ? AND approval_id = ?',
  );
  const updateSeedReset = db.prepare(
    "UPDATE approvals SET status = 'pending', expires_at = ?, reason = NULL, decided_by = NULL, decided_at = NULL WHERE tenant_id = ? AND approval_id = ?",
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
      constraints: parseJson(row.constraints, {}),
      evidence_refs: parseJson(row.evidence_refs, []),
    };
  }

  return {
    /** Idempotent by fixed id (apv_), like opportunities.create: a second
     * write of the same fixture is a no-op and reports {created:false}. */
    create({ tenant_id: tenantId, approval_id: approvalId, action_class: actionClass, action, resource, constraints, impact, downside, evidence_refs: evidenceRefs, expires_at: expiresAt, status = 'pending' }) {
      const result = insert.run(
        tenantId, approvalId, actionClass, action, resource, JSON.stringify(constraints ?? {}),
        impact, downside, JSON.stringify(evidenceRefs ?? []), expiresAt, status, utcNow(),
      );
      return { created: result.changes > 0, ...this.get(tenantId, approvalId) };
    },

    get(tenantId, approvalId) {
      return shape(selectOne.get(tenantId, approvalId));
    },

    /** Deterministic order (status, expires_at, approval_id) so the queue
     * renders identically twice in a row. */
    list(tenantId) {
      return selectAll.all(tenantId).map(shape);
    },

    /** The ONE update that changes an approval's status. approve, reject and
     * the seed's restore all route through here, so no second writer exists. */
    decide(tenantId, approvalId, { status, reason = null, actor = null, decided_at: decidedAt = null }) {
      updateDecision.run(status, reason, actor, decidedAt, tenantId, approvalId);
      return this.get(tenantId, approvalId);
    },

    /** Put a seeded row back to 'pending' with a fresh stamp. The QA reset
     * needs a pending row again and this is the only writer of that
     * transition besides decide — it exists so a re-run of the same script is
     * a re-approval rather than a dead end. */
    resetToSeed(tenantId, approvalId, { expires_at: expiresAt }) {
      updateSeedReset.run(expiresAt, tenantId, approvalId);
      return this.get(tenantId, approvalId);
    },
  };
}

// CAPABILITIES. Append-only on both verbs, so the only write is this insert.
// capability_id is generated per issuance, never fixed, which is why a
// re-approval after a reset can issue a second capability for one nonce.
function createCapabilityRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO capabilities (tenant_id, capability_id, envelope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, capability_id, envelope, issued_at, expires_at FROM capabilities WHERE tenant_id = ? AND capability_id = ?',
  );
  const selectForTenant = db.prepare(
    'SELECT tenant_id, capability_id, envelope, issued_at, expires_at FROM capabilities WHERE tenant_id = ? ORDER BY issued_at DESC, capability_id LIMIT ?',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    return { ...row, envelope: parseJson(row.envelope, {}) };
  }

  return {
    create({ tenant_id: tenantId, capability_id: capabilityId, envelope, expires_at: expiresAt }) {
      const result = insert.run(tenantId, capabilityId, JSON.stringify(envelope), utcNow(), expiresAt);
      return { created: result.changes > 0, ...this.get(tenantId, capabilityId) };
    },

    get(tenantId, capabilityId) {
      return shape(selectOne.get(tenantId, capabilityId));
    },

    listForTenant(tenantId, { limit = 200 } = {}) {
      return selectForTenant.all(tenantId, limit).map(shape);
    },
  };
}

// ACTION_RECORDS. The receipts. UNIQUE (tenant_id, nonce) is what makes a
// second delivery of one capability impossible, so appended:false IS the
// duplicate signal and getByNonce is the dedupe read every caller shares.
function createActionRecordRepository(db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO action_records
      (tenant_id, receipt_id, approval_id, capability_id, nonce, action_class, action, resource,
       requested, reported, reconciliation, drift, maturity_at_decision, band_at_decision, actor, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(
    'SELECT * FROM action_records WHERE tenant_id = ? AND receipt_id = ?',
  );
  const selectByNonce = db.prepare(
    'SELECT * FROM action_records WHERE tenant_id = ? AND nonce = ?',
  );
  const selectForTenant = db.prepare(
    'SELECT * FROM action_records WHERE tenant_id = ? ORDER BY executed_at, receipt_id LIMIT ?',
  );
  const selectByApproval = db.prepare(
    'SELECT * FROM action_records WHERE tenant_id = ? AND approval_id = ? ORDER BY executed_at, receipt_id',
  );
  const deleteByNonces = db.prepare(
    'DELETE FROM action_records WHERE tenant_id = ? AND nonce IN (SELECT value FROM json_each(?))',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
      requested: parseJson(row.requested, {}),
      reported: parseJson(row.reported, {}),
    };
  }

  return {
    /** Append-only: the UNIQUE nonce is what makes a second append impossible,
     * so {appended:false} means the receipt already exists. */
    append({ tenant_id: tenantId, receipt_id: receiptId, approval_id: approvalId = null, capability_id: capabilityId = null, nonce, action_class: actionClass, action, resource, requested, reported, reconciliation, drift, maturity_at_decision: maturityAtDecision = null, band_at_decision: bandAtDecision = null, actor, executed_at: executedAt }) {
      const result = insert.run(
        tenantId, receiptId, approvalId, capabilityId, nonce, actionClass, action, resource,
        JSON.stringify(requested ?? {}), JSON.stringify(reported ?? {}), reconciliation, drift,
        maturityAtDecision, bandAtDecision, actor, executedAt,
      );
      return { appended: result.changes > 0, receipt_id: receiptId };
    },

    /** THE dedupe read: the executor calls it before it touches a provider. */
    getByNonce(tenantId, nonce) {
      return shape(selectByNonce.get(tenantId, nonce));
    },

    get(tenantId, receiptId) {
      return shape(selectOne.get(tenantId, receiptId));
    },

    /** The executed-receipts panel's source. Callers filter to rows carrying
     * a non-null approval_id: a receipt minted by POST /v1/actions/execute has
     * approval_id NULL, belongs to no queue row, and must not sit in a panel
     * that counts decisions taken on this queue. */
    listForTenant(tenantId, { limit = 200 } = {}) {
      return selectForTenant.all(tenantId, limit).map(shape);
    },

    listByApproval(tenantId, approvalId) {
      return selectByApproval.all(tenantId, approvalId).map(shape);
    },

    /** The one delete in this otherwise delete-free surface. Its only caller
     * in the repository is scripts/seed.js --reset-approvals, which must clear
     * a seeded receipt so the next run of the same QA script can approve the
     * same approval again. The predicate is a nonce LIST built by calling
     * kernel.decisionNonce over the seeded approval ids — never a prefix
     * match, which could disagree with the value the approve path stores. */
    purgeSeeded(tenantId, nonces) {
      if (!Array.isArray(nonces) || nonces.length === 0) {
        return 0;
      }
      return deleteByNonces.run(tenantId, JSON.stringify(nonces)).changes;
    },
  };
}

// KILL_SWITCHES. Mutable: a freeze is raised and cleared, not rewritten.
// Every query binds tenant_id, so a 'global' freeze is a row OWNED BY the
// tenant that raised it — never a '' sentinel row no reader would look for.
function createKillSwitchRepository(db) {
  const upsertFreeze = db.prepare(
    `INSERT INTO kill_switches
      (tenant_id, scope, scope_id, kind, active, frozen_at, frozen_by, reason, re_enabled_at, re_enabled_by)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL)
     ON CONFLICT (tenant_id, scope, scope_id)
     DO UPDATE SET kind = excluded.kind, active = 1, frozen_at = excluded.frozen_at,
                   frozen_by = excluded.frozen_by, reason = excluded.reason,
                   re_enabled_at = NULL, re_enabled_by = NULL`,
  );
  // An upsert rather than a bare UPDATE so a re-enable is idempotent and always
  // leaves exactly one row for the scope: the count it reports is a count of
  // rows now CLEARED, never of transitions, so a reset prints a number that is
  // the same whether or not a freeze was live when it ran.
  const upsertReEnable = db.prepare(
    `INSERT INTO kill_switches
      (tenant_id, scope, scope_id, kind, active, frozen_at, frozen_by, reason, re_enabled_at, re_enabled_by)
     VALUES (?, ?, ?, NULL, 0, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (tenant_id, scope, scope_id)
     DO UPDATE SET active = 0, re_enabled_at = excluded.re_enabled_at, re_enabled_by = excluded.re_enabled_by`,
  );
  const selectActive = db.prepare(
    'SELECT tenant_id, scope, scope_id, kind, active, frozen_at, frozen_by, reason, re_enabled_at, re_enabled_by FROM kill_switches WHERE tenant_id = ? AND scope = ? AND scope_id = ? AND active = 1',
  );
  // EVERY active row for the tenant, whatever its scope. The scope filter is
  // the load-bearing part: a UNION over only the global and tenant disjuncts
  // silently drops a provider- or campaign-scoped row — and the demo's own
  // freeze defaults to ('provider','meta_ads') — so the row the write side
  // reports as frozen would be invisible to the banner, to GET /v1/guardian
  // and to every other reader.
  const selectActiveForTenant = db.prepare(
    'SELECT tenant_id, scope, scope_id, kind, active, frozen_at, frozen_by, reason, re_enabled_at, re_enabled_by FROM kill_switches WHERE tenant_id = ? AND active = 1 ORDER BY scope, scope_id',
  );
  const selectForTenant = db.prepare(
    'SELECT tenant_id, scope, scope_id, kind, active, frozen_at, frozen_by, reason, re_enabled_at, re_enabled_by FROM kill_switches WHERE tenant_id = ? ORDER BY scope, scope_id',
  );

  return {
    /** ON CONFLICT, so a re-trigger raises the SAME row rather than appending a
     * second active one that a later re-enable could not clear. */
    upsertFreeze({ tenant_id: tenantId, scope, scope_id: scopeId, kind, reason, actor, frozen_at: frozenAt }) {
      upsertFreeze.run(tenantId, scope, scopeId, kind, frozenAt, actor, reason);
      return this.listForTenant(tenantId).find((row) => row.scope === scope && row.scope_id === scopeId) ?? null;
    },

    reEnable(tenantId, scope, scopeId, { actor, at }) {
      upsertReEnable.run(tenantId, scope, scopeId, at ?? utcNow(), actor);
      return this.listForTenant(tenantId).find((row) => row.scope === scope && row.scope_id === scopeId) ?? null;
    },

    /** The kernel's read-only port: one indexed row read, no list, no write. */
    isActive(tenantId, scope, scopeId) {
      return selectActive.get(tenantId, scope, scopeId) !== undefined;
    },

    activeFor(tenantId) {
      return selectActiveForTenant.all(tenantId);
    },

    listForTenant(tenantId) {
      return selectForTenant.all(tenantId);
    },
  };
}

// GUARDIAN_INCIDENTS. Append-only on both verbs: an incident is never
// updated, because current state is the join with the kill switch and an
// incident row that could be edited would be a second, worse source of truth.
function createGuardianIncidentRepository(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO guardian_incidents (tenant_id, incident_id, kind, details, frozen_at, detected_by) VALUES (?, ?, ?, ?, ?, ?)',
  );
  // frozen_at then incident_id: two incidents can share a frozen_at (both
  // frozen in the same millisecond), and the id is the documented tiebreak the
  // banner's "newest incident" read relies on.
  const selectForTenant = db.prepare(
    'SELECT tenant_id, incident_id, kind, details, frozen_at, detected_by FROM guardian_incidents WHERE tenant_id = ? ORDER BY frozen_at DESC, incident_id DESC LIMIT ?',
  );

  function shape(row) {
    return { ...row, details: parseJson(row.details, {}) };
  }

  return {
    append({ tenant_id: tenantId, incident_id: incidentId, kind, details, frozen_at: frozenAt, detected_by: detectedBy }) {
      const result = insert.run(tenantId, incidentId, kind, JSON.stringify(details ?? {}), frozenAt, detectedBy);
      return { appended: result.changes > 0, id: incidentId };
    },

    listForTenant(tenantId, { limit = 20 } = {}) {
      return selectForTenant.all(tenantId, limit).map(shape);
    },
  };
}

// TRUST_LEDGER. Mutable upsert, one row per class: that single row is what
// makes the posture the page renders and the posture the gate enforces the
// same claim rather than two derivations of different data.
function createTrustLedgerRepository(db) {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO trust_ledger
      (tenant_id, action_class, evaluated, correct, needless, downside_penalties, pinned, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(
    'SELECT tenant_id, action_class, evaluated, correct, needless, downside_penalties, pinned, updated_at FROM trust_ledger WHERE tenant_id = ? AND action_class = ?',
  );
  const selectForTenant = db.prepare(
    'SELECT tenant_id, action_class, evaluated, correct, needless, downside_penalties, pinned, updated_at FROM trust_ledger WHERE tenant_id = ? ORDER BY action_class',
  );

  function shape(row) {
    if (!row) {
      return null;
    }
    return { ...row, pinned: row.pinned === 1 };
  }

  return {
    upsert(tenantId, { action_class: actionClass, evaluated, correct, needless, downside_penalties: downsidePenalties = 0, pinned = false, updated_at: updatedAt }) {
      upsert.run(tenantId, actionClass, evaluated, correct, needless, downsidePenalties, pinned ? 1 : 0, updatedAt ?? utcNow());
      return this.get(tenantId, actionClass);
    },

    /** The ONE row a class's posture is derived from, or null when the class
     * has no evidence at all — which trust.postureFor answers fail-closed. */
    get(tenantId, actionClass) {
      return shape(selectOne.get(tenantId, actionClass));
    },

    listForTenant(tenantId) {
      return selectForTenant.all(tenantId).map(shape);
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
    opportunities: createOpportunityRepository(db),
    experiments: createExperimentRepository(db),
    evaluations: createEvaluationRepository(db),
    approvals: createApprovalRepository(db),
    capabilities: createCapabilityRepository(db),
    actionRecords: createActionRecordRepository(db),
    killSwitches: createKillSwitchRepository(db),
    guardianIncidents: createGuardianIncidentRepository(db),
    trustLedger: createTrustLedgerRepository(db),
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
