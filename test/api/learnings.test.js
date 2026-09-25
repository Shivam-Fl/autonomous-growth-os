// GET /v1/learnings: the tenant-scoped, deterministically ordered listing
// (TR-10). Rows are written deliberately out of order so the response can
// only come from the ORDER BY, and a second tenant's rows prove isolation.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';
import { validateLearning } from '../../src/memory/learnings.js';

const dir = mkdtempSync(join(tmpdir(), 'learnings-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;

/** Write one accepted learning for a tenant through the same validation the
 * domain enforces everywhere else. */
function seedLearning(tenantId, id, claim, updatedAt) {
  const result = validateLearning({
    id,
    claim,
    scope: { tenant: tenantId },
    evidenceRefs: [`ev_for_${id}`],
    evidenceType: 'observational',
    confidence: 0.72,
    status: 'accepted',
    validFrom: '2026-09-01T00:00:00.000Z',
    staleAfter: '2027-09-25T00:00:00.000Z',
    updatedAt,
    createdAt: '2026-09-20T00:00:00.000Z',
  });
  assert.equal(result.ok, true, `fixture learning ${id} must validate`);
  repositories.learnings.upsert(tenantId, result.learning);
}

// Inserted in the WORST possible order for a reader that trusts insertion
// sequence: the row that must sort second goes in first.
seedLearning('tenant_alpha', 'lrn_beta_later', 'brand search CPL tracks 18% below generic prospecting', '2026-09-25T10:00:00.000Z');
seedLearning('tenant_alpha', 'lrn_alpha_earlier', 'exact-intent queries convert above broad prospecting', '2026-09-20T08:00:00.000Z');
seedLearning('tenant_beta', 'lrn_beta_private', 'a claim that belongs to tenant_beta alone', '2026-09-21T08:00:00.000Z');

test('GET /v1/learnings returns the requesting tenant\'s learnings in deterministic (updated_at, id) order', async () => {
  const response = await fetch(url('/v1/learnings?tenant_id=tenant_alpha'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tenant_id, 'tenant_alpha');
  assert.deepEqual(
    body.learnings.map((learning) => learning.id),
    ['lrn_alpha_earlier', 'lrn_beta_later'],
    'the earlier updated_at sorts first even though it was inserted second — insertion order decides nothing',
  );
  for (const learning of body.learnings) {
    assert.match(learning.id, /^lrn_/);
    assert.equal(typeof learning.claim, 'string');
    assert.deepEqual(learning.scope, { tenant: 'tenant_alpha' });
    assert.ok(Array.isArray(learning.evidenceRefs) && learning.evidenceRefs.length > 0);
    assert.equal(learning.status, 'accepted');
    assert.equal(typeof learning.confidence, 'number');
    assert.match(learning.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('second tenant rows never leak into the first tenant\'s response', async () => {
  const alpha = await (await fetch(url('/v1/learnings?tenant_id=tenant_alpha'))).json();
  assert.equal(alpha.tenant_id, 'tenant_alpha');
  for (const learning of alpha.learnings) {
    assert.equal(learning.tenantId, 'tenant_alpha', 'every served row is bound to the requesting tenant');
    assert.notEqual(learning.id, 'lrn_beta_private');
    assert.ok(!JSON.stringify(learning).includes('tenant_beta'), 'no beta reference appears anywhere in the alpha payload');
    assert.ok(!JSON.stringify(learning).includes('tenant_beta alone'), 'the private claim never crosses tenants');
  }
  // And the mirror: beta sees exactly its own row, never alpha's.
  const beta = await (await fetch(url('/v1/learnings?tenant_id=tenant_beta'))).json();
  assert.deepEqual(beta.learnings.map((learning) => learning.id), ['lrn_beta_private']);
  assert.ok(!JSON.stringify(beta).includes('lrn_alpha_earlier'));
  assert.ok(!JSON.stringify(beta).includes('lrn_beta_later'));
});

test('unknown tenant returns an empty list with 200', async () => {
  const response = await fetch(url('/v1/learnings?tenant_id=tenant_nobody'));
  assert.equal(response.status, 200, 'an unknown tenant is not an error — it is an empty book');
  const body = await response.json();
  assert.equal(body.tenant_id, 'tenant_nobody');
  assert.deepEqual(body.learnings, []);
});
