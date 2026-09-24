#!/usr/bin/env node
// Executes an authorized /sdlc command. parseCommand already proved the author may do this.
import { gh, ghJson, die, setOutput, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { routeOf, dispatchStage } from './lib/route-io.js';
import { updateLedger } from './lib/state-io.js';
import { newLedger } from './lib/ledger.js';
import { upsertDecisions } from './lib/issue-body.js';
import { resolveStage, retryHint, loadGraph } from './lib/flow-graph.js';
import { isStub } from './lib/project.js';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const cmd = process.env.COMMAND;
let issue = process.env.ISSUE;

// A command typed on a pull request is about the issue that PR belongs to.
//
// `issue_comment` fires for PR conversations too, and there `github.event.issue.number` is the
// PR's. So `/sdlc stop` on PR #40 wrote a ledger for "issue 40", put needs-human on the PR and
// said "Halted." while issue #12 carried on and the PR merged; `/sdlc approve` there ran intake
// on the PR as a brand-new ticket. The brief PR invites exactly these commands.
if (process.env.IS_PR === 'true') {
  const pr = issue;
  const d = await ghJson(['pr', 'view', pr, '--json', 'body,headRefName']).catch(() => ({}));
  const linked = String(d.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
    ?? String(d.headRefName ?? '').match(/^sdlc\/(?:issue|project)-(\d+)$/)?.[1];
  if (!linked) {
    await gh(['issue', 'comment', pr, '--body',
      'This pull request is not tied to an issue — no `Closes #N`, and not a pipeline branch — so ' +
      'nothing was done. Comment on the issue itself.']);
    process.stdout.write(`PR #${pr} belongs to no issue; nothing done\n`);
    process.exit(0);
  }
  issue = linked;
  await gh(['issue', 'comment', pr, '--body', `Acting on #${issue}, the issue this pull request belongs to.`])
    .catch(() => {});
  process.stdout.write(`PR #${pr}: acting on #${issue}\n`);
}
// Who decided it. A decision that outlives the thread has to say whose it was.
const author = process.env.COMMENT_AUTHOR ?? 'a maintainer';
const text = (process.env.ARGS ?? '').trim();
const ctl = (...args) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...args]);

