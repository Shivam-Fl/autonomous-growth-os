#!/usr/bin/env node
// Turns the watchdog sweep into comments. Only speaks when something needs a human.
import { gh } from './lib/actions.js';
import { advance } from './lib/advance.js';

const report = JSON.parse(process.env.REPORT || '{}');

for (const { issue, reason } of report.exceeded ?? []) {
  await gh(['issue', 'comment', String(issue), '--body',
    '## Budget exceeded\n\n' + reason + '\n\n' +
    'Stopped automatically. Nothing further runs on this issue until a human decides.\n' +
    'The attempt counter increments on dispatch, so this also catches an agent that kept ' +
    'crashing before it could do any work.\n\n' +
    'Resume with `/sdlc retry`, or `/sdlc stop` to leave it parked.']);
  await advance(issue, 'budget-exceeded', { agent: 'watchdog' });
}

for (const { issue, hours } of report.stalled ?? []) {
  await gh(['issue', 'comment', String(issue), '--body',
    'No progress for ' + hours + 'h. The lock is free and the state has not moved — ' +
    'something probably failed without reporting. Worth a look.']);
}

if (report.reclaimed?.length) {
  process.stdout.write('reclaimed stale locks on: ' + report.reclaimed.join(', ') + '\n');
}
process.stdout.write('watchdog: ' + (report.exceeded?.length ?? 0) + ' exceeded, ' +
  (report.stalled?.length ?? 0) + ' stalled, ' + (report.reclaimed?.length ?? 0) + ' locks reclaimed\n');
