// The cross-consumer agreement table for issue #40: one definition of "a
// component this build can stand behind", and the four consumers of a stored
// opportunity record that must never disagree about the same record.
//
// BUG-1 (a record missing pSuccess reached the wire with seven keys), BUG-2 (a
// float or numeric-string money value sat beside a null contribution in the
// same body) and BUG-3 (the seed reported a clean no-op over a record missing
// pSuccess) were three findings on ONE defect: the rule was re-derived at each
// consumer against whichever keys the bug that motivated it happened to name.
// A unit test cannot stop a future contributor writing a fifth copy — the
// review grep in AC-12 is the human half of that — but it does stop the four
// copies that exist from classifying the same record differently, which is
// what actually shipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import {
  isReadableComponent,
  isReadableOpportunityRecord,
  unreadableComponents,
  readableComponents,
  expectedContribution,
} from '../../src/domain/opportunities.js';
import { renderPage } from '../../src/web/pages.js';

// COMPONENTS order in the domain module. Duplicated here deliberately: the
// projection's key ORDER is part of the wire contract, and a test that imported
// the list would agree with any reordering rather than pinning it.
const COMPONENT_KEYS = ['value_micros', 'pSuccess', 'fit', 'infoValue', 'reversibility', 'cost_micros', 'downside', 'delay'];

// The view's own labels, so a cell is asserted as the reader sees it.
const COMPONENT_LABELS = {
  value_micros: 'value', pSuccess: 'success probability', fit: 'fit', infoValue: 'information value',
  reversibility: 'reversibility', cost_micros: 'cost', downside: 'downside', delay: 'delay',
};

const TENANT = 'tenant_readable';

const HEALTHY = {
  value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
};

/** A stored record as a build other than this one might have left it: healthy
 * by default, with `overrides` written over it and `drop` removed outright — a
 * key that was never written rather than one written badly. */
function storedRecord({ name, drop = [], ...overrides }) {
  const record = { name, ...HEALTHY, ...overrides };
  for (const key of drop) {
    delete record[key];
  }
  return record;
}

// One fixture per corrupt shape, each with the keys it makes unreadable. The
// three QA planted shapes (missing pSuccess, a float, a numeric string) are in
// here; the pre-rename shape, a half-migrated cost, a negative amount and a
// healthy record are the ones a corrupted-but-plausible row arrives as.
const FIXTURES = [
  { id: 'opp_read_healthy', record: storedRecord({ name: 'Healthy bet' }), unreadable: [] },
  {
    id: 'opp_read_prerename',
    record: { name: 'Pre-rename bet', pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, value: 6000, cost: 1900, downside: 2, delay: 1 },
    unreadable: ['value_micros', 'cost_micros'],
  },
  { id: 'opp_read_nocost', record: storedRecord({ name: 'No cost', drop: ['cost_micros'] }), unreadable: ['cost_micros'] },
  { id: 'opp_read_nopsuccess', record: storedRecord({ name: 'No success probability', drop: ['pSuccess'] }), unreadable: ['pSuccess'] },
  {
    id: 'opp_read_float',
    record: storedRecord({ name: 'Fractional money', value_micros: 5_000_000.5, cost_micros: 1_000_000.5 }),
    unreadable: ['value_micros', 'cost_micros'],
  },
  {
    id: 'opp_read_string',
    record: storedRecord({ name: 'String money', value_micros: '2000000000', cost_micros: '500000000' }),
    unreadable: ['value_micros', 'cost_micros'],
  },
  { id: 'opp_read_negative', record: storedRecord({ name: 'Negative value', value_micros: -1_000_000 }), unreadable: ['value_micros'] },
];

test('the predicate, the projection and the contribution agree on every fixture', () => {
  for (const { id, record, unreadable } of FIXTURES) {
    assert.deepEqual(unreadableComponents(record), unreadable, `${id}: the keys that failed the rule`);
    assert.equal(isReadableOpportunityRecord(record), unreadable.length === 0, `${id}: and the boolean derived from it`);

    const components = readableComponents(record);
    for (const key of COMPONENT_KEYS) {
      const expected = unreadable.includes(key) ? null : record[key];
      assert.equal(components[key], expected, `${id}.${key}: readable values pass through, unreadable ones are null`);
    }

    // The contribution reads value_micros, cost_micros and pSuccess, so it is
    // null exactly when one of those three is unreadable — which for every
    // corrupt fixture here it is, and which is the BUG-2 body: a float or a
    // string in `components` beside a number in the contribution.
    const contributionReads = unreadable.some((key) => ['value_micros', 'cost_micros', 'pSuccess'].includes(key));
    assert.equal(
      expectedContribution(components),
      contributionReads ? null : expectedContribution(record),
      `${id}: the contribution follows the shared rule, not its own copy of it`,
    );
  }
});

