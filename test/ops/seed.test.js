// Seeding a database that holds an opportunity record this build cannot read
// (issue #40): the seed is idempotent by fixed id and never rewrites a stored
// row, so a pre-micros-rename record is unreachable by re-seeding. It used to
// be silently left alone and the run reported a clean no-op over data the rest
// of the app renders as '—'. It must fail loudly and name the recovery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { seed } from '../../scripts/seed.js';

const TENANT = 'tenant_demo';

// The record a build before the micros rename wrote: money under value/cost,
// with no value_micros/cost_micros to read.
const PRE_RENAME_RECORD = {
  name: 'Expensive high-quality campaign',
  value: 6000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost: 1900, downside: 2, delay: 1,
};

function freshDbPath(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'app.db');
}

function reposFor(dbPath) {
  return createRepositories(openDatabase(dbPath));
}

/** Overwrite a seed row's stored record in place, exactly as an operator
 * upgrading across the rename — or a build other than this one writing a
 * different shape — would find it. The opportunities table carries no
 * immutability trigger — it is deliberately mutable working state. */
function plantRecord(dbPath, opportunityId, record) {
  const db = openDatabase(dbPath);
  db.prepare('UPDATE opportunities SET record = ? WHERE tenant_id = ? AND opportunity_id = ?')
    .run(JSON.stringify(record), TENANT, opportunityId);
  db.close();
}

function plantPreRenameRecord(dbPath, opportunityId) {
  plantRecord(dbPath, opportunityId, PRE_RENAME_RECORD);
}

test('a fresh database seeds the three opportunities and reports them', () => {
  const dbPath = freshDbPath('seed-fresh-');
  const result = seed({ dbPath });
  assert.equal(result.opportunitiesWritten, 3);
  assert.equal(result.experimentsWritten, 2);
  assert.equal(result.alreadySeeded, false);
  assert.deepEqual(
    reposFor(dbPath).opportunities.list(TENANT).map((row) => row.opportunity_id),
    ['opp_seed_expensive', 'opp_seed_cheap', 'opp_seed_low'],
  );
});

test('re-seeding a healthy database is still a clean idempotent no-op', () => {
  // The stale-row throw must not break an ordinary repeat run: the stored rows
  // are current-shape and readable, so nothing is thrown and nothing is written.
  const dbPath = freshDbPath('seed-idempotent-');
  const first = seed({ dbPath });
  assert.equal(first.opportunitiesWritten, 3);

  const second = seed({ dbPath });
  assert.equal(second.opportunitiesWritten, 0, 'the fixed ids deduplicate');
  assert.equal(second.experimentsWritten, 0);
  assert.equal(second.appended, 0);
  assert.equal(second.alreadySeeded, true, 'and the run still reports itself as already seeded');
  assert.equal(reposFor(dbPath).opportunities.list(TENANT).length, 3);
});

test('a pre-rename row makes the seed throw OPP_STALE_RECORD and name the recovery', () => {
  const dbPath = freshDbPath('seed-stale-');
  seed({ dbPath });
  plantPreRenameRecord(dbPath, 'opp_seed_expensive');

  let thrown = null;
  try {
    seed({ dbPath });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'the re-seed must not exit cleanly over an unreadable row');
  assert.equal(thrown.code, 'OPP_STALE_RECORD', 'a stable code, per the {code,message,details} convention');
  // The code is in the message too: an uncaught throw prints message and stack
  // and never `.code`, and this is the only guidance the operator gets.
  assert.match(thrown.message, /^OPP_STALE_RECORD/, 'the printed message names the code');
  assert.match(thrown.message, /opp_seed_expensive/, 'the message names the row that is the problem');
  // Pinned to the RULE, not to one symptom of it. The message used to claim
  // the record "predates the micros rename", which is a guess about the cause
  // and wrong for every shape except the one it was written for — a record
  // missing pSuccess did not come from the rename either. So the message names
  // the components it could not read and the rule they failed, and this
  // assertion follows it there. Weakening it to a bare code check, or dropping
  // it, would let the next person to change the wording delete the test
  // instead of fixing it.
  for (const key of ['value_micros', 'cost_micros']) {
    assert.match(thrown.message, new RegExp(key), `the message names ${key}, the component this build cannot read`);
  }
  assert.match(thrown.message, /non-negative integer number of micros/, 'and states the rule those components failed');
  assert.match(thrown.message, /delete the database and re-seed/i, 'and the recovery that actually works');
  assert.equal(thrown.details.opportunity_id, 'opp_seed_expensive');
  assert.deepEqual(
    thrown.details.unreadable_components,
    ['value_micros', 'cost_micros'],
    'details name exactly the keys that are wrong, so a hardcoded field cannot pass',
  );
});