// Parked, as opposed to running. A stage that stopped for a person leaves the issue in one of
// these, or at planning under the plan-review label; anything else is work in progress, and
// starting the same stage again there is a second copy on the same branch.
//
// `resume_at` used to be read as "waiting". Nothing cleared it once it was used, so after the
// architecture brief merged and on-merge started the maintainer, the brief's own instruction —
// "merge, then comment /sdlc approve" — split the epic a second time.
const PARKED = ['needs-human', 'budget-exceeded', 'blocked', 'qa-pass'];
const labelsOf = async () => (await gh(['issue', 'view', issue, '--json', 'labels', '--jq', '.labels[].name'])
  .catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
// No ledger at all is an issue intake has never taken, which is waiting on nothing but intake.
const waiting = (ledger, labels) => !ledger || PARKED.includes(ledger.state) || labels.includes('sdlc:plan-review');

// Why the last implement ran, for a re-entry of it. It lived only in the dispatch inputs, which
// a retry or an approve does not have, so a retried rework became a fresh build that ignored
// the review it was answering. dispatchStage keeps it on the ledger now; an older ledger falls
// back to what the state it stopped in implies.
const carried = (l) => (l?.pending?.stage === 'implement' ? l.pending.rework
  : l?.pr ? ({ review: 'review', qa: 'fix:qa-failed' }[l.state] ?? 'fix:retry') : null);

/** A stage name — or a state, or an alias — as the one resolver every dispatch uses reads it. */
function targetOf(name, ledger, { reentry = false } = {}) {
  const rework = reentry && ['implement', 'implementing'].includes(name) ? carried(ledger) : null;
  return resolveStage(name, { issue, pr: ledger?.pr ?? null, ledger, rework });
}

// Every resume goes through dispatchStage as a person: it is what lifts `/sdlc stop`, clears the
// resume point it is acting on, and records why the stage ran — in one ledger write, before
// anything is dispatched.
const start = (target, why, extra = {}) =>
  dispatchStage({ repo: repoOf(), issue, target, human: true, why, extra }).then((r) => r.dispatched);

/**
 * Write a person's decision into the Decisions section of the issue BODY — and of every open
 * child, when this is a split epic.
 *
 * Decisions lived in comment headings, "## Answered" and "## Route note from @x", and agents
 * were told to obey those. Anyone can post a comment with that heading on a public repository;
 * nobody but the author and the pipeline can edit a body. The ledger copy (`answers`,
 * `route_notes`) was written and read by nothing. And an answer on an epic never reached the
 * children planned after it, so two of them picked floats after the owner had said integer
 * paise. The comment stays, as the notification.
 */
async function recordDecision(kind, decided, at, ledger) {
  const entry = { kind, by: author, at, text: decided };
  for (const n of [Number(issue), ...(ledger?.children ?? []).map(Number)]) {
    try {
      const { body, state } = await ghJson(['issue', 'view', String(n), '--json', 'body,state']);
      if (n !== Number(issue) && String(state).toUpperCase() !== 'OPEN') continue;
      await gh(['issue', 'edit', String(n), '--body', upsertDecisions(body ?? '', [entry])]);
    } catch (e) {
      process.stdout.write(`::warning::could not record the ${kind} in #${n}'s body: ${String(e.message).split('\n')[0]}\n`);
    }
  }
}

/**
 * A redirect: the note on the ledger and in the body, and the old direction marked superseded.
 *
 * `replan_requested_at` is what merge-pr checks, so the PR built for the old direction cannot
 * merge while the new one is being worked out — QA on the old head used to finish first. A
 * person redirecting is also resuming, so a halt of theirs is lifted and the resume point it
 * replaces is cleared.
 *
 * And the plans stashed for the old direction are dropped, as reject drops them. An approved
 * plan whose post had failed was kept, plan-strategy posts an approved stash without asking what
 * came after it, and posting it cleared replan_requested_at: the old plan was rebuilt under a
 * new version and merge-pr's replan stop was disarmed.
 */
async function redirect(kind) {
  const at = new Date().toISOString();
  const { ledger } = await routeOf(repoOf(), issue);
  await updateLedger(repoOf(), Number(issue), (l) => {
    if (!l) return null;
    const next = {
      ...l, replan_requested_at: at, resume_at: null, stopped_at: null,
      route_notes: [...(l.route_notes ?? []), { by: author, at, kind, note: text.slice(0, 4000) }].slice(-40),
    };
    delete next.halted;
    delete next.approved_work_order;
    delete next.validated_work_order;
    return next;
  });
  if (text) await recordDecision(kind, text, at, ledger);
}

switch (cmd) {
  case 'approve': {
    // "Approved" used to mean exactly one thing — start the implementer — because there was
    // one gate and one chain. There are several gates now, and the route says what follows
    // each. The stage that stopped the issue recorded itself; this continues from there.
    const labels = await labelsOf();
    const { ledger } = await routeOf(repoOf(), issue);

    // Approving something that is not waiting is not a no-op — it is a second dispatch.
    //
    // A plan reviewer approved a work order and started the implementer; `/sdlc approve`
    // typed a moment later read `resume_at` and started a second one. Two implementers on
    // one branch is the exact race the per-issue lock exists to prevent, and the lock only
    // catches it after both jobs have already spun up a runner.
    //
    // A gate leaves the issue in a state that is plainly parked. Anything else is work in
    // progress, and the honest answer is to say so rather than to add to it — whatever a
    // leftover resume_at says.
    if (!waiting(ledger, labels)) {
      await gh(['issue', 'comment', issue, '--body',
        `Nothing is waiting: this issue is at \`${ledger.state}\` and running.\n\n` +
        'Approving here would start a second copy of that stage on the same branch, which is ' +
        'the race the per-issue lock exists to stop — and the lock only catches it after both ' +
        'runs have started. If it looks stuck, the watchdog reports a genuine stall; ' +
        '`/sdlc stop` halts it.']).catch(() => {});
      process.stdout.write(`issue #${issue}: already ${ledger.state} — nothing to approve\n`);
      setOutput('action', 'none');
      break;
    }
    await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:plan-review']).catch(() => {});

    // A spent budget is not lifted by approving: the stage would claim its next attempt, find
    // the cap still hit, and stop again at once. Clearing the counters is retry's job.
    if (ledger?.state === 'budget-exceeded') {
      const again = ledger.stopped_at ?? ledger.resume_at;
      await gh(['issue', 'comment', issue, '--body',
        'Nothing was started: this issue spent its attempt budget, and approving would stop it ' +
        `again on the next attempt. ${retryHint(again ?? 'implement')} clears the counters and ` +
        'runs it — or name the stage to run instead.']);
      break;
    }

    // The merge gate is the one where "continue the route" is the wrong reading: there is
    // nothing after QA to start, and the thing being approved is the merge itself. This used
    // to re-dispatch the implementer on code QA had just passed.
    if (ledger?.state === 'qa-pass' && ledger?.pr) {
      // Dispatched, never run here. merge-pr ran inline in this job, outside the merge-<pr>
      // concurrency group sdlc-qa's judge merges in, so a person's approve and the autonomous
      // merge could run at once on one PR. The judge's merge step (resolveStage('merge'),
      // merge_only) is the one place a merge happens now: merge-pr comments its own refusals
      // there, and a crash fails that step into the judge's self-heal handler — neither is this
      // job's to report.
      //
      // The approval travels on the ledger, bound to the QA result being approved — an env var
      // cannot cross a dispatch, and a dispatch input is anyone's who can dispatch. A halt of
      // theirs does not stand between a person and their decision: start() lifts it.
      await updateLedger(repoOf(), Number(issue), (l) => (l ? {
        ...l, merge_approval: { by: author, at: new Date().toISOString(), sha: l.qa?.sha ?? null, qa_run: l.qa?.run_id ?? null },
      } : null));
      if (await start(resolveStage('merge', { issue, pr: ledger.pr, ledger }), 'a maintainer approved the merge')) {
        await gh(['issue', 'comment', issue, '--body',
          `Approved — merging PR #${ledger.pr}. The merge step re-establishes every claim against the PR as it ` +
          'stands now, and says so here if one does not hold.']);
      }
      break;
    }

    // The architecture gate is approved by merging the brief, and on-merge starts what follows
    // it. Approving while the brief PR is still open started the maintainer against the stub
    // project.md on main — and the merge then started it again, splitting the epic twice.
    //
    // Asked of the architecture itself, on the default branch this job checked out, not of an
    // open PR found by branch name: a brief closed unmerged has no open PR, so approve started
    // the next stage against the stub anyway — and a branch-name listing also finds forks' PRs.
    if (ledger?.stopped_at === 'project'
        && isStub(existsSync('.sdlc/memory/project.md') ? readFileSync('.sdlc/memory/project.md', 'utf8') : null)) {
      await gh(['issue', 'comment', issue, '--body',
        '`.sdlc/memory/project.md` on the default branch is still the stub, so nothing was started: ' +
        `merging ${ledger.brief_pr ? `the brief PR #${ledger.brief_pr}` : 'the brief PR'} is the approval, and ` +
        'the merge starts what comes next. `/sdlc replan-project "<why>"` redoes the brief instead. ' +
        'Approving now would run the next stage against an architecture that is not there.']);
      break;
    }

    // The stage that stopped the issue already worked out what comes next — a gate resumes
    // AFTER itself, a crash resumes BY RUNNING ITSELF AGAIN, and only the thing that stopped
    // it knows which happened. Approving is a dispatch, not a deduction.
    const resume = ledger?.resume_at;

    // Nothing recorded AND no route means intake stopped this before the Router ever ran —
    // an untrusted reporter, a risk area, a bug with no repro steps. Every one of those stops
    // ends by telling a maintainer to type `/sdlc approve`, so it has to do something: it
    // re-runs intake with the stop overridden, which then routes the issue normally. A parked
    // dependency (`blocked`) is intake's stop too, and its message offers the same override.
    if (!ledger || ledger.state === 'blocked' || (!resume && !ledger.planned_route?.length)) {
      const intake = resolveStage('intake', { issue });
      await start({ ...intake, args: [...intake.args, '-f', 'approved=true'] },
        'a maintainer approved past the intake stop');
      await gh(['issue', 'comment', issue, '--body',
        'Approved — re-running intake with the stop overridden. It will say what it would have ' +
        'stopped for, and then route this normally.']);
      break;
    }

    if (!resume) {
      await gh(['issue', 'comment', issue, '--body',
        'Approved, but this issue has a route and nothing recorded where to resume it, so there ' +
        `is nothing to dispatch that would not be a guess. ${retryHint('planning')} starts it again ` +
        'from the plan, `/sdlc replan "<why>"` re-routes it.']);
      break;
    }

    // A resume point that is the stage which stopped is a re-entry, and a re-entered implement
    // carries the reason it was running.
    const target = targetOf(resume, ledger, { reentry: resume === ledger.stopped_at });
    if (!target) {
      await gh(['issue', 'comment', issue, '--body',
        `Approved, and \`${resume}\` cannot be started: ` +
        `${loadGraph().stages[resume]?.input === 'pr' ? 'it runs on a pull request and this issue has none' : 'the stage graph does not know it'}.`]);
      break;
    }
    if (await start(target, 'a maintainer approved it')) {
      await gh(['issue', 'comment', issue, '--body',
        `Approved${ledger.stopped_at ? ` at \`${ledger.stopped_at}\`` : ''}. Starting \`${target.stage}\`.`]);
    }
    break;
  }

  case 'reject': {
    // The person's reason is the whole point of a rejection, and it was thrown away: this
    // posted "replanning with the feedback above" and dispatched the planner, which then read
    // the newest "## Plan review: rejected" comment — an agent's, two rounds old, about a
    // different defect. So the reason is posted under the heading the planner reads, and the
    // approved plan an earlier run stashed is dropped, or the replan simply re-posts it.
    const { ledger } = await routeOf(repoOf(), issue);
    const at = new Date().toISOString();
    const reason = text || 'No reason given — replan against the acceptance criteria as written.';
    await gh(['issue', 'comment', issue, '--body', `## Plan review: rejected by @${author}\n\n${reason}`]);
    await updateLedger(repoOf(), Number(issue), (l) => {
      if (!l) return null;
      const next = { ...l, human_rejections: [...(l.human_rejections ?? []), { by: author, at, reason: reason.slice(0, 4000) }].slice(-20) };
      delete next.approved_work_order;
      delete next.validated_work_order;
      return next;
    });
    if (text) await recordDecision('reject', text, at, ledger);
    await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:plan-review']).catch(() => {});
    // Whichever stage wrote the plan writes it again — a bug's diagnosis, a root-cause's
    // revision — not always the planner.
    const stopped = ['plan', 'debug', 'root-cause'].includes(ledger?.stopped_at) ? ledger.stopped_at : 'plan';
    await start(targetOf(stopped, ledger), 'a maintainer rejected the work order');
    break;
  }

  case 'retry': {
    // `retry` after a budget stop must clear the counters, or it dispatches straight back
    // into the cap it just hit.
    //
    // The argument is a STAGE — or a state, or an alias — read by the same resolver every
    // dispatch uses. It was a state mapped to two workflows: everything but `planning` went to
    // the implementer, so `/sdlc retry qa` reworked a PR QA was about to test, and the stage
    // names the pipeline itself prints (`/sdlc retry plan`, `root-cause`) crashed the reset on
    // "unknown state" with nothing posted. With no argument it re-runs the stage that stopped.
    const { ledger: before } = await routeOf(repoOf(), issue);
    const name = text.split(/\s+/)[0] || before?.stopped_at || before?.resume_at || 'implement';
    let target = targetOf(name, before, { reentry: true });
    // `merge` claims qa-pass, and only a QA run may record that — so from anywhere else the
    // reset refused it and nothing ran. The way to a merge from a stop is QA again, which
    // merges on a pass.
    if (target?.stage === 'merge' && before?.state !== 'qa-pass') target = targetOf('qa', before);
    if (!target) {
      const graph = loadGraph();
      await gh(['issue', 'comment', issue, '--body',
        `\`/sdlc retry ${name}\` names nothing that can start here` +
        (graph.stages[name]?.input === 'pr' ? ' — that stage runs on a pull request, and this issue has none.' : '.') +
        `\n\nIt takes a stage: ${Object.keys(graph.stages).join(', ')} — or \`ci\`, \`gate\`, ` +
        '`planning`, `merge`. Nothing was reset.']);
      break;
    }
    try {
      await ctl('reset', '--issue', issue, '--to', target.state);
    } catch (e) {
      const why = String(e.stderr || e.message).trim().split('\n').pop().replace(/^sdlc: /, '');
      await gh(['issue', 'comment', issue, '--body',
        `Could not restart \`${target.stage}\`: ${why}.\n\nNothing was reset and nothing was started.`]);
      break;
    }
    if (await start(target, 'a maintainer asked for it to be retried')) {
      await gh(['issue', 'comment', issue, '--body',
        `Attempt counters cleared and restarted at **${target.stage}**. The budget is full again — ` +
        'if it stops here a second time, the cause is worth reading before retrying.']);
    }
    break;
  }

  // An answer is context, not a command to do something differently. It is recorded where the
  // next agent will read it, and then the stage that asked runs again.
  //
  // Without this, `open_questions` was a dead end: the planner named what it could not settle,
  // the person had no way to settle it, and the only levers were approve — proceed with the
  // questions open — or replan, which throws the work away and asks them again.
  case 'answer': {
    if (!text) {
      await gh(['issue', 'comment', issue, '--body',
        '`/sdlc answer` needs the answer: `/sdlc answer "Meta first. Google is a later epic."`' +
        '\n\nIt is recorded on the ledger and read by every stage after this one, which is what ' +
        'makes it different from a plain comment.']);
      break;
    }

    const labels = await labelsOf();
    const { ledger: l0 } = await routeOf(repoOf(), issue).catch(() => ({ ledger: null }));
    const at = new Date().toISOString();
    await updateLedger(repoOf(), Number(issue), (l) => {
      if (!l) return null;
      l.answers = [...(l.answers ?? []), {
        at,
        by: author,
        answer: text.slice(0, 4000),
      }].slice(-40);
      // A plan approved before the answer was written without it, and plan-strategy posts an
      // approved stash without replanning: the stage that asked would re-post the old plan.
      delete l.approved_work_order;
      delete l.validated_work_order;
      return l;
    }).catch((e) => process.stdout.write(`::warning::could not record the answer: ${e.message}\n`));
    await recordDecision('answer', text, at, l0);

    await gh(['issue', 'comment', issue, '--body',
      `## Answered\n\n> ${text.split('\n').join('\n> ')}\n\n` +
      'Recorded in the Decisions section of this issue\'s description' +
      (l0?.children?.length ? ' and of every open issue split from it' : '') +
      '. Every stage from here reads it as **decided** — it is not a suggestion to weigh again, ' +
      'and an agent that disagrees says so rather than quietly doing something else.']).catch(() => {});

    // Re-run the stage that ASKED. `stopped_at` is that stage for every kind of stop; the
    // resume point is the stage AFTER a gate, and answering the architecture brief's questions
    // started the maintainer against a brief nobody had revised, before it had even merged.
    const asked = l0?.stopped_at ?? l0?.resume_at;
    if (!asked || !waiting(l0, labels)) {
      await gh(['issue', 'comment', issue, '--body', asked
        ? `Recorded. \`${l0.state}\` is running now, so nothing was started — a second copy on the ` +
          'same branch is the race the lock exists to stop. The answer stands for the next stage ' +
          'that reads this issue.'
        : 'Recorded, and nothing is currently waiting on it — so nothing was re-run. The answer ' +
          'stands for the next stage that reads this issue.']).catch(() => {});
      break;
    }

    // A reviewer or QA that stopped over what a criterion means cannot apply an answer — they
    // judge against the criteria, and re-running one judged the unchanged criterion the same
    // way, round after round. Root-cause is the one stage allowed to change a criterion.
    const stage = ['review', 'qa'].includes(asked) ? 'root-cause' : asked;
    let target = targetOf(stage, l0, { reentry: true });
    // The architecture decision takes the answer as its note, the way a re-decision does.
    if (target && stage === 'project') target = { ...target, args: [...target.args, '-f', `note=${text}`] };
    if (!target) {
      await gh(['issue', 'comment', issue, '--body',
        `Recorded, and \`${stage}\` cannot be started here, so nothing was re-run. The answer ` +
        'stands for the next stage that reads this issue.']).catch(() => {});
      break;
    }
    await start(target, 'a maintainer answered its open questions', stage === 'root-cause' ? { from: asked } : {});
    process.stdout.write(`issue #${issue}: answered -> ${target.workflow}\n`);
    break;
  }

  case 'replan': {
    // The human's note is the whole point: they are overruling a decision a machine made, and
    // re-running the same rules on the same text would produce the same answer. So the note
    // is posted where the Router will read it, and the fast path is skipped — a rule that
    // already fired once and was wrong does not get a second go at being right.
    if (!text) {
      await gh(['issue', 'comment', issue, '--body',
        '`/sdlc replan` needs a reason: `/sdlc replan "this is bigger than a typo"`. ' +
        'The reason is what the Router reads — without it this is just the same decision again.']);
      break;
    }
    await redirect('replan');
    await gh(['issue', 'comment', issue, '--body',
      `## Route note from @${author}\n\n${text}\n\n` +
      '_Re-routing. The Router reads this note as context; the deterministic rules are skipped, ' +
      'because one of them already answered and a person disagreed._']);
    await gh(['workflow', 'run', 'sdlc-intake.yml', '-f', `issue=${issue}`, '-f', 'replan=true']);
    break;
  }

  case 'replan-epic': {
    await redirect('replan-epic');
    await gh(['issue', 'comment', issue, '--body',
      `## Re-split requested by @${author}\n\n` +
      (text || 'No reason given — the maintainer will apply the clubbing test to every adjacent pair.') +
      '\n\n_The re-run reads the issues this epic already has and clubs them; it does not ' +
      'create a second set._']);
    // The note is the reason for the re-split, and the maintainer was never given it: the
    // dispatch carried the epic and `resplit` only, so it re-applied the same test to the same
    // split that a person had just said was wrong.
    await gh(['workflow', 'run', 'sdlc-maintainer.yml', '-f', `epic=${issue}`, '-f', 'resplit=true',
      ...(text ? ['-f', `note=${text}`] : [])]);
    break;
  }

  case 'replan-project': {
    // A pivot, not a correction: the ADRs are numbered on from what is already there rather
    // than overwriting the ones that explain what is being pivoted away from.
    await redirect('replan-project');
    await gh(['issue', 'comment', issue, '--body',
      `## Architecture re-decision requested by @${author}\n\n` +
      (text || 'No reason given.') +
      '\n\n_The existing ADRs are kept and the new ones numbered on from them — what is being ' +
      'pivoted away from is worth as much as what replaces it._']);
    await gh(['workflow', 'run', 'sdlc-project.yml', '-f', `issue=${issue}`, '-f', `note=${text}`]);
    break;
  }

  case 'stop': {
    // A stop that stops nothing.
    //
    // This moved the issue to needs-human and replied "Halted." — and needs-human may go
    // anywhere, so the QA run already in flight recorded qa-pass straight over it and merge-pr
    // merged the PR a person had just halted. The unlock ran as `system`, which a stage holding
    // the lock refuses, and a provider cooldown still restarted the issue on schedule.
    //
    // The halt is written on the ledger, where the one function every claim, verdict and
    // hand-off writes through refuses it; the cooldown is cleared; the lock is released
    // whoever holds it. Recording the halt is not best-effort: if it cannot be written, this
    // run fails rather than saying "Halted".
    const at = new Date().toISOString();
    await updateLedger(repoOf(), Number(issue), (l) => {
      const next = { ...(l ?? newLedger(Number(issue))), halted: { by: author, at, why: text || null } };
      delete next.retry_after;
      delete next.retry_stage;
      return next;
    });
    await advance(issue, 'needs-human', { agent: 'human' });
    await ctl('unlock', '--issue', issue, '--force');
    await gh(['issue', 'comment', issue, '--body',
      `Halted by @${author}. Nothing runs until \`/sdlc approve\`, \`retry\` or \`answer\`.`]);
    break;
  }

  case 'status': {
    const { stdout } = await ctl('status', '--issue', issue);
    await gh(['issue', 'comment', issue, '--body', '```json\n' + stdout + '\n```']);
    break;
  }

  default:
    die('unhandled command "' + cmd + '"');
}
