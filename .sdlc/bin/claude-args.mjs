#!/usr/bin/env node
// Builds the claude_args string for one pipeline step.
//
//   node .sdlc/bin/claude-args.mjs plan_arbiter
//
// Every step is named and independently configurable — model, turn limit, tools — because
// the steps are not equally hard and a single global model is either wasteful on the easy
// ones or underpowered on the hard ones. Council members are steps like any other, so the
// proposer and the arbiter can run at different weights.

import { loadConfig, setOutput, die } from './lib/actions.js';

// Tools are a safety boundary, not a preference: a reviewer with Edit could rewrite the code
// it is judging, and a planner with Edit could implement instead of planning. These are not
// configurable for that reason.
const TOOLS = {
  plan:              'Bash,Read,Grep,Glob,Write',
  plan_proposer:     'Bash,Read,Grep,Glob,Write',
  plan_critic:       'Bash,Read,Grep,Glob,Write',
  plan_arbiter:      'Bash,Read,Grep,Glob,Write',
  plan_reviewer:     'Bash,Read,Grep,Glob,Write',
  debug:             'Bash,Read,Grep,Glob,Write',
  implement:         'Bash,Read,Edit,Write,Grep,Glob',
  review:            'Bash,Read,Grep,Glob',
  review_correctness:'Bash,Read,Grep,Glob,Write',
  review_design:     'Bash,Read,Grep,Glob,Write',
  qa:                'Bash,Read,Write,Grep,Glob',
  root_cause:        'Bash,Read,Write,Grep,Glob',
  // NO Edit, deliberately. The agent that diagnoses a failure must not also be the agent that
  // makes the evidence disappear — and a framework defect it could patch itself would leave
  // nothing behind to audit.
  triage:            'Bash,Read,Grep,Glob,Write',
  librarian:         'Bash,Read,Edit,Write,Grep,Glob',
  release:           'Bash,Read,Edit,Write',
  maintainer:        'Bash,Read,Grep,Glob,Write',
  // Read-only plus Write for its own artifact. A router with Edit could change the code it is
  // deciding a route through, and a router that can post is a router that can approve itself.
  router:            'Bash,Read,Grep,Glob,Write',
  // Read and Write only. A project planner with Edit would start building the thing it is
  // supposed to be deciding, and the whole point of the gate is that nothing exists yet.
  // WebSearch and WebFetch, because this is the one agent whose decisions are mostly about
  // things that are not in the repository: which library is maintained, what a provider's API
  // actually supports today, what the current version of a runtime is. It was asked to decide a
  // stack for the life of a project with no way to look anything up, so it decided from memory
  // — and a model's memory of a fast-moving ecosystem is a year stale by construction.
  //
  // Still no Edit: it writes one artifact and a script does the rest. Web content it reads is
  // data, never instruction, which its pack states and the prompt repeats.
  project:           'Bash,Read,Grep,Glob,Write,WebSearch,WebFetch',
};

const DEFAULT_TURNS = {
  plan: 40, plan_proposer: 40, plan_critic: 40, plan_arbiter: 40, plan_reviewer: 30,
  debug: 60, implement: 60,
  review: 40, review_correctness: 40, review_design: 40,
  qa: 120, root_cause: 40, triage: 40, librarian: 50, release: 25, maintainer: 60, router: 15, project: 50,
};

// A council member with no explicit setting inherits the stage's, so configuring just
// `plan: claude-opus-5` still does something sensible without listing every role.
const PARENT = {
  plan_proposer: 'plan', plan_critic: 'plan', plan_arbiter: 'plan', plan_reviewer: 'plan',
  review_correctness: 'review', review_design: 'review',
};

const role = process.argv[2];
if (!TOOLS[role]) die(`unknown step "${role}" — expected one of: ${Object.keys(TOOLS).join(', ')}`);

const cfg = await loadConfig();

/** Exact setting wins; otherwise inherit the parent stage; otherwise the built-in default. */
function setting(map, fallbacks) {
  if (!map || typeof map !== 'object') return typeof map === 'string' ? map : undefined;
  if (Object.prototype.hasOwnProperty.call(map, role)) return map[role];
  const parent = PARENT[role];
  if (parent && Object.prototype.hasOwnProperty.call(map, parent)) return map[parent];
  return fallbacks;
}

// 0, empty or absent means NO LIMIT, and that is the default on purpose.
//
// claude-code-action validates the turn count AFTER the run: the agent used 54 turns against
// a cap of 40, produced a valid work order, and the action threw it away. Paying for work and
// then discarding it is strictly worse than not capping. Runaway is already prevented by the
// ledger's attempt counter and the job's timeout-minutes, both of which stop work BEFORE it
// is paid for rather than after.
const configured = setting(cfg.runtime?.max_turns, undefined);
const turns = Number(configured) > 0 ? Number(configured) : 0;
const model = setting(cfg.runtime?.model, '') ?? '';

const args = [
  turns ? `--max-turns ${turns}` : '',
  `--allowedTools ${TOOLS[role]}`,
  model ? `--model ${model}` : '',
].filter(Boolean).join(' ');

setOutput('args', args);
setOutput('model', model || '(action default)');
setOutput('turns', turns ? String(turns) : '(no limit)');