test('a record this build cannot read for a NON-money reason also throws, and names the component', () => {
  // BUG-3: the guard checked two of the eight components, so a record whose
  // only damage is a missing pSuccess sailed past it and the run reported
  // "already present, nothing new written" — a clean exit-0 no-op over a row
  // the rest of the app renders as '—' and the API reports as null. That is
  // the exact shape QA planted, and it is the shape a guard written against
  // the pre-rename key order cannot see.
  const dbPath = freshDbPath('seed-stale-nopsuccess-');
  seed({ dbPath });

  const { pSuccess, ...withoutSuccess } = JSON.parse(
    openDatabase(dbPath).prepare("SELECT record FROM opportunities WHERE opportunity_id = 'opp_seed_expensive'").get().record,
  );
  plantRecord(dbPath, 'opp_seed_expensive', { ...withoutSuccess, name: 'No success probability' });

  let thrown = null;
  try {
    seed({ dbPath });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'the re-seed must not exit cleanly over a record missing pSuccess');
  assert.equal(thrown.code, 'OPP_STALE_RECORD');
  assert.match(thrown.message, /opp_seed_expensive/);
  assert.match(thrown.message, /pSuccess/, 'the message names the component that is actually unreadable');
  assert.doesNotMatch(
    thrown.message,
    /micros rename/,
    'and does not assert a cause it cannot know: a missing pSuccess did not come from the rename',
  );
  assert.deepEqual(thrown.details.unreadable_components, ['pSuccess'], 'both money keys are fine, so only this one is named');
});

test('a money component this build cannot stand behind also throws, whichever way it is wrong', () => {
  // The other non-pre-rename shape: money the rest of the app calls unknown.
  // A guard that only tested the pre-rename key ORDER would pass this and
  // still ship the bug, so both are pinned.
  for (const [label, money, unreadable] of [
    ['a fractional rupee', { value_micros: 5_000_000.5, cost_micros: 1_000_000.5 }, ['value_micros', 'cost_micros']],
    ['a negative amount', { value_micros: -1_000_000 }, ['value_micros']],
    ['a numeric string', { value_micros: '2000000000' }, ['value_micros']],
  ]) {
    const dbPath = freshDbPath('seed-stale-money-');
    seed({ dbPath });
    const stored = JSON.parse(
      openDatabase(dbPath).prepare("SELECT record FROM opportunities WHERE opportunity_id = 'opp_seed_expensive'").get().record,
    );
    plantRecord(dbPath, 'opp_seed_expensive', { ...stored, ...money });

    let thrown = null;
    try {
      seed({ dbPath });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `${label} must not re-seed as a clean no-op`);
    assert.equal(thrown.code, 'OPP_STALE_RECORD', label);
    assert.match(thrown.message, /value_micros/, `${label}: the message names value_micros`);
    assert.deepEqual(thrown.details.unreadable_components, unreadable, `${label}: and names exactly the keys that are wrong`);
  }
});

