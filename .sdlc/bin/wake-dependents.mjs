#!/usr/bin/env node
// Starts whatever was waiting on an issue that just closed.
//
// The other half of dependency handling. Intake parks an issue whose dependencies are open;
// this wakes it when they close. Deliberately not a queue — there is no central state, so
// there is nothing to own and nothing to get stuck. Each issue only ever answers a question
// about itself.
import { gh, ghJson, setOutput, loadConfig, trustedComments, isTrustedAuthor, repo as repoOf, switchedOff } from './lib/actions.js';
import { unblockedBy, findCycle, dependenciesOf, finishedEpics, childrenOf, inFlight, readyButNotStarted, isEpic, epicOf } from './lib/deps.js';
import { readLedger, updateLedger, listLedgers } from './lib/state-io.js';
import { advance } from './lib/advance.js';
import { coverageGap } from './lib/split.js';

// The owner's kill switch, as the guard exported it for the `always()` steps that still run after
// it. This dispatches intake with `gh workflow run` itself, not through dispatchStage, so nothing
// else would refuse it.
if (switchedOff()) {
  process.stdout.write('SDLC_ENABLED is "false" — waking nothing\n');
  process.exit(0);
}

const repo = repoOf();

// CLOSED_ISSUE is optional. A slot frees when an issue MERGES, and also when one stops at a
// human gate, exceeds its budget, or is closed by hand — and only the first of those runs any
// code. The two slots on this repo went to issues that both stopped at human gates without
// ever claiming a lock; neither could close without a person, so no merge could happen, so
// nothing re-offered the queue, so two ready issues sat behind a slot nobody was holding.
//
// Without it, this is top-up only: re-offer whatever is ready, up to the cap.
const closed = Number(process.env.CLOSED_ISSUE) || null;

// Every issue, not the newest hundred. `gh issue list --limit 100` made a long-closed dependency
// of a big project read as one that does not exist, so the newest work waited forever on the
// oldest. And `stateReason`, because "closed" alone counted an issue closed as NOT PLANNED as
// done: its dependents started against work nobody built, and its epic closed as complete.
//
// `labels` is load-bearing too: finishedEpics identifies an epic by its label, and a listing
// without it once made the whole epic-closing block below dead code that read as working code.
const issues = (await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=all&per_page=100`]))
  .flat()
  .filter((i) => !i.pull_request)
  .map((i) => ({
    number: i.number,
    state: String(i.state).toLowerCase(),
    stateReason: i.state_reason ? String(i.state_reason).toUpperCase() : null,
    body: i.body ?? '',
    labels: (i.labels ?? []).map((l) => ({ name: l.name ?? l })),
    // Who filed it: only the pipeline's and a trusted person's issues say what an epic delivered.
    author: i.user?.login ?? '',
    association: i.author_association ?? null,
  }));

// The merge that brought us here closed the issue a moment ago; the listing can still say open.
if (closed) {
  const row = issues.find((i) => i.number === closed);
  if (row?.state === 'open') Object.assign(row, { state: 'closed', stateReason: 'COMPLETED' });
}

// Which issues have a ledger — i.e. were ever taken by intake. A label alone is not a running
// stage: an issue an agent filed with `sdlc:triage` already on it carried the label and had
// never started, and two of those held both slots forever while nothing could start them.
//
// Through listLedgers(), the one listing of the state branch. This kept a copy of its own from
// when listLedgers answered [] on any error, and the copy is the one a fix to the listing (its
// 1,000-entry cap) would miss. listLedgers throws on a failed read now: an empty set means
// nothing is running, so only a missing branch may read as empty.
const ledgered = new Set(await listLedgers(repo));

// A cycle means nothing in it can ever start. That is a mistake in the split, and it should
// read as one rather than as work nobody got round to.
const cycle = findCycle(issues.filter((i) => i.state === 'open'));
if (cycle) {
  process.stdout.write(`dependency cycle: ${cycle.map((n) => `#${n}`).join(' -> ')}\n`);
  await gh(['issue', 'comment', String(cycle[0]), '--body',
    `These issues depend on each other in a loop: ${cycle.map((n) => `#${n}`).join(' → ')}\n\n` +
    'Nothing in the loop can ever start, so this is a mistake in the split rather than work ' +
    'that is merely waiting. Break the cycle by removing one dependency.']).catch(() => {});
}

let woken = 0;
const wake = async (n, why) => {
  try {
    // Through advance(), which is the only thing allowed to write a state label — the pair
    // came apart once before and every budget and lock is keyed off the ledger.
    //
    // It matters that this happens at WAKE time rather than when intake gets round to it:
    // until the issue carries an in-flight label, inFlight() reads it as idle, so a second
    // invocation half a minute later spends the same slot again. That is how three plan
    // councils started within 45 seconds against a cap of two.
    await advance(n, 'triage', { agent: 'watchdog' });
    ledgered.add(n);
    await gh(['issue', 'comment', String(n), '--body', why]);
    await gh(['workflow', 'run', 'sdlc-intake.yml', '-f', `issue=${n}`]);
    process.stdout.write(`woke #${n}\n`);
    woken++;
  } catch (e) {
    // Put the slot back.
    //
    // The label goes on BEFORE the dispatch so the issue counts against the cap immediately
    // — otherwise the next invocation spends the same slot. The cost of that order is this
    // case: a dispatch that fails leaves an issue marked in flight with nothing running, and
    // a cap held by two such issues can never free itself. It happened on the first live run
    // — the watchdog had no `actions: write`, so both wakes marked and then could not start.
    //
    // Reverting is the whole recovery. An issue back at `blocked` is offered again next
    // sweep; an issue stuck at `triage` is offered to nobody, forever.
    process.stdout.write(`could not wake #${n}: ${String(e.message).split('\n')[0]}\n`);
    await advance(n, 'blocked', { agent: 'watchdog' }).catch(() => {
      process.stdout.write(`::warning::#${n} is marked in flight but was never started — ` +
        'it holds a slot and nothing is running it. Set it back to sdlc:blocked by hand.\n');
    });
    slots++;
  }
};

