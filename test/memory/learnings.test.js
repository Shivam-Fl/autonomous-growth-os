// Learning records (TR-10, IAC-3): validation, exact scope matching, the
// freshness clock, the status state machine, contradiction merging that
// retains both evidence lists, and the retrieval gate that rejects
// out-of-scope, stale and below-threshold rows before any consumer sees them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLearning,
  scopeMatch,
  isStale,
  isExpired,
  transition,
  mergeContradiction,
  gateForRetrieval,
  cosineSimilarity,
  EVIDENCE_TYPES,
} from '../../src/memory/learnings.js';

const NOW = '2026-09-25T12:00:00.000Z';
const CONTEXT = { tenant: 'tenant_demo', geography: 'IN' };

/** A valid accepted learning, fields overridden per case. */
function learning(overrides = {}) {
  return validateLearning({
    claim: 'search-brand qualified CPL tracks 18% below generic-prospecting',
    scope: { tenant: 'tenant_demo' },
    evidenceRefs: ['ev_seed_1'],
    evidenceType: 'observational',
    confidence: 0.72,
    status: 'accepted',
    validFrom: '2026-09-01T00:00:00.000Z',
    staleAfter: '2027-09-25T00:00:00.000Z',
    ...overrides,
  }).learning;
}

test('validateLearning accepts a complete record and stamps the lrn_ prefix', () => {
  const result = validateLearning({
    claim: 'a claim', scope: { tenant: 't' }, evidenceRefs: ['ev_1'], evidenceType: 'observational', confidence: 0.5,
  });
  assert.equal(result.ok, true);
  assert.match(result.learning.id, /^lrn_/);
  assert.equal(result.learning.status, 'candidate', 'a record with no status starts as a candidate');
});

test('validateLearning rejects a bad claim, scope field, evidence list, type, confidence and status with stable codes', () => {
  const cases = [
    [{ claim: '', scope: { tenant: 't' }, evidenceRefs: ['e'], evidenceType: 'observational', confidence: 0.5 }, 'LEARNING_BAD_CLAIM'],
    [{ claim: 'c', scope: { region: 'x' }, evidenceRefs: ['e'], evidenceType: 'observational', confidence: 0.5 }, 'LEARNING_BAD_SCOPE'],
    [{ claim: 'c', scope: { tenant: 't' }, evidenceRefs: [], evidenceType: 'observational', confidence: 0.5 }, 'LEARNING_BAD_EVIDENCE'],
    [{ claim: 'c', scope: { tenant: 't' }, evidenceRefs: ['e'], evidenceType: 'gut_feeling', confidence: 0.5 }, 'LEARNING_BAD_EVIDENCE_TYPE'],
    [{ claim: 'c', scope: { tenant: 't' }, evidenceRefs: ['e'], evidenceType: 'observational', confidence: 1.5 }, 'LEARNING_BAD_CONFIDENCE'],
    [{ claim: 'c', scope: { tenant: 't' }, evidenceRefs: ['e'], evidenceType: 'observational', confidence: 0.5, status: 'promoted' }, 'LEARNING_BAD_STATUS'],
    [{ claim: 'c', scope: { tenant: 't' }, evidenceRefs: ['e'], evidenceType: 'observational', confidence: 0.5, staleAfter: 'not-a-time' }, 'LEARNING_BAD_STALE_AFTER'],
    [{ claim: 'c', scope: { tenant: 't' }, evidenceRefs: ['e'], evidenceType: 'observational', confidence: 0.5, id: 'dec_1' }, 'LEARNING_BAD_ID'],
  ];
  for (const [input, code] of cases) {
    const result = validateLearning(input);
    assert.equal(result.ok, false, `${code} expected`);
    assert.equal(result.error.code, code);
    assert.equal(typeof result.error.message, 'string');
  }
  assert.deepEqual([...EVIDENCE_TYPES], ['randomized_experiment', 'quasi_experiment', 'observational', 'external_research', 'system_eval']);
});

test('scopeMatch exact-matches every defined scope field; a mismatch or an unverifiable field fails', () => {
  assert.equal(scopeMatch({ tenant: 'tenant_demo' }, CONTEXT), true);
  assert.equal(scopeMatch({ tenant: 'tenant_demo', geography: 'IN' }, CONTEXT), true);
  assert.equal(scopeMatch({ tenant: 'tenant_demo', geography: 'US' }, CONTEXT), false, 'a geography mismatch is out of scope');
  assert.equal(scopeMatch({ tenant: 'tenant_other' }, CONTEXT), false);
  assert.equal(scopeMatch({ tenant: 'tenant_demo', persona: 'smb' }, CONTEXT), false, 'a defined scope field the context never names does not match');
  assert.equal(scopeMatch(null, CONTEXT), false);
  assert.equal(scopeMatch({ tenant: 'tenant_demo' }, null), false);
});

test('isStale and isExpired read the freshness clock in UTC', () => {
  const record = { staleAfter: '2026-09-25T00:00:00.000Z', validFrom: '2026-09-01T00:00:00.000Z' };
  assert.equal(isStale(record, NOW), true, 'a row past its stale_after is stale');
  assert.equal(isStale(record, '2026-09-24T23:59:59.000Z'), false);
  assert.equal(isStale({ staleAfter: null }, NOW), false, 'a row without stale_after is not stale by that rule');
  assert.equal(isExpired(record, NOW), false);
  assert.equal(isExpired({ validFrom: '2026-10-01T00:00:00.000Z' }, NOW), true, 'a row not yet valid is expired');
});

