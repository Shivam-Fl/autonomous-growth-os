#!/usr/bin/env node
// Numbers the spec, section by section, so every section has to be accounted for.
//
// A 44-section spec was handed to the project planner as "read the issue", and came back as
// one brief whose lists are capped: forty requirements, twenty-five scope lines. Whatever did
// not fit was not refused or deferred — it was absent, and nothing could tell. So a script
// numbers the spec before the planner sees it (S-1..S-n, by `#` and `##` heading), the brief
// has to give every number a disposition, and apply-project-brief refuses one that does not.
//
// Where the spec is: `spec.paths` in config (files, or directories of .md), defaulting to
// docs/spec and SPEC.md; when none of them exists, the project issue itself is the spec.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghJson, loadConfig, setOutput, die } from './lib/actions.js';
import { specSections } from './lib/project.js';
import { DECISIONS_HEADING, SPLIT_CRITERIA_HEADING } from './lib/issue-body.js';

const cfg = await loadConfig().catch(() => ({}));
const paths = cfg.spec?.paths ?? ['docs/spec', 'SPEC.md'];

const files = [];
const walk = (p) => {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p).sort()) walk(join(p, f));
  } else if (/\.md$/i.test(p) || paths.includes(p)) files.push(p);
};
for (const p of paths) walk(p);

// The sections of an issue body the pipeline writes, which are not the spec. `/sdlc answer` on
// the brief writes the Decisions section before re-running this stage, and it was numbered as a
// new S-(n+1) the revised brief had no disposition for — so apply-project-brief refused the
// answer's brief, at the cost of a whole planning run. Blanked rather than cut, so every line
// number after them still points at the body's own line.
const PIPELINE_SECTIONS = [DECISIONS_HEADING, SPLIT_CRITERIA_HEADING];
const withoutPipelineSections = (body) => {
  let theirs = false;
  return String(body ?? '').split('\n').map((l) => {
    if (/^#{1,2} /.test(l)) theirs = PIPELINE_SECTIONS.includes(l.trim());
    return theirs ? '' : l;
  }).join('\n');
};

let sections = files.flatMap((f) => specSections(readFileSync(f, 'utf8'), f));
if (!files.length) {
  const issue = process.env.ISSUE ?? die('no spec files and no ISSUE to read the spec from');
  const { title, body } = await ghJson(['issue', 'view', String(issue), '--json', 'title,body']);
  sections = specSections(withoutPipelineSections(body), `issue #${issue}`)
    .map((s) => (s.title === `issue #${issue}` ? { ...s, title } : s));
}

const index = { sections: sections.map((s, i) => ({ id: `S-${i + 1}`, ...s })) };
writeFileSync('spec-index.json', `${JSON.stringify(index, null, 2)}\n`);
setOutput('sections', String(index.sections.length));
process.stdout.write(`${index.sections.length} spec section(s) from ${files.length ? files.join(', ') : `issue #${process.env.ISSUE}`}\n`);