// How many may run at once.
//
// Every agent stage in this framework runs on ONE token. The first fan-out woke eight issues
// from a single merge, they became ten concurrent model sessions, and the token was exhausted
// inside a minute — plan, review and implement all failing together with the same runtime
// error, on work nobody had found fault with. This is not a work-in-progress preference; it
// is how many agents the credentials can serve.
const cfg = await loadConfig().catch(() => ({}));
const cap = Number(cfg.limits?.max_in_flight ?? 2);
const running = inFlight(issues, ledgered);
let slots = cap > 0 ? Math.max(0, cap - running) : Infinity;

// Whose dependency just closed comes first — they have been waiting longest and it is the
// event that brought us here. Then top up from anything else already startable, because
// `unblockedBy` only ever answers this one question: an issue passed over for lack of a slot
// would never be offered again.
//
// Both through the one predicate that knows running from parked from startable: `unblockedBy`
// alone re-woke an issue whose dependency closed while it was already mid-pipeline.
const startable = readyButNotStarted(issues, ledgered);
const queue = [
  ...(closed ? unblockedBy(closed, issues) : []).filter((n) => startable.includes(n)),
  ...startable.filter((n) => n !== closed),
];
const seen = new Set();
const deferred = [];

for (const n of queue) {
  if (seen.has(n)) continue;
  seen.add(n);
  if (slots <= 0) { deferred.push(n); continue; }
  const waited = dependenciesOf(issues.find((i) => i.number === n)?.body ?? '').map((d) => `#${d}`).join(', ');
  await wake(n, closed
    ? `#${closed} is done, and that was the last thing this was waiting on. Starting now.` +
      (waited ? `\n\n_Was waiting on ${waited}._` : '')
    : 'A slot is free and everything this was waiting on is closed. Starting now.' +
      (waited ? `\n\n_Was waiting on ${waited}._` : ''));
  slots--;
}

