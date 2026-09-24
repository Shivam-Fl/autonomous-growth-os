#!/usr/bin/env node
// Turns the watchdog sweep into comments. Only speaks when something needs a human.
import { gh } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { retryHint } from './lib/flow-graph.js';

const report = JSON.parse(process.env.REPORT || '{}');

// One issue's failure is that issue's, never the report's. An advance the ledger refused threw
// out of the loop, and every exceeded and stalled entry after it was never posted — while the
// sweep had already written their `stall_reported_for`, so those stalls were never said at all.
const each = async (items, say) => {
  for (const item of items ?? []) {
    await say(item).catch((e) => process.stdout.write(
      `::warning::issue #${item.issue}: could not report it — ${String(e.message).split('\n')[0]}\n`));
  }
};

await each(report.exceeded, async ({ issue, reason, counter }) => {
  await gh(['issue', 'comment', String(issue), '--body',
    '## Budget exceeded\n\n' + reason + '\n\n' +
    'Stopped automatically. Nothing further runs on this issue until a human decides.\n' +
    'The attempt counter increments on dispatch, so this also catches an agent that kept ' +
    'crashing before it could do any work.\n\n' +
    // The counter's own stage, as `sdlc-ctl attempt` prints it: a bare `/sdlc retry` names
    // nothing to resume. `planning` for the plan counter, which several stages spend.
    `Resume with ${counter ? retryHint(counter === 'plan' ? 'planning' : counter) : '`/sdlc retry <stage>`'}, ` +
    'or `/sdlc stop` to leave it parked.']);
  await advance(issue, 'budget-exceeded', { agent: 'watchdog' });
});

await each(report.stalled, async ({ issue, hours }) => {
  await gh(['issue', 'comment', String(issue), '--body',
    'No progress for ' + hours + 'h. The lock is free and the state has not moved — ' +
    'something probably failed without reporting. Worth a look.']);
});

if (report.reclaimed?.length) {
  process.stdout.write('reclaimed stale locks on: ' + report.reclaimed.join(', ') + '\n');
}
process.stdout.write('watchdog: ' + (report.exceeded?.length ?? 0) + ' exceeded, ' +
  (report.stalled?.length ?? 0) + ' stalled, ' + (report.reclaimed?.length ?? 0) + ' locks reclaimed\n');