test('the status state machine allows the lifecycle arcs and rejects invented ones', () => {
  assert.equal(transition('candidate', 'accept'), 'accepted');
  assert.equal(transition('candidate', 'reject'), 'rejected');
  assert.equal(transition('candidate', 'contradict'), 'contradicted');
  assert.equal(transition('accepted', 'contradict'), 'contradicted');
  assert.equal(transition('accepted', 'stale'), 'stale');
  assert.equal(transition('stale', 'accept'), 'accepted');
  assert.equal(transition('contradicted', 'reject'), 'rejected');
  assert.throws(() => transition('rejected', 'accept'), (error) => error.code === 'LEARNING_BAD_TRANSITION');
  assert.throws(() => transition('candidate', 'promote'), (error) => error.code === 'LEARNING_BAD_TRANSITION');
  assert.throws(() => transition('nonsense', 'accept'), (error) => error.code === 'LEARNING_BAD_TRANSITION');
});

test('mergeContradiction keeps both evidence ref lists, lowers confidence to the weaker side and sets contradicted', () => {
  const a = { id: 'lrn_1', confidence: 0.72, evidenceRefs: ['ev_1'], status: 'accepted' };
  const b = { id: 'lrn_1', confidence: 0.55, evidenceRefs: ['ev_2'], status: 'candidate' };
  const merged = mergeContradiction(a, b);
  assert.deepEqual(merged.evidenceRefs, ['ev_1', 'ev_2'], 'both sides survive the merge — never a silent overwrite');
  assert.equal(merged.status, 'contradicted');
  assert.equal(merged.confidence, 0.55, 'the merged record inherits the weaker confidence');
  assert.throws(() => mergeContradiction(a, { ...b, id: 'lrn_2' }), (error) => error.code === 'LEARNING_BAD_MERGE');
});

test('the gate rejects an out-of-scope learning (geography mismatch) before any consumer', () => {
  const outOfScope = learning({ scope: { tenant: 'tenant_demo', geography: 'US' }, staleAfter: null });
  const served = gateForRetrieval([outOfScope], { context: CONTEXT, nowIso: NOW });
  assert.deepEqual(served, [], 'an out-of-scope row never reaches a consumer');
});

test('the gate rejects a stale learning past stale_after before any consumer', () => {
  const stale = learning({ staleAfter: '2026-09-25T00:00:00.000Z' });
  const served = gateForRetrieval([stale], { context: CONTEXT, nowIso: NOW });
  assert.deepEqual(served, [], 'a stale row never reaches a consumer');
});

test('the gate rejects a below-threshold learning at the 0.60 confidence floor', () => {
  const weak = learning({ confidence: 0.59 });
  const served = gateForRetrieval([weak], { context: CONTEXT, nowIso: NOW });
  assert.deepEqual(served, []);
  const atFloor = learning({ confidence: 0.6 });
  assert.deepEqual(gateForRetrieval([atFloor], { context: CONTEXT, nowIso: NOW }), [atFloor], '0.60 is inside the band');
});

test('the gate rejects non-accepted statuses and rows not yet valid', () => {
  for (const status of ['candidate', 'contradicted', 'stale', 'rejected']) {
    const served = gateForRetrieval([learning({ status })], { context: CONTEXT, nowIso: NOW });
    assert.deepEqual(served, [], `a ${status} row never reaches a consumer`);
  }
  const future = learning({ validFrom: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(gateForRetrieval([future], { context: CONTEXT, nowIso: NOW }), []);
});

test('a row with no staleAfter still ages out through the max-age fallback', () => {
  const undated = learning({ staleAfter: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(gateForRetrieval([undated], { context: CONTEXT, nowIso: NOW }), [], 'a learning without an explicit expiry cannot outlive its evidence');
  const fresh = learning({ staleAfter: null, updatedAt: NOW });
  assert.deepEqual(gateForRetrieval([fresh], { context: CONTEXT, nowIso: NOW }), [fresh]);
});

test('similarity only reorders; the structured gate still decides admission', () => {
  const inScope = learning({});
  const outOfScope = learning({ id: 'lrn_far', scope: { tenant: 'tenant_far' }, staleAfter: null });
  const query = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const similarityOf = (record) => cosineSimilarity(query, new Array(8).fill(record.confidence));
  // Rank first by the similarity hint, exactly as retrieval assistance would.
  const ranked = [outOfScope, inScope].sort((a, b) => similarityOf(b) - similarityOf(a));
  const served = gateForRetrieval(ranked, { context: CONTEXT, nowIso: NOW });
  assert.deepEqual(served, [inScope], 'the gate runs after the ranking hint and drops what the scope rejects');
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), (error) => error.code === 'LEARNING_BAD_VECTOR');
  assert.throws(() => cosineSimilarity([], []), (error) => error.code === 'LEARNING_BAD_VECTOR');
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});