test('the projection carries all eight keys, on the wire, for every fixture', () => {
  // BUG-1: the projection wrote `pSuccess: record.pSuccess`, and JSON.stringify
  // removes an undefined value — so a record missing pSuccess went out with
  // SEVEN keys and a client could not tell an unreadable component from one
  // that was never stored. This is the assertion that fails if the projection
  // is ever narrowed back to a hand-picked subset.
  for (const { id, record } of FIXTURES) {
    const components = readableComponents(record);
    assert.deepEqual(Object.keys(components), COMPONENT_KEYS, `${id}: eight keys, in COMPONENTS order`);

    const onTheWire = JSON.parse(JSON.stringify({ components }));
    assert.equal(Object.keys(onTheWire.components).length, 8, `${id}: and still eight after JSON.stringify`);
    for (const key of COMPONENT_KEYS) {
      assert.ok(key in onTheWire.components, `${id}: ${key} survives the wire as an explicit null`);
    }
  }
  // A record this build cannot read at all projects to eight nulls rather than
  // throwing — the projection describes what exists, and says nothing about it.
  assert.deepEqual(Object.values(readableComponents({})), [null, null, null, null, null, null, null, null]);
  assert.deepEqual(Object.values(readableComponents(null)), [null, null, null, null, null, null, null, null]);
});

test('the rule is a number check, not a coercion', () => {
  // A numeric string is not a number this build can stand behind, even though
  // Number() would happily read it as one. Coercing here is how a corrupt row
  // would become a plausible-looking figure on the wire.
  assert.equal(isReadableComponent('value_micros', '2000000000'), false, 'a numeric string is not micros');
  assert.equal(isReadableComponent('pSuccess', '0.5'), false, 'nor is it a probability');
  assert.equal(isReadableComponent('value_micros', 2_000_000_000), true, 'the real number is readable');
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '', {}, []]) {
    assert.equal(isReadableComponent('value_micros', value), false, `value_micros ${JSON.stringify(value)}`);
    assert.equal(isReadableComponent('pSuccess', value), false, `pSuccess ${JSON.stringify(value)}`);
  }
  // Money is the stricter half, exactly as validateOpportunity is on write.
  assert.equal(isReadableComponent('value_micros', -1), false, 'a negative amount is not money');
  assert.equal(isReadableComponent('value_micros', 1.5), false, 'a fractional rupee is not money');
  assert.equal(isReadableComponent('value_micros', 2 ** 53), false, 'and neither is a value above MAX_SAFE_INTEGER');
  assert.equal(isReadableComponent('pSuccess', -0.5), true, 'a negative multiplier is out of range, not unreadable');
});

test('a component that is out of range but a real number stays readable', () => {
  // The deliberate boundary, pinned so a later agent cannot widen the read path
  // into a full re-validation by accident: this rule answers "can the build
  // stand behind this number", not "does this record satisfy every domain
  // range". pSuccess 1.5 is not a valid probability and is still a number the
  // build can print, so it stays on the wire rather than vanishing from a
  // display path.
  const record = storedRecord({ name: 'Out of range', pSuccess: 1.5, infoValue: -1, downside: -3 });
  assert.deepEqual(unreadableComponents(record), [], 'out of range is not unreadable');
  assert.equal(readableComponents(record).pSuccess, 1.5, 'and it stays on the wire');
  // validateOpportunity still rejects it on the way in — the write side keeps
  // every range rule, unchanged.
  const components = readableComponents(record);
  assert.equal(expectedContribution(components), Math.trunc(6_000_000_000 * 1.5) - 1_900_000_000);
});

test('the wire projection, the contribution and the page renderer never disagree', async () => {
  // The half of the table a pure unit test cannot reach: the row the repository
  // projects, the contribution the API reports and the string the view prints
  // are three renderings of one stored record, and the defect this ticket
  // exists for is them disagreeing about it.
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'readable-')), 'app.db'));
  const repositories = createRepositories(db);
  repositories.tenants.create({ id: TENANT, name: 'Readable Tenant', currency: 'INR' });
  for (const { id, record } of FIXTURES) {
    repositories.opportunities.create({ tenant_id: TENANT, opportunity_id: id, score: 0.4, record });
  }

  const html = await renderPage('/opportunities', { repositories });
  // Anchored to the row's OWN opening tag, which carries its id: a lazy match
  // starting at the first <li> would hand a later row the earlier row's cells,
  // which is how a row that renders '—' can look like one that does not.
  const rowFor = (id) => html.match(new RegExp(`<li class="opportunity-row"[^>]*data-opportunity-id="${id}"[\\s\\S]*?</li>`))[0];
  for (const { id, unreadable } of FIXTURES) {
    const row = rowFor(id);
    const wire = repositories.opportunities.get(TENANT, id).components;

    for (const key of COMPONENT_KEYS) {
      const label = COMPONENT_LABELS[key];
      const cell = row.match(new RegExp(`data-component="${key}">([^<]*)</`))[1];
      if (unreadable.includes(key)) {
        assert.equal(cell, `${label} —`, `${id}.${key}: the view prints the em-dash`);
        assert.equal(wire[key], null, `${id}.${key}: and the wire says null in the same row`);
      } else if (key === 'value_micros' || key === 'cost_micros') {
        assert.match(cell, new RegExp(`^${label} ₹`), `${id}.${key}: readable money renders as an amount`);
      } else {
        assert.equal(cell, `${label} ${wire[key]}`, `${id}.${key}: a readable value renders as itself`);
      }
    }
    assert.doesNotMatch(row, /₹NaN|undefined/, `${id}: no unreadable component leaks its raw value`);
  }

  // The one behaviour change on the view: a negative amount IS a safe integer,
  // so the renderer's previous local guard printed '-1.00' for it while the
  // rest of the app called the same number unknown.
  const negative = rowFor('opp_read_negative');
  assert.match(negative, /data-component="value_micros">value —</, 'a negative amount degrades to the em-dash');
  assert.doesNotMatch(negative, /-1\.00|₹-1/, 'never as a negative amount');
});
