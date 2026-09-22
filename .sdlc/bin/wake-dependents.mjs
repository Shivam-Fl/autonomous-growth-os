#!/usr/bin/env node
// Starts whatever was waiting on an issue that just closed.
//
// The other half of dependency handling. Intake parks an issue whose dependencies are open;
// this wakes it when they close. Deliberately not a queue — there is no central state, so
// there is nothing to own and nothing to get stuck. Each issue only ever answers a question
// about itself.
import { gh, ghJson, setOutput } from './lib/actions.js';
import { unblockedBy, findCycle, dependenciesOf, finishedEpics, childrenOf, inFlight, readyButNotStarted } from './lib/deps.js';
import { loadConfig } from './lib/actions.js';
import { advance } from './lib/advance.js';

// CLOSED_ISSUE is optional. A slot frees when an issue MERGES, and also when one stops at a
// human gate, exceeds its budget, or is closed by hand — and only the first of those runs any
// code. The two slots on this repo went to issues that both stopped at human gates without
// ever claiming a lock; neither could close without a person, so no merge could happen, so
// nothing re-offered the queue, so two ready issues sat behind a slot nobody was holding.
//
// Without it, this is top-up only: re-offer whatever is ready, up to the cap.
const closed = Number(process.env.CLOSED_ISSUE) || null;

// `labels` is load-bearing, not decoration: finishedEpics identifies an epic BY its label,
// so without this field every issue reads as "not an epic" and the whole epic-closing block
// below is dead code that looks like working code. The block was written to fix exactly the
// bug it then could not fix.
const issues = (await ghJson(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,state,body,labels']))
  .map((i) => ({ ...i, state: i.state.toLowerCase() }));

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
const running = inFlight(issues);
let slots = cap > 0 ? Math.max(0, cap - running) : Infinity;

// Whose dependency just closed comes first — they have been waiting longest and it is the
// event that brought us here. Then top up from anything else already startable, because
// `unblockedBy` only ever answers this one question: an issue passed over for lack of a slot
// would never be offered again.
const queue = [
  ...(closed ? unblockedBy(closed, issues) : []),
  ...readyButNotStarted(issues).filter((n) => n !== closed),
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

if (deferred.length) {
  process.stdout.write(`queued (cap ${cap}, ${running} already running): ${deferred.map((n) => `#${n}`).join(', ')}\n`);
  // Said on each one, because an issue that is ready and not running looks exactly like an
  // issue nobody noticed — which is the thing this framework keeps being bitten by.
  for (const n of deferred) {
    // Say what is actually true. This used to read "0 issue(s) are already mid-pipeline"
    // while deferring — because `running` was measured before this invocation woke anything —
    // and then promised a slot would free when the issue in front finished, on a repo where
    // the things ahead of it had stopped at human gates and would never finish at all.
    const ahead = cap - slots;
    await gh(['issue', 'comment', String(n), '--body',
      `Ready to start, waiting for a slot. \`limits.max_in_flight\` is ${cap} and ${ahead} ` +
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
// Iterated, because closing epic A can finish epic B that was only waiting on A.
for (let pass = 0; pass < 5; pass++) {
  const open = issues.filter((i) => i.state === 'open');
  const done = finishedEpics(issues);
  if (!done.length) break;

  for (const epic of done) {
    const kids = childrenOf(epic, issues).map((n) => `#${n}`).join(', ');
    await gh(['issue', 'comment', String(epic), '--body',
      `Every issue in this epic has closed (${kids}). Closing it as done.\n\n` +
      'An epic is a tracker: it is never planned or implemented itself, so "finished" means ' +
      'its children are. Anything waiting on this epic starts now.']).catch(() => {});
    await gh(['issue', 'close', String(epic), '--reason', 'completed']).catch(() => {});
    process.stdout.write(`closed finished epic #${epic}\n`);

    // Reflect it locally so the next pass — and unblockedBy — see a closed epic.
    const row = issues.find((i) => i.number === epic);
    if (row) row.state = 'closed';

    for (const n of unblockedBy(epic, issues)) {
      await wake(n, `Epic #${epic} is complete, and that was the last thing this was waiting on. Starting now.`);
    }
  }
  void open;
}

setOutput('woken', String(woken));
if (!woken) {
  process.stdout.write(closed
    ? `nothing was waiting on #${closed}\n`
    : `nothing to start: ${running} of ${cap} slot(s) in use, ${deferred.length} queued\n`);
}
