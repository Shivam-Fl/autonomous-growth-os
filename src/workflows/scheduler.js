// In-process workflow scheduler (TR-22): named handlers, delayed schedules,
// an exactly-once consumer wrapper keyed on (tenant_id, event_id), and a saga
// runner with compensating actions. Saga state persists to saga_runs and
// idempotency_keys, so a run interrupted mid-step resumes to exactly-once
// effects on restart; Temporal Cloud replaces this module later behind the
// same interface.

import { randomUUID } from 'node:crypto';
import { validateEvent } from '../domain/events.js';

function stepConsumer(sagaName, stepName) {
  return `saga:${sagaName}:${stepName}`;
}

function compensateConsumer(sagaName, stepName) {
  return `saga:${sagaName}:compensate:${stepName}`;
}

export function createScheduler({ repos }) {
  const handlers = new Map();
  const sagaDefinitions = new Map();
  const timers = new Set();

  return {
    /** Register a named handler; handlers receive the payload or event. */
    register(name, handler) {
      handlers.set(name, handler);
    },

    /** Register a saga: an ordered list of steps with compensating actions. */
    registerSaga(name, steps) {
      sagaDefinitions.set(name, { name, steps });
    },

    /** Run a registered handler immediately. */
    async run(name, payload) {
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`no workflow registered as ${name}`);
      }
      return handler(payload);
    },

    /** Schedule a handler after delayMs (0 = next tick). */
    schedule(name, payload, { delayMs = 0 } = {}) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        this.run(name, payload).catch((error) => {
          console.error(`scheduled workflow ${name} failed:`, error);
        });
      }, delayMs);
      timers.add(timer);
      return timer;
    },

    /**
     * Deliver an event to a registered consumer exactly once on the event's
     * (tenant_id, event_id) key. A failed handler releases the claim so the
     * delivery can be retried.
     */
    async consume(event, consumerName) {
      const validated = validateEvent(event);
      if (!validated.ok) {
        throw validated.error;
      }
      const handler = handlers.get(consumerName);
      if (!handler) {
        throw new Error(`no workflow registered as ${consumerName}`);
      }
      const { tenant_id: tenantId, event_id: eventId } = validated.event;
      if (!repos.idempotency.claim(tenantId, eventId, consumerName)) {
        return { applied: false };
      }
      try {
        const receipt = await handler(validated.event);
        repos.idempotency.record(tenantId, eventId, consumerName, receipt ?? null);
        return { applied: true };
      } catch (error) {
        repos.idempotency.release(tenantId, eventId, consumerName);
        throw error;
      }
    },

    /** Start a registered saga and run it to completion or compensation. */
    async startSaga(name, { tenantId, payload }) {
      const definition = sagaDefinitions.get(name);
      if (!definition) {
        throw new Error(`no saga registered as ${name}`);
      }
      const runId = `sag_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const run = repos.sagas.create({ tenant_id: tenantId, run_id: runId, name, payload });
      return this.execute(run, definition);
    },

    /** Resume sagas left running or compensating by an interrupted process. */
    async resumeSagas() {
      const results = [];
      // Enumerate tenant ids first, then list each tenant's runs through the
      // tenant-scoped query, so resume-all never reads another tenant's rows.
      for (const tenantId of repos.sagas.listRunningTenantIds()) {
        for (const run of repos.sagas.listRunning(tenantId)) {
          const definition = sagaDefinitions.get(run.name);
          if (!definition) {
            console.error(`cannot resume saga ${run.run_id}: no saga registered as ${run.name}`);
            continue;
          }
          results.push({ runId: run.run_id, ...(await this.execute(run, definition)) });
        }
      }
      return { resumed: results.length, runs: results };
    },

    getRun(tenantId, runId) {
      return repos.sagas.get(tenantId, runId);
    },

    /** Clear pending timers; running sagas are unaffected. */
    stopAll() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },

    async execute(run, definition) {
      if (run.status === 'compensating') {
        return this.unwind(run, definition, run.step);
      }
      for (let index = run.step; index < definition.steps.length; index += 1) {
        const step = definition.steps[index];
        const consumer = stepConsumer(definition.name, step.name);
        if (!repos.idempotency.claim(run.tenant_id, run.run_id, consumer)) {
          // Claimed (and so applied, or owned by another runner) before this
          // execution: skip without re-applying the effect.
          run.step = index + 1;
          repos.sagas.save(run);
          continue;
        }
        try {
          await step.run({ tenantId: run.tenant_id, payload: run.payload, runId: run.run_id });
        } catch (error) {
          run.status = 'compensating';
          run.step = index;
          repos.sagas.save(run);
          return this.unwind(run, definition, index, { failedStep: step.name, error });
        }
        repos.idempotency.record(run.tenant_id, run.run_id, consumer, { applied: true });
        run.step = index + 1;
        repos.sagas.save(run);
      }
      run.status = 'completed';
      repos.sagas.save(run);
      return { status: 'completed', runId: run.run_id };
    },

    /** Run compensations for completed steps in reverse, then settle the run. */
    async unwind(run, definition, failedIndex, failure = {}) {
      for (let index = failedIndex - 1; index >= 0; index -= 1) {
        const step = definition.steps[index];
        const consumer = compensateConsumer(definition.name, step.name);
        if (!repos.idempotency.claim(run.tenant_id, run.run_id, consumer)) {
          continue; // already compensated after an earlier interruption
        }
        try {
          if (step.compensate) {
            await step.compensate({
              tenantId: run.tenant_id, payload: run.payload, runId: run.run_id,
            });
          }
        } catch (error) {
          repos.idempotency.release(run.tenant_id, run.run_id, consumer);
          throw error;
        }
        repos.idempotency.record(run.tenant_id, run.run_id, consumer, { compensated: true });
      }
      run.status = 'compensated';
      repos.sagas.save(run);
      return {
        status: 'compensated',
        runId: run.run_id,
        failedStep: failure.failedStep ?? definition.steps[run.step]?.name ?? null,
      };
    },
  };
}
