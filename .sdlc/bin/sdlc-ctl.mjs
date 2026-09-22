#!/usr/bin/env node
// The single entry point every workflow calls. One CLI beats ten composite actions:
// it is testable locally, it fails with a readable message, and the workflows stay thin.
//
//   node .sdlc/bin/sdlc-ctl.mjs <command> [--flag value]
//
// Every command that changes state goes through the ledger, so the kill switch, the budget
// caps and the lock are enforced in exactly one place rather than in each workflow.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { validate, formatErrors } from './lib/validate.js';
import { checkQaConsistency } from './lib/qa-consistency.js';
import { repair } from './lib/repair.js';
import { digest } from './lib/digest.js';
import { parseCommand } from './lib/commands.js';
import { gh, ghJson, noteError } from './lib/actions.js';
import {
  newLedger, transition, acquireLock, releaseLock, isLockStale,
  bumpAttempt, checkBudget, pathsCollide, STAGES, STATES,
} from './lib/ledger.js';
import {
  ensureStateBranch, readLedger, updateLedger, listLedgers,
} from './lib/state-io.js';

const ROOT = process.env.SDLC_ROOT ?? process.cwd();

// --- argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { command, flags };
}

function need(flags, name) {
  if (flags[name] === undefined) fail(`missing required flag --${name}`);
  return flags[name];
}

function fail(message) {
  process.stderr.write(`sdlc: ${message}\n`);
  noteError(message);
  process.exit(1);
}

// GitHub Actions step output, so a workflow can branch on the result.
function setOutput(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (process.env.GITHUB_OUTPUT) {
    const delim = `EOF_${Math.random().toString(36).slice(2)}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
  }
  process.stdout.write(`${key}=${v}\n`);
}

/**
 * js-yaml is imported LAZILY, on purpose.
 *
 * `guard` — the kill switch — is the first step of every workflow and runs BEFORE `npm ci`,
 * so that a disabled system skips the install entirely. A top-level import of any dependency
 * therefore breaks the one command that has to work when nothing else does. Keep this lazy.
 */
export async function loadConfig(root = ROOT) {
  const path = join(root, '.sdlc', 'config.yml');
  if (!existsSync(path)) fail(`no config at ${path} — run \`sdlc init\` first`);
  const { load: parseYaml } = await import('js-yaml');
  const cfg = parseYaml(readFileSync(path, 'utf8'));
  if (!cfg || typeof cfg !== 'object') fail('config.yml did not parse to an object');
  return cfg;
}

