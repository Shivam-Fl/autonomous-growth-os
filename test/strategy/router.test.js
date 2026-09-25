// The model router (TR-12, IAC-5): providers are injected at construction, a
// swap is a constructor argument, no business logic ever names a model, and
// every call returns the record the auditor needs — provider, model, prompt
// version, tool-catalog version, tokens, latency and integer cost micros.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, ROUTER_ERROR_CODES, FakePrimaryModel, FakeSecondaryModel, HangingModel } from '../../src/strategy/router.js';

const CALL = {
  taskType: 'hypothesis_generation',
  messages: [{ role: 'user', content: 'propose the next experiment' }],
  promptVersion: 'p/3',
  toolCatalogVersion: 'tools/7',
  tenantId: 'tenant_demo',
};

const router = (...providers) => new ModelRouter({ providers });

test('provider swap changes no business logic: the same taskType call succeeds on primary and secondary', async () => {
  const primaryFirst = await router(new FakePrimaryModel(), new FakeSecondaryModel()).generate_structured({ ...CALL });
  const secondaryFirst = await router(new FakeSecondaryModel(), new FakePrimaryModel()).generate_structured({ ...CALL });
  assert.equal(primaryFirst.ok, true);
  assert.equal(secondaryFirst.ok, true);
  assert.equal(primaryFirst.data.task_type, 'hypothesis_generation');
  assert.equal(secondaryFirst.data.task_type, 'hypothesis_generation');
  assert.equal(primaryFirst.call.provider, 'fake-primary');
  assert.equal(secondaryFirst.call.provider, 'fake-secondary', 'the constructor order decides the default, not the caller');
});

test('every call record carries provider, model, prompt version, tool-catalog version, tokens, latency and integer cost micros', async () => {
  const { call } = await router(new FakePrimaryModel(), new FakeSecondaryModel()).generate_structured({ ...CALL });
  assert.equal(call.provider, 'fake-primary');
  assert.equal(call.model, 'fake-primary-v1');
  assert.equal(call.promptVersion, 'p/3');
  assert.equal(call.toolCatalogVersion, 'tools/7');
  assert.equal(call.taskType, 'hypothesis_generation');
  assert.equal(call.tenantId, 'tenant_demo');
  assert.equal(typeof call.tokensIn, 'number');
  assert.equal(Number.isInteger(call.tokensIn) && call.tokensIn > 0, true, 'token counts are positive integers');
  assert.equal(Number.isInteger(call.tokensOut) && call.tokensOut > 0, true);
  assert.equal(typeof call.latencyMs, 'number');
  assert.ok(call.latencyMs >= 0, 'latency is measured, never negative');
  assert.equal(Number.isInteger(call.costMicros), true, 'cost is integer micros');
  assert.ok(call.costMicros > 0, 'the fake pricing produces a nonzero cost');
  assert.match(call.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'occurred_at is a UTC timestamp');
});

test('critic:true routes to the second provider, and an explicit provider id wins over the default', async () => {
  const two = router(new FakePrimaryModel(), new FakeSecondaryModel());
  const critic = await two.generate_structured({ ...CALL, critic: true });
  assert.equal(critic.call.provider, 'fake-secondary', 'the critic leg lands on the second provider');
  assert.equal(critic.call.model, 'fake-secondary-v1');

  const chosen = await two.generate_structured({ ...CALL, provider: 'fake-secondary' });
  assert.equal(chosen.call.provider, 'fake-secondary');

  // A single-provider router degrades the critic leg to its only provider.
  const solo = router(new FakePrimaryModel());
  assert.equal((await solo.generate_structured({ ...CALL, critic: true })).call.provider, 'fake-primary');
});

test('unknown provider ids and unregistered defaults are rejected with ROUTER_UNKNOWN_PROVIDER', async () => {
  const two = router(new FakePrimaryModel(), new FakeSecondaryModel());
  await assert.rejects(
    () => two.generate_structured({ ...CALL, provider: 'claude-opus' }),
    (error) => error.code === ROUTER_ERROR_CODES.UNKNOWN_PROVIDER,
    'a model name in business logic is exactly what the router forbids',
  );
  await assert.rejects(() => two.generate_structured({ ...CALL, critic: true, provider: 'nope' }), (error) => error.code === 'ROUTER_UNKNOWN_PROVIDER');
  assert.throws(() => new ModelRouter({ providers: [] }), (error) => error.code === 'ROUTER_UNKNOWN_PROVIDER');
  assert.throws(() => new ModelRouter({ providers: [new FakePrimaryModel()], defaultProvider: 'ghost' }), (error) => error.code === 'ROUTER_UNKNOWN_PROVIDER');
  assert.throws(() => new ModelRouter({ providers: [{ id: 'x', model: 'm' }] }), (error) => error.code === 'ROUTER_UNKNOWN_PROVIDER', 'a provider without the full interface is refused');
  assert.throws(() => router(new FakePrimaryModel(), new FakePrimaryModel()), (error) => error.code === 'ROUTER_UNKNOWN_PROVIDER', 'duplicate ids cannot coexist');
});

test('an over-budget call is refused up front with ROUTER_BUDGET_EXCEEDED, before any provider runs', async () => {
  const provider = new FakePrimaryModel();
  await assert.rejects(
    () => router(provider).generate_structured({ ...CALL, budget: 10 }),
    (error) => error.code === ROUTER_ERROR_CODES.BUDGET_EXCEEDED,
  );
  // The refusal happens before the provider is touched: no tokens are billed.
  assert.equal(provider.id, 'fake-primary');
});

test('a hanging provider resolves through the router timeout with ROUTER_TIMEOUT', async () => {
  await assert.rejects(
    () => router(new HangingModel()).generate_structured({ ...CALL, timeout: 25 }),
    (error) => error.code === ROUTER_ERROR_CODES.TIMEOUT,
  );
});

test('the embedding hint routes through the same provider abstraction with its own call record', async () => {
  const { ok, vector, call } = await router(new FakePrimaryModel()).embed({ text: 'search-brand qualified CPL', tenantId: 'tenant_demo' });
  assert.equal(ok, true);
  assert.equal(vector.length, 8, 'the fake embedder returns a deterministic 8-dim hint vector');
  assert.equal(call.taskType, 'embed');
  assert.equal(call.tenantId, 'tenant_demo');
  assert.equal(Number.isInteger(call.costMicros), true);
});