const SLOT_NOTICE = 'Ready to start, waiting for a slot.';
if (deferred.length) {
  process.stdout.write(`queued (cap ${cap}, ${running} already running): ${deferred.map((n) => `#${n}`).join(', ')}\n`);
  // Said on each one, because an issue that is ready and not running looks exactly like an
  // issue nobody noticed — which is the thing this framework keeps being bitten by.
  //
  // Said once, though. The watchdog runs this every fifteen minutes, and an issue queued for a
  // day collected ninety copies of the same sentence. The pipeline comments whenever it moves
  // an issue, so "its newest pipeline comment is already this notice" means nothing has
  // happened to it since it was last said.
  for (const n of deferred) {
    const said = await trustedComments('issue', n, cfg, { pipelineOnly: true })
      .then((cs) => cs.at(-1)?.body.startsWith(SLOT_NOTICE)).catch(() => false);
    if (said) continue;
    // Say what is actually true. This used to read "0 issue(s) are already mid-pipeline"
    // while deferring — because `running` was measured before this invocation woke anything —
    // and then promised a slot would free when the issue in front finished, on a repo where
    // the things ahead of it had stopped at human gates and would never finish at all.
    const ahead = cap - slots;
    await gh(['issue', 'comment', String(n), '--body',
      `${SLOT_NOTICE} \`limits.max_in_flight\` is ${cap} and ${ahead} ` +
      `issue(s) took the slots this round.\n\nEvery agent stage runs on one token, and running ` +
      'more than a few at once exhausts it, which fails work that was never wrong.\n\nThe ' +
      'watchdog re-offers this queue on a schedule, so this starts on its own once a slot is ' +
      'free — including when the issue ahead of it stops at a human gate rather than finishing. ' +
      '`/sdlc approve` jumps the queue.']).catch(() => {});
  }
  setOutput('queued', deferred.join(','));
}

// An epic whose children have all closed is finished, and nothing ever said so.
//
// start-split-issues posts "this epic closes when its children do" on every epic it splits,
// and that sentence described nothing: no code closed one. Harmless while a product has a
// single epic, which is every product this framework had been run against. The moment a
// second epic says "Depends on #<the first epic>", it waits forever — and a blocked issue
// looks exactly like an open one, so nobody finds out by looking.
//
// Its children are the ones the split recorded on its ledger, not whichever issues happen to
// say "Part of #N": a child whose body was reworded dropped out, and the epic then finished
// without it. Prose is the fallback only for an epic no split of ours recorded.
const epicLedgers = new Map();
for (const e of issues.filter((i) => i.state === 'open' && isEpic(i))) {
  epicLedgers.set(e.number, (await readLedger(repo, e.number)).ledger);
}
const children = new Map([...epicLedgers].map(([n, l]) => [n, l?.children?.length ? l.children : childrenOf(n, issues)]));

// A child closed as NOT PLANNED is a piece of the epic nobody built, so the epic stays open for
// a person to decide — and is told so once, not every sweep.
for (const [n, kids] of children) {
  const rows = kids.map((k) => issues.find((i) => i.number === k));
  if (!rows.length || rows.some((r) => !r || r.state !== 'closed')) continue;
  const unbuilt = rows.filter((r) => r.stateReason === 'NOT_PLANNED').map((r) => r.number);
  const l = epicLedgers.get(n);
  if (!unbuilt.length || !l || String(l.not_planned_noted ?? '') === String(unbuilt)) continue;
  await gh(['issue', 'comment', String(n), '--body',
    `Every issue in this epic has closed, but ${unbuilt.map((k) => `#${k}`).join(', ')} closed as ` +
    'not planned, so part of it was never built. It stays open until a person decides: reopen ' +
    'and finish what was dropped, file what replaces it, or close this epic by hand.']).catch(() => {});
  await updateLedger(repo, n, (x) => (x ? { ...x, not_planned_noted: unbuilt } : null)).catch(() => {});
}

// Finished children are not a finished epic when what the epic was FOR is not built: a piece
// whose issue was never created, or a requirement the epic promised and the split forgot,
// closed with the epic as if delivered. Everything it or its pieces cover must have been built
// by a completed piece, or left to a deferral by name. Said once per gap.
//
// An issue filed later counts only when the pipeline or a trusted person filed it. Any issue
// saying "Part of #5" did, whoever wrote it: on a public repository an outsider could file one
// covering whatever the split forgot, close it themselves as completed, and close the epic.
const byNumber = (n) => issues.find((i) => i.number === n);
const trusted = (i) => isTrustedAuthor({ login: i.author, association: i.association }, cfg);
const held = new Set();

// Iterated, because closing epic A can finish epic B that was only waiting on A.
for (let pass = 0; pass < 5; pass++) {
  const done = finishedEpics(issues, children).filter((e) => !held.has(e));
  if (!done.length) break;

  for (const epic of done) {
    const l = epicLedgers.get(epic);
    const gap = coverageGap(byNumber(epic)?.body ?? '', l?.breakdown ?? null, byNumber,
      issues.filter((i) => epicOf(i.body) === epic && trusted(i)));
    if (gap.length) {
      held.add(epic);
      if (l && String(l.coverage_gap_noted ?? '') !== String(gap)) {
        await gh(['issue', 'comment', String(epic), '--body',
          `Every issue in this epic has closed, and ${gap.join(', ')} ${gap.length === 1 ? 'is' : 'are'} ` +
          'still covered by none of them: no completed piece delivers it and no deferral names it. ' +
          `The epic stays open until something does: an issue saying \`Part of #${epic}\` with ` +
          'that `Covers:` line, closed as completed — or close the epic by hand if it is no ' +
          'longer owed.']).catch(() => {});
        await updateLedger(repo, epic, (x) => (x ? { ...x, coverage_gap_noted: gap } : null)).catch(() => {});
      }
      continue;
    }
    const kids = (children.get(epic) ?? []).map((n) => `#${n}`).join(', ');
    await gh(['issue', 'comment', String(epic), '--body',
      `Every issue in this epic has closed (${kids}). Closing it as done.\n\n` +
      'An epic is a tracker: it is never planned or implemented itself, so "finished" means ' +
      'its children are. Anything waiting on this epic starts now.']).catch(() => {});
    await gh(['issue', 'close', String(epic), '--reason', 'completed']).catch(() => {});
    process.stdout.write(`closed finished epic #${epic}\n`);

    // Reflect it locally so the next pass — and unblockedBy — see a closed epic.
    const row = issues.find((i) => i.number === epic);
    if (row) Object.assign(row, { state: 'closed', stateReason: 'COMPLETED' });

    for (const n of unblockedBy(epic, issues).filter((d) => readyButNotStarted(issues, ledgered).includes(d))) {
      await wake(n, `Epic #${epic} is complete, and that was the last thing this was waiting on. Starting now.`);
    }
  }
}

setOutput('woken', String(woken));
if (!woken) {
  process.stdout.write(closed
    ? `nothing was waiting on #${closed}\n`
    : `nothing to start: ${running} of ${cap} slot(s) in use, ${deferred.length} queued\n`);
}
