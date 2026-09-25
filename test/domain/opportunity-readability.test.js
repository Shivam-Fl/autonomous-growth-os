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

test('the contribution is null exactly when one of the THREE keys it reads is null', () => {
  // The contract src/api/routes.js states about the wire body, as a table
  // rather than as prose. It is the regression guard for this attempt, because
  // the four consumers already agreed with each other about readability and
  // still shipped a body nobody could reconcile: a pSuccess of 1.5 beside a
  // MAX_SAFE_INTEGER value is eight readable components and a null
  // contribution, with no component to point at.
  //
  // Every existing fixture plus the QA shapes, and the five keys the formula
  // does NOT read are in the table on purpose (opp_read_nofit,
  // opp_read_fitabove): they are the direction a "one or more of the
  // components" reading gets wrong, and they are the reason a one-direction
  // comment would still be false. opp_read_nofit answers the largest number the
  // table can while `fit` is null.
  const rows = [
    ...FIXTURES.map(({ id, record }) => [id, record]),
    ['opp_read_nofit', storedRecord({ name: 'No fit', drop: ['fit'] })],
    ['opp_read_fitabove', storedRecord({ name: 'Fit above one', fit: 2 })],
    ['opp_read_pstr', storedRecord({ name: 'String probability', pSuccess: '0.5' })],
    ['opp_read_pabove', storedRecord({ name: 'Probability above one', pSuccess: 1.5 })],
    ['opp_read_pbelow', storedRecord({ name: 'Negative probability', pSuccess: -1 })],
    ['opp_read_pzero', storedRecord({ name: 'Certain failure', pSuccess: 0 })],
    ['opp_read_pone', storedRecord({ name: 'Certain win', pSuccess: 1 })],
    ['opp_read_breakeven', storedRecord({ name: 'Break-even', value_micros: 200_000_000, pSuccess: 0.5, cost_micros: 100_000_000 })],
  ];

  for (const [id, record] of rows) {
    // The projection first, because that is what the route feeds the
    // arithmetic: the contract is about the BODY, so it is asserted on the
    // same value the route computes from.
    const components = readableComponents(record);
    const formulaReadsANull = ['value_micros', 'pSuccess', 'cost_micros'].some((key) => components[key] === null);
    const contribution = expectedContribution(components);
    if (formulaReadsANull) {
      assert.equal(contribution, null, `${id}: null, because the formula reads an unreadable key`);
    } else {
      assert.equal(
        Number.isSafeInteger(contribution),
        true,
        `${id}: a number, because all three of the formula's keys are readable — got ${JSON.stringify(contribution)}`,
      );
    }
    // The same verdict straight off the stored record, so the projection and
    // the arithmetic cannot agree on a record while disagreeing on its source.
    assert.equal(contribution === null, expectedContribution(record) === null, `${id}: the record and its projection agree`);
  }

  // The empty case, spelled out because it is the row QA filed: eight
  // components cannot all be readable with an unrepresentable contribution
  // any more, which is what makes the comment above a theorem and not a hope.
  const overflowing = storedRecord({ name: 'Overflow', value_micros: Number.MAX_SAFE_INTEGER, pSuccess: 1.5, cost_micros: 0 });
  const projection = readableComponents(overflowing);
  assert.equal(projection.pSuccess, null, 'the out-of-range probability is what the body reports as unknown');
  assert.equal(projection.value_micros, Number.MAX_SAFE_INTEGER, 'the money beside it is readable and stays readable');
  assert.equal(expectedContribution(projection), null);
  assert.deepEqual(
    Object.values(projection).filter((value) => value === null).length,
    1,
    'exactly one null, and it is on a key the formula reads',
  );
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
});

test('a component outside its range is unreadable, which is a reversal of the previous boundary', () => {
  // WHY THIS BOUNDARY MOVED. This test used to read 'a component that is out
  // of range but a real number stays readable', and it was pinned there on
  // purpose: the read rule used to answer only "is this a number the build can
  // print", so a stored pSuccess of 1.5 stayed on the wire even though
  // validateOpportunity rejects one on the way in. The read side and the write
  // side were two different rules, and the gap between them was reachable.
  //
  // It cost a real body. A stored value_micros of MAX_SAFE_INTEGER with a
  // pSuccess of 1.5 has all eight components readable — the arithmetic's own
  // MAX_SAFE_INTEGER product is not, so expectedContribution returned null
  // beside a fully-populated `components`. No client can reconcile those two.
  // Narrowing the read rule to the domain's own per-key rule removes the second
  // path to a null contribution rather than documenting it: a readable pSuccess
  // is in [0,1] and a readable value_micros is a non-negative safe integer, so
  // the product is always a safe integer and the guard is unreachable through
  // the wire. The cross-consumer theorem below is the regression guard.
  //
  // DO NOT MOVE IT BACK. If a future change needs the read path to be looser
  // than the write path again, the arithmetic's overflow guard has to be
  // revisited in the same change, and the wire contract with it.
  for (const [key, value] of [['pSuccess', 1.5], ['pSuccess', -1], ['fit', 2], ['downside', -1]]) {
    const record = storedRecord({ name: 'Out of range', [key]: value });
    assert.deepEqual(
      unreadableComponents(record),
      [key],
      `${key} ${value} is outside its range, so it is unreadable rather than merely wrong`,
    );
    assert.equal(readableComponents(record)[key], null, `${key}: and it does not stay on the wire`);
  }
  // A closed range, not "any positive number": both endpoints stay readable, so
  // this is a range rule and not a sign check.
  for (const value of [0, 1]) {
    const record = storedRecord({ name: 'Endpoint', pSuccess: value });
    assert.deepEqual(unreadableComponents(record), [], `pSuccess ${value} is a real probability`);
    assert.equal(readableComponents(record).pSuccess, value);
  }
  // The consequence for the record this ticket exists for: the contribution
  // now follows the component to null instead of reporting a number beside a
  // component the projection calls unknown.
  const overflow = storedRecord({ name: 'Overflow', value_micros: Number.MAX_SAFE_INTEGER, pSuccess: 1.5 });
  assert.equal(readableComponents(overflow).pSuccess, null);
  assert.equal(expectedContribution(readableComponents(overflow)), null, 'a null contribution, not a null beside eight readable numbers');
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