function loadSchema(name, root = ROOT) {
  const path = join(root, '.sdlc', 'schemas', `${name}.json`);
  if (!existsSync(path)) fail(`unknown schema "${name}"`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const repoOf = (flags) => flags.repo ?? process.env.GITHUB_REPOSITORY ?? fail('no --repo and no GITHUB_REPOSITORY');

// --- commands ---------------------------------------------------------------
const commands = {
  /** Kill switch. First step of every workflow. Exits non-zero when the system is off. */
  async guard() {
    if (String(process.env.SDLC_ENABLED ?? 'true').toLowerCase() === 'false') {
      process.stdout.write('SDLC_ENABLED is false — halting.\n');
      process.exit(78); // neutral: halt without marking the run failed
    }
    process.stdout.write('enabled\n');
  },

  /** Validate an agent artifact against its schema before anything downstream trusts it. */
  async validate(flags) {
    const schema = loadSchema(need(flags, 'schema'));
    const file = need(flags, 'file');

    // A missing artifact is the most common agent failure, and a raw ENOENT stack says
    // nothing about what went wrong: the agent ran, reported success, and wrote the file
    // somewhere else. Say that, and show what it did write.
    if (!existsSync(file)) {
      const { readdirSync } = await import('node:fs');
      const near = [];
      for (const dir of ['.', 'plan', 'review', '.sdlc']) {
        try {
          for (const f of readdirSync(dir)) if (f.endsWith('.json')) near.push(dir === '.' ? f : `${dir}/${f}`);
        } catch { /* directory does not exist */ }
      }
      fail(
        `the agent did not write ${file}.\n` +
        'It reported success, so it ran — it just put the file somewhere else, or never wrote one.\n' +
        (near.length ? `JSON files that do exist: ${near.join(', ')}` : 'No JSON files were written at all.'),
      );
    }
    let data = JSON.parse(readFileSync(file, 'utf8'));

    // Repair the cosmetic before judging the rest.
    //
    // A plan council's work — three agents, twenty minutes — was discarded because one prose
    // string was 513 characters against a limit of 500. Length caps and stray fields keep
    // artifacts readable; nothing downstream breaks when a sentence is trimmed, while throwing
    // the artifact away breaks everything downstream by definition. The strictness is kept for
    // claims, which is what it was for.
    const fixed = repair(schema, data);
    if (fixed.repairs.length) {
      data = fixed.data;
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
      process.stdout.write(
        `Repaired ${fixed.repairs.length} cosmetic issue(s) rather than rejecting the file:\n` +
        fixed.repairs.map((r) => `- ${r}`).join('\n') + '\n');
    }

    const shape = validate(schema, data);
    if (!shape.ok) {
      process.stdout.write(
        `Schema validation failed on something that cannot be mechanically fixed:\n${formatErrors(shape.errors)}\n`);
      noteError(`schema validation failed: ${formatErrors(shape.errors)}`);
      process.exit(1);
    }
    if (flags.schema === 'qa-report') {
      const honest = checkQaConsistency(data);
      if (!honest.ok) {
        process.stdout.write(`Report is internally inconsistent:\n${honest.errors.map((e) => `- ${e}`).join('\n')}\n`);
        noteError(`report is internally inconsistent: ${honest.errors.join('; ')}`);
        process.exit(1);
      }
    }
    process.stdout.write('valid\n');
  },

  /** Compact a CI log down to the lines that explain the failure. */
  async digest(flags) {
    const log = flags.file ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8');
    const d = digest(log);
    setOutput('findings', String(d.findings.length));
    setOutput('summary', d.summary);
  },

  /** Parse a privileged /sdlc command out of a comment. Authority comes from the author. */
  async command(flags) {
    const cfg = await loadConfig();
    const parsed = parseCommand(
      { body: need(flags, 'body'), author: flags.author, association: flags.association },
      cfg,
    );
    if (!parsed) { setOutput('command', ''); return; }
    setOutput('command', parsed.authorized ? parsed.command : '');
    setOutput('args', parsed.args.join(' '));
    setOutput('authorized', String(parsed.authorized));
    setOutput('reason', parsed.reason ?? '');
    setOutput('unconfigured', String(Boolean(parsed.unconfigured)));
    if (!parsed.authorized) process.stdout.write(`refused: ${parsed.reason}\n`);
  },

  /** Open the ledger for a new issue. Idempotent — a reopened issue keeps its history. */
  async init(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    await ensureStateBranch(repo);
    const { ledger } = await updateLedger(repo, issue, (existing) => existing ?? newLedger(issue));
    setOutput('state', ledger.state);
  },

  /** Move to a new state. Refuses illegal transitions rather than corrupting the machine. */
  async transition(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const to = need(flags, 'to');
    const { ledger } = await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const r = transition(base, to, { agent: flags.agent ?? 'system' });
      if (!r.ok) fail(r.reason);
      return r.ledger;
    });
    setOutput('state', ledger.state);
  },

  /**
   * Claim a state, as the stage that is running right now.
   *
   * `transition` is strict and exits non-zero on an illegal move, which is right when a
   * script is asserting an OUTCOME — "QA passed" must not be recordable from nowhere. It is
   * wrong for a stage announcing its own arrival: the review workflow died outright on
   * `illegal transition qa-fail -> review` and never reviewed anything, because the ledger
   * was stale, not because the review was invalid.
   *
   * A running stage is ground truth about where the issue is. So this records the state and
   * the labels, and downgrades a refusal to a warning instead of taking the stage down.
   */
  async advance(flags) {
    const { advance } = await import('./lib/advance.js');
    await advance(need(flags, 'issue'), need(flags, 'to'), { agent: flags.agent ?? 'system' });
  },

  /**
   * Record something that ALREADY HAPPENED, whatever the ledger expected.
   *
   * `transition` refuses an illegal move because the pipeline must not be able to record a
   * decision it did not earn — "QA passed" from nowhere is the claim this file exists to
   * prevent. But a merge is not a decision the ledger gets a vote on: GitHub is reporting a
   * fact, and a human who merges a PR while the ledger thinks QA is still running has not made
   * an error the ledger may veto.
   *
   * That veto stranded a real chain: a merged PR, an issue whose ledger refused to say so, and
   * four dependent issues that never woke because the wake step ran after the transition. The
   * strict path stays for decisions; this one exists for observations, and it records the
   * anomaly in the history rather than hiding that the state machine was surprised.
   */
  async reconcile(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const to = need(flags, 'to');
    const observed = flags.observed ?? 'observed externally';
    if (!STATES.includes(to)) fail(`unknown state "${to}"`);

    const { ledger } = await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const legal = transition(base, to, { agent: flags.agent ?? 'system' });
      if (legal.ok) return legal.ledger;
      return {
        ...base,
        state: to,
        updated_at: new Date().toISOString(),
        history: [...(base.history ?? []), {
          at: new Date().toISOString(),
          agent: flags.agent ?? 'system',
          action: `-> ${to} (reconciled from ${base.state}: ${observed})`,
        }].slice(-200),
      };
    });
    setOutput('state', ledger.state);
    process.stdout.write(`issue #${issue} reconciled to ${ledger.state}\n`);
  },

  /** Take the per-issue lock. Exits non-zero when another agent holds it. */
  async lock(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const agent = need(flags, 'agent');
    const cfg = await loadConfig();

    // Is whoever holds this still alive? A job GitHub cancelled — on its `timeout-minutes`,
    // or by hand — skips its `if: always()` unlock, so its lock outlives it and the TTL is
    // the only thing that ever frees it. The TTL has to exceed the longest job, so that wait
    // is now hours. Asking the run itself costs one API call and answers the actual question.
    const current = await readLedger(repo, issue).then((r) => r.ledger).catch(() => null);
    let holderIsDead = false;
    if (current?.owner && current.owner !== agent && current.lock_run) {
      const status = await ghJson(['api', `repos/${repo}/actions/runs/${current.lock_run}`])
        .then((r) => String(r.status ?? ''))
        .catch(() => '');            // unreadable is NOT dead — fall back to the TTL
      holderIsDead = status !== '' && status !== 'in_progress' && status !== 'queued'
        && status !== 'waiting' && status !== 'requested' && status !== 'pending';
    }

    let refused = null;
    let reclaimed = false;
    await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const r = acquireLock(base, agent, {
        ttlMinutes: cfg.limits?.lock_ttl_minutes ?? 45,
        runId: process.env.GITHUB_RUN_ID ?? null,
        holderIsDead,
      });
      if (!r.ok) { refused = r.reason; return null; }
      reclaimed = Boolean(r.reclaimed);
      return r.ledger;
    });
    if (refused) {
      process.stdout.write(`lock refused: ${refused}\n`);
      noteError(`lock refused: ${refused}`);
      process.exit(1);
    }
    if (reclaimed) process.stdout.write(`reclaimed the lock: run ${current.lock_run} is no longer running\n`);
    setOutput('locked', 'true');
  },

  async unlock(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const agent = flags.agent ?? 'system';

    // Release only what this caller holds. Every stage unlocks in an `if: always()` step, so a
    // stalled workflow's cleanup runs after the watchdog reclaimed the issue and a new stage
    // took it — and an unconditional release then freed the CURRENT owner's lock.
    let refused = null;
    await updateLedger(repo, issue, (l) => {
      if (!l) return null;
      const next = releaseLock(l, { agent, expect: flags.force ? null : agent });
      if (next.refused) { refused = next.refused; return null; }
      return next;
    });

    if (refused) {
      // Not an error: a late cleanup finding someone else in the chair is the system working.
      process.stdout.write(`::warning::not releasing — ${refused}\n`);
      setOutput('locked', 'true');
      return;
    }
    setOutput('locked', 'false');
  },

  /**
   * Consume an attempt and check the budget. Called on DISPATCH, before the agent runs, so a
   * crash-looping agent still terminates. Exits non-zero when the cap is hit.
   */
  async attempt(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const stage = need(flags, 'stage');
    const cfg = await loadConfig();
    let exceeded = null;

    const { ledger } = await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      const bumped = bumpAttempt(base, stage, { agent: flags.agent ?? stage });
      if (!bumped.ok) fail(bumped.reason);
      const budget = checkBudget(bumped.ledger, cfg.limits);
      if (!budget.ok) {
        exceeded = budget.reason;
        const stopped = transition(bumped.ledger, budget.terminal, { agent: 'watchdog' });
        return stopped.ok ? stopped.ledger : bumped.ledger;
      }
      return bumped.ledger;
    });

    setOutput('attempt', String(ledger.attempts?.[stage] ?? 0));
    if (exceeded) {
      // A budget stop is the pipeline deciding to stop permanently, and it used to leave no
      // trace anyone would see: this moved the LEDGER to budget-exceeded but never the label,
      // so the issue still read `sdlc:ci-green` — "proceeding" — while nothing would ever run
      // on it again. The only evidence was one red workflow run among dozens.
      //
      // That is this framework's own worst failure mode: you find out by noticing that nothing
      // happened. So the stop announces itself, on the issue, where the person who has to
      // decide something is looking.
      const { advance } = await import('./lib/advance.js');
      await advance(issue, 'budget-exceeded', { agent: 'system' }).catch(() => {});
      await gh(['issue', 'comment', String(issue), '--body',
        `## Stopped: ${exceeded}\n\n` +
        'Nothing further runs on this issue until a human decides.\n\n' +
        'The counter increments on **dispatch, not failure**, so this also catches an agent ' +
        'that kept crashing before it could do any work — and it counts re-runs a maintainer ' +
        'triggered by hand while debugging.\n\n' +
        `Resume with \`/sdlc retry ${stage === 'plan' ? 'planning' : 'implementing'}\`, which ` +
        'clears the counters, or `/sdlc stop` to leave it parked.',
      ]).catch(() => {});

      setOutput('exceeded', 'true');
      process.stdout.write(`budget exceeded: ${exceeded}\n`);
      noteError(`budget exceeded: ${exceeded}`);
      process.exit(1);
    }
    setOutput('exceeded', 'false');
  },

  /**
   * Clear the attempt counters so a budget-exceeded issue can proceed again.
   *
   * The budget deliberately counts DISPATCHES, not agent failures, so that a run failing
   * before the agent starts — a bad token, a missing secret — still terminates the loop
   * instead of retrying forever. The cost of that choice is that setup mistakes consume
   * budget too, so there has to be a way back. This is it: explicit, human-triggered, and
   * recorded in the history rather than silently zeroing state.
   */
  async reset(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const to = flags.to ?? 'planning';

    const { ledger } = await updateLedger(repo, issue, (l) => {
      if (!l) fail(`issue #${issue} has no ledger`);
      let next = releaseLock(l, { agent: 'human' });
      next = {
        ...next,
        attempts: Object.fromEntries(STAGES.map((st) => [st, 0])),
        budget: { ...next.budget, minutes: 0 },
        history: [...next.history, {
          at: new Date().toISOString(), agent: 'human',
          action: `budget reset (was ${JSON.stringify(l.attempts)})`,
        }],
      };
      // budget-exceeded only routes to needs-human, which routes anywhere.
      if (next.state === 'budget-exceeded') {
        next = transition(next, 'needs-human', { agent: 'human' }).ledger;
      }
      const moved = transition(next, to, { agent: 'human' });
      if (!moved.ok) fail(moved.reason);
      return moved.ledger;
    });

    setOutput('state', ledger.state);
    process.stdout.write(`attempts cleared; issue #${issue} is now ${ledger.state}\n`);
  },

  /** Record the PR number and the paths this issue is touching, for collision detection. */
  async link(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    await updateLedger(repo, issue, (l) => {
      const base = l ?? newLedger(issue);
      return {
        ...base,
        pr: flags.pr ? Number(flags.pr) : base.pr,
        // Which work order version the branch answers, so a re-run can tell finished work
        // from work that a revised plan has made stale.
        implemented_version: flags['implemented-version']
          ? Number(flags['implemented-version'])
          : base.implemented_version,
        touch_paths: flags.paths ? String(flags.paths).split(',').map((s) => s.trim()).filter(Boolean) : base.touch_paths,
      };
    });
    setOutput('linked', 'true');
  },

  /** Would dispatching this issue collide with another issue already in flight? */
  async collisions(flags) {
    const repo = repoOf(flags);
    const issue = Number(need(flags, 'issue'));
    const { ledger } = await readLedger(repo, issue);
    if (!ledger?.touch_paths?.length) { setOutput('collides_with', ''); return; }

    const others = (await listLedgers(repo)).filter((n) => n !== issue);
    const hits = [];
    for (const other of others) {
      const { ledger: o } = await readLedger(repo, other);
      const active = o && !['done', 'needs-human', 'budget-exceeded', 'triage'].includes(o.state);
      if (active && pathsCollide(ledger.touch_paths, o.touch_paths ?? [])) hits.push(other);
    }
    setOutput('collides_with', hits.join(','));
  },

  /** Sweep every open ledger: reclaim stale locks, trip budgets, surface stalls. */
  async watchdog(flags) {
    const repo = repoOf(flags);
    const cfg = await loadConfig();
    const now = new Date();
    const report = { reclaimed: [], exceeded: [], stalled: [] };

    for (const issue of await listLedgers(repo)) {
      await updateLedger(repo, issue, (l) => {
        if (!l || ['done', 'needs-human', 'budget-exceeded'].includes(l.state)) return null;
        let next = l;
        let changed = false;

        if (isLockStale(next, now)) {
          report.reclaimed.push(issue);
          next = releaseLock(next, { agent: 'watchdog' });
          changed = true;
        }
        const budget = checkBudget(next, cfg.limits);
        if (!budget.ok) {
          report.exceeded.push({ issue, reason: budget.reason });
          const stopped = transition(next, budget.terminal, { agent: 'watchdog' });
          if (stopped.ok) { next = stopped.ledger; changed = true; }
        }
        // Waiting is not stalling.
        //
        // An issue parked on an open dependency, or queued behind the in-flight cap, is doing
        // exactly what it should and will do it for as long as the thing ahead of it takes.
        // Reporting that as "no progress for 9h" every fifteen minutes buries the issues that
        // really are stuck — it posted six such comments on three correctly-parked tickets
        // while saying nothing about the two that could not start at all.
        const idleHours = (now - new Date(next.updated_at)) / 3_600_000;
        const parked = ['blocked', 'queued'].includes(next.state)
          || (next.blocked_on ?? []).length > 0;
        if (!parked && idleHours > (cfg.limits?.stall_hours ?? 6)) {
          report.stalled.push({ issue, hours: Math.round(idleHours) });
        }
        return changed ? next : null;
      });
    }
    setOutput('report', report);
  },

  async status(flags) {
    const repo = repoOf(flags);
    if (flags.issue) {
      const { ledger } = await readLedger(repo, Number(flags.issue));
      process.stdout.write(JSON.stringify(ledger, null, 2) + '\n');
      return;
    }
    for (const issue of await listLedgers(repo)) {
      const { ledger } = await readLedger(repo, issue);
      process.stdout.write(
        `#${issue}\t${ledger.state}\t${ledger.owner ?? '-'}\tqa:${ledger.attempts?.qa ?? 0}\n`,
      );
    }
  },
};

// --- entry ------------------------------------------------------------------
const { command, flags } = parseArgs(process.argv.slice(2));
if (!command || !commands[command]) {
  process.stderr.write(`usage: sdlc-ctl <${Object.keys(commands).join('|')}> [--flags]\n`);
  process.exit(1);
}
commands[command](flags).catch((e) => fail(e.stack ?? e.message));