test('the throw is loud, not atomic: earlier phases stay committed and later ones never run', () => {
  // The seed is not transactional and this change does not make it so, so the
  // test asserts what is actually true rather than a tidy "nothing was
  // written": by the time seedOpportunities runs, everything before it has
  // committed, and the opportunity candidates after the throwing one are the
  // only things left unwritten.
  const dbPath = freshDbPath('seed-stale-partial-');
  seed({ dbPath });
  plantPreRenameRecord(dbPath, 'opp_seed_expensive');
  // Drop what the throwing run would otherwise have written — the candidates
  // after the throwing one, and both experiments — so "the throw stopped the
  // seed there" is distinguishable from "those rows were already there".
  const db = openDatabase(dbPath);
  db.prepare('DELETE FROM opportunities WHERE opportunity_id IN (?, ?)').run('opp_seed_cheap', 'opp_seed_low');
  db.prepare('DELETE FROM experiments').run();
  db.close();

  assert.throws(() => seed({ dbPath }), (error) => error.code === 'OPP_STALE_RECORD');

  const repos = reposFor(dbPath);
  const opportunities = repos.opportunities.list(TENANT);
  assert.deepEqual(
    opportunities.map((row) => row.opportunity_id),
    ['opp_seed_expensive'],
    'the candidate after the throwing one was never written',
  );
  assert.deepEqual(
    opportunities[0].record,
    PRE_RENAME_RECORD,
    'and the stale row itself is untouched on disk — the seed cannot rewrite it',
  );
  assert.equal(opportunities[0].components.value_micros, null, 'which is exactly why the seed refuses to run');

  // Everything before seedOpportunities is committed, by design.
  assert.ok(repos.tenants.get(TENANT), 'the tenant is committed');
  assert.equal(repos.rawEvents.list(TENANT, { limit: 200 }).length, 13, 'the 13 events are committed');
  assert.ok(repos.auditEvents.list(TENANT).length > 0, 'the seed.run audit event is committed');
  assert.equal(repos.learnings.listForContext(TENANT, { tenant: TENANT }).length, 2, 'the 2 learnings are committed');
  assert.equal(repos.decisions.list(TENANT).length, 3, 'the 3 decisions are committed');
  assert.equal(repos.snapshots.list(TENANT).length, 1, 'the snapshot is committed');
  assert.ok(repos.derived.list(TENANT).length > 0, 'the derived replay is committed');

  // And seedExperiments, which runs after seedOpportunities, never ran at all.
  assert.deepEqual(repos.experiments.list(TENANT), [], 'the experiment phase is unreachable from a throwing seed');
});

test('the stale-row throw is deterministic, not a one-shot', () => {
  // An operator who retries must not get a false clean no-op on the second
  // attempt: the throw fires on every run over a stale row.
  const dbPath = freshDbPath('seed-stale-repeat-');
  seed({ dbPath });
  plantPreRenameRecord(dbPath, 'opp_seed_expensive');

  for (const attempt of [1, 2, 3]) {
    assert.throws(
      () => seed({ dbPath }),
      (error) => {
        assert.equal(error.code, 'OPP_STALE_RECORD', `attempt ${attempt}`);
        assert.match(error.message, /opp_seed_expensive/);
        return true;
      },
    );
  }
  assert.equal(reposFor(dbPath).opportunities.list(TENANT).length, 3, 'the retry wrote nothing new');
});

test('a current-shape database seeds and re-seeds without throwing', () => {
  // The counterpart: only a record this build cannot read is fatal. Every
  // ordinary run — fresh or repeated, seeded or re-seeded — stays green.
  const dbPath = freshDbPath('seed-current-');
  seed({ dbPath });
  const before = reposFor(dbPath).opportunities.list(TENANT).map((row) => row.score);

  const again = seed({ dbPath });
  assert.equal(again.alreadySeeded, true);
  assert.equal(again.opportunitiesWritten, 0);
  assert.deepEqual(
    reposFor(dbPath).opportunities.list(TENANT).map((row) => row.score),
    before,
    'the seeded scores are byte-identical to what the first run wrote',
  );
});
