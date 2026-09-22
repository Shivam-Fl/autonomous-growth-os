#!/usr/bin/env node
// Refuses a work order that would touch paths a human reserved.
import { readFileSync } from 'node:fs';
import { findForbidden } from './lib/guards.js';
import { loadConfig, flags, die } from './lib/actions.js';

const { file } = flags();
const wo = JSON.parse(readFileSync(file, 'utf8'));
const cfg = await loadConfig();

const paths = [...(wo.files ?? []), ...(wo.tests ?? [])].map((f) => f.path);
const hits = findForbidden(paths, cfg.forbidden_paths ?? []);

if (hits.length) {
  die('work order touches reserved paths:\n' +
      hits.map((h) => '  ' + h.path + '  (matched ' + h.rule + ')').join('\n') +
      '\nA human must approve this.');
}
process.stdout.write('no forbidden paths (' + paths.length + ' checked)\n');
