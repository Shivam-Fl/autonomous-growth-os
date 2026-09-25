#!/usr/bin/env node
// Refuses a work order that would touch paths a human reserved.
//
// Judged against the same rules as the diff guard — the framework's own reserved paths UNION
// the config's forbidden_paths — so an emptied config list reserves exactly as much as before,
// and a plan is refused for what its branch would be refused for later.
//
// `--reject`: run at the PLAN, where a reserved path is the planner's to take out. It passed the
// plan reviewer and was refused one stage later by the implementer's prepare job, which could
// only stop for a person (growth-os #42, and #20 before it): the planner had checked
// forbidden_paths, and never knew .sdlc/memory/** is reserved on every ticket branch. Refused
// there, it is kept as a rejected work order with the reason, the way check-split-criteria does,
// so the next planner corrects it.
import { readFileSync } from 'node:fs';
import { findForbidden, reservedRules } from './lib/guards.js';
import { loadConfig, flags, die, repo as repoOf } from './lib/actions.js';
import { rememberRejected } from './lib/artifact.js';
import { updateLedger } from './lib/state-io.js';

const { file, reject } = flags();
const raw = readFileSync(file, 'utf8');
const wo = JSON.parse(raw);
const cfg = await loadConfig();

const paths = [...(wo.files ?? []), ...(wo.tests ?? [])].map((f) => f.path);
// A work order is always for a ticket branch — never the project planner's or the Librarian's.
const hits = findForbidden(paths, reservedRules(cfg, process.env.HEAD_BRANCH ?? ''));

if (hits.length) {
  const list = hits.map((h) => '  ' + h.path + '  (matched ' + h.rule + ')').join('\n');
  if (reject && process.env.ISSUE) {
    const message = `work order touches reserved paths:\n${list}\nNo ticket may change these: .sdlc/memory/** is the ` +
      "Librarian's (it records what merged), the approved docs are the architecture's, and the framework is the " +
      "pipeline's. Plan the change without them, and say in risks what they would have needed.";
    await updateLedger(repoOf(), Number(process.env.ISSUE), (l) => {
      if (!l || !(l.approved_work_order || l.validated_work_order)) return null;
      const next = { ...l };
      delete next.approved_work_order;
      delete next.validated_work_order;
      return next;
    }).catch((e) => process.stdout.write(`::warning::could not drop the refused plan's stash: ${e.message}\n`));
    await rememberRejected(repoOf(), process.env.ISSUE, 'work-order', raw, [message]);
    die(message);
  }
  die('work order touches reserved paths:\n' + list + '\nA human must approve this.');
}
process.stdout.write('no forbidden paths (' + paths.length + ' checked)\n');
