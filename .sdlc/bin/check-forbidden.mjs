#!/usr/bin/env node
// Refuses a work order that would touch paths a human reserved.
//
// Judged against the same rules as the diff guard — the framework's own reserved paths UNION
// the config's forbidden_paths — so an emptied config list reserves exactly as much as before,
// and a plan is refused for what its branch would be refused for later.
import { readFileSync } from 'node:fs';
import { findForbidden, reservedRules } from './lib/guards.js';
import { loadConfig, flags, die } from './lib/actions.js';

const { file } = flags();
const wo = JSON.parse(readFileSync(file, 'utf8'));
const cfg = await loadConfig();

const paths = [...(wo.files ?? []), ...(wo.tests ?? [])].map((f) => f.path);
// A work order is always for a ticket branch — never the project planner's or the Librarian's.
const hits = findForbidden(paths, reservedRules(cfg, process.env.HEAD_BRANCH ?? ''));

if (hits.length) {
  die('work order touches reserved paths:\n' +
      hits.map((h) => '  ' + h.path + '  (matched ' + h.rule + ')').join('\n') +
      '\nA human must approve this.');
}
process.stdout.write('no forbidden paths (' + paths.length + ' checked)\n');
