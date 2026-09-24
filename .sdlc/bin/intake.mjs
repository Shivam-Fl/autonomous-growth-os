#!/usr/bin/env node
// Agent 1 — Intake. No model: classify, risk-score, decide whether the pipeline may start.
import { gh, ghJson, setOutput, loadConfig, die, trustedComments, isPipelineAuthor, isTrustedAuthor, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { riskAreas, hasReproSteps, findDuplicate } from './lib/triage.js';
import { dependenciesOf, readyToStart, epicOf, dependencyStates } from './lib/deps.js';
import { parseCommand } from './lib/commands.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { retryHint } from './lib/flow-graph.js';
import { transition, isLockStale } from './lib/ledger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const issue = process.env.ISSUE;
const cfg = await loadConfig();

// REST, not `gh issue view --json`: the latter has no authorAssociation field at all, and
// asking for one fails with a wall of valid field names rather than a useful error.
const raw = await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/issues/${issue}`]);

// Before a ledger exists, because opening one is what makes an issue the pipeline's.
//
// A pull request is an issue to this API, and intake dispatched with a PR's number opened a
// ledger for it and started planning it as a ticket. And an owner had no way to file a note
// or a "not yet" that the pipeline would leave alone: `sdlc:ignore` was read by the wake pass
// and nowhere here, so intake planned it anyway.
if (raw.pull_request) {
  process.stdout.write(`#${issue} is a pull request, not an issue — nothing to take in\n`);
  process.exit(0);
}
if ((raw.labels ?? []).some((l) => (l.name ?? l) === 'sdlc:ignore')) {
  process.stdout.write(`#${issue} is labelled sdlc:ignore — not the pipeline's\n`);
  process.exit(0);
}
await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'init', '--issue', String(issue)]);

// A reopened issue that already shipped starts again from triage. merged and done were dead
// ends here, so every move below was illegal: the labels moved and the ledger stayed shipped,
// and nothing that ran afterwards could record an outcome. Its old PR is history, and is
// dropped so that a resume or an approval cannot act on a pull request that has merged.
await updateLedger(repoOf(), Number(issue), (l) => {
  if (!l || !['merged', 'done'].includes(l.state)) return null;
  const r = transition(l, 'triage', { agent: 'intake' });
  if (!r.ok) return null;   // halted: the first move below says so, and stops
  return {
    ...r.ledger, pr: null,
    history: [...r.ledger.history, { at: new Date().toISOString(), agent: 'intake',
      action: `reopened after ${l.state}${l.pr ? ` (PR #${l.pr} had shipped)` : ''} — starting again` }].slice(-200),
  };
});

const data = {
  title: raw.title,
  body: raw.body,
  labels: raw.labels ?? [],
  author: { login: raw.user?.login ?? '' },
  authorAssociation: raw.author_association ?? '',
};

// Read the author from the ISSUE, not the event. A workflow_dispatch carries no issue in
// its payload, so the env vars are empty — and an empty author surfaced as
// "@ is not an allowlisted reporter", which names nobody and explains nothing.
const author = (process.env.AUTHOR || data.author?.login || '').toLowerCase();
const association = process.env.ASSOCIATION || data.authorAssociation || '';
const text = ((data.title ?? '') + '\n' + (data.body ?? '')).toLowerCase();
const labels = (data.labels ?? []).map((l) => l.name);

// Every comment intake posts carries this, so the next run can tell where the last override
// was spent (see `verified` below).
const INTAKE_MARK = '<!-- sdlc:intake -->';
const say = (body) => gh(['issue', 'comment', issue, '--body', `${body}\n\n${INTAKE_MARK}`]);
// Ledger and label together. They used to be set in two places — the label here, the ledger
// in a later workflow step reading an output — which is one of the two ways this pipeline has
// managed to believe an issue was in a state it had left.
const label = (state) => advance(issue, state.replace(/^sdlc:/, ''), { agent: 'intake' });

// A person stopped this (on-close halts an issue closed by hand, and `/sdlc stop`). Reopening it
// fires intake, and every move below is refused with "halted by @" — a red run that says nothing
// about how to resume. The halt stands; say how to lift it.
const { ledger: current } = await readLedger(repoOf(), Number(issue)).catch(() => ({ ledger: null }));
if (current?.halted) {
  const { by, why } = current.halted;
  await say(`## Halted by @${by}\n\n${why ? `${why}. ` : ''}Nothing starts on this issue until a person ` +
    `resumes it: ${retryHint('planning')} plans it again.`);
  setOutput('next_state', 'halted');
  process.stdout.write(`issue #${issue}: halted by @${by} — not taking it in\n`);
  process.exit(0);
}

// `/sdlc approve` on an issue intake stopped, and `/sdlc replan`.
//
// Every stop below ends by telling a maintainer to type approve, and for a long time typing it
// did nothing: an intake stop records no route and no resume point, so approve had nothing to
// dispatch. The one human gate every issue can hit was the one gate with no way past it, and
// the instruction printed on it was wrong.
//
// The flags only say that someone dispatched this workflow claiming a maintainer asked. Every
// agent job's token can dispatch it, so a flag taken as proof let any of them — or a prompt
// injected into one — start an outsider's issue past the untrusted-reporter stop, or skip
// intake entirely with a re-route. So each is checked against the comment it claims: an
// authorised `/sdlc approve` (or replan) on this issue, newer than the last thing intake or
// the Router posted. That last condition is what spends it; replaying the dispatch later
// finds the approval already used.
async function verified(command) {
  const comments = await trustedComments('issue', issue, cfg);
  const spent = comments
    .filter((c) => isPipelineAuthor(c.login) && (c.body.includes(INTAKE_MARK) || c.body.startsWith('## Route — ')))
    .at(-1)?.createdAt ?? '';
  return comments.some((c) => {
    const said = c.createdAt > spent && parseCommand({ body: c.body, author: c.login, association: c.association }, cfg);
    return said?.authorized && said.command === command;
  });
}
async function claimed(flag, command) {
  if (String(process.env[flag] ?? '') !== 'true') return false;
  if (await verified(command)) return true;
  await say(`This run was started as a \`/sdlc ${command}\`, but no \`/sdlc ${command}\` from a ` +
    'maintainer on this issue is newer than intake\u2019s last word on it — so it is treated as an ' +
    'ordinary intake, and every check below applies.');
  return false;
}
const overridden = await claimed('APPROVED', 'approve');

// A re-route: triage already said yes, and re-running its stops would undo what the maintainer
// asked for. The Router runs next, skipping the rules that already answered.
if (await claimed('REPLAN', 'replan')) {
  setOutput('replan', 'true');
  process.stdout.write('intake: re-routing at a maintainer\u2019s request\n');
  process.exit(0);
}

// An issue a stage is already working on is not intake's to take in again.
//
// Anything whose token can dispatch can start intake — the dependency wake, a triage verdict,
// an agent's follow-up — and a `labeled` event fires it too. On an issue at implementing, review
// or QA it ran every check again and ended at `advance(planning)`, which the ledger refuses from
// there: the label said planning while the ledger said implementing, and the Router re-routed it
// and dispatched a planner beside the stage still running. A re-route a maintainer asked for has
// already left above; `approve` overrides an intake stop, and an issue past intake is not one.
const PAST_INTAKE = new Set(['implementing', 'ci-red', 'ci-green', 'review', 'qa', 'qa-fail', 'qa-pass', 'budget-exceeded']);
if (PAST_INTAKE.has(current?.state)) {
  await say(`## Intake did not run\n\nThis issue is already past intake: its ledger is at \`${current.state}\`. ` +
    'Taking it in again would move its label back to planning while the ledger stayed where it is, and ' +
    'route it a second time beside the stage working on it. Nothing was changed. ' +
    '`/sdlc replan "<why>"` re-routes it on purpose.');
  setOutput('next_state', current.state);
  process.stdout.write(`issue #${issue}: at ${current.state}, past intake — not taking it in again\n`);
  process.exit(0);
}

// Nor is one a stage is running right now. A running planner leaves the ledger at `planning`,
// which is also where a Router that crashed leaves it, so the state cannot refuse it: a stray
// dispatch re-routed the issue and started a second plan behind the first. The difference is the
// lock: a running stage holds one, and intake and the Router never take one.
if (current?.owner && current.lock_expires && !isLockStale(current)) {
  await say(`## Intake did not run\n\n\`${current.owner}\` is working on this issue: it holds its lock until ` +
    `${current.lock_expires}. Taking it in again would route it a second time and start another stage beside ` +
    'that one. Nothing was changed. `/sdlc replan "<why>"` re-routes it on purpose.');
  // Not its state: at `planning` that is the value that starts the Router.
  setOutput('next_state', 'locked');
  process.stdout.write(`issue #${issue}: locked by ${current.owner} — not taking it in again\n`);
  process.exit(0);
}

async function stop(state, reason) {
  if (overridden) {
    process.stdout.write(`intake would have stopped (${state}) — a maintainer overrode it\n`);
    await say(
      `${reason}\n\n---\n\n_Overridden by \`/sdlc approve\`. Proceeding._`);
    return;   // fall through to the rest of intake
  }
  await say(reason);
  await label('sdlc:needs-human');
  setOutput('next_state', state);
  process.exit(0);
}

// Untrusted reporter: everything downstream acts on this text, so a human triages it first.
//
// By the one rule every other reader of a person's words uses, isTrustedAuthor: allowlisted AND
// able to write here. This took the allowlist OR the association, so every collaborator, and an
// allowlisted name renamed and reclaimed by someone else, was trusted to start the pipeline here
// while their `/sdlc approve` counted nowhere and the Router ignored their issue's Decisions.
//
// The pipeline's own bot is inside the trust boundary (isTrustedAuthor says so too). The
// maintainer splits an epic into issues; treating those as untrusted outside reports stops the
// pipeline with work it created itself, and the fix a human is offered — /sdlc approve, six
// times — teaches them to approve without reading. Scoped to this repo's Actions identity, not
// bots in general: anything else opening issues here is still an outside report.
if (!isTrustedAuthor({ login: author, association }, cfg)) {
  await stop('needs-human',
    'Intake stopped: @' + (process.env.AUTHOR || data.author.login || '?') + ' is not an allowlisted reporter.\n\n' +
    'Every agent downstream acts on this issue text, so an outside report is triaged by a human first. ' +
    'A maintainer can start the pipeline with `/sdlc approve`.');
}

// Risk: anything near the blast radius stops before a single token is spent.
// Sections describing what will NOT be done are excluded first — an issue saying
// "out of scope: payments" is the clearest statement that payments are not involved, and
// blocking it for saying so trains people to approve without reading.
const { risky: risks, hits } = riskAreas({ title: data.title, body: data.body }, cfg);

// Except on a piece the pipeline split from an epic that already passed this stop. The split
// copies the epic's words and Decisions into every child, so a real product — "users log in
// with a password" — needed one `/sdlc approve` per child mentioning a login, a session, a
// payment or a migration, after the owner had approved the epic itself. The piece has to be the
// pipeline's own issue, and `epic` on its ledger is written only by the split and by
// post-work-order for a split criterion it defers to an issue of its own; the epic counts
// as having passed once the Router routed it (or it moved on from intake). The reserved-path
// guard on the diff stays the boundary, as it is for every issue.
const passedIntake = (e) => Boolean(e) && ((e.planned_route?.length ?? 0) > 0 || !['triage', 'needs-human', 'blocked'].includes(e.state));
const parentEpic = risks.length && isPipelineAuthor(author) && current?.epic ? Number(current.epic) : null;
const decidedOn = parentEpic && passedIntake((await readLedger(repoOf(), parentEpic).catch(() => ({ ledger: null }))).ledger)
  ? parentEpic : null;
if (decidedOn) {
  await say(`This reads as touching ${risks.join(' and ')}. That risk was decided on epic #${decidedOn}, which ` +
    'this issue was split from, so intake does not stop it again; any change touching `forbidden_paths` is ' +
    'still refused on the diff.');
} else if (risks.length) {
  // Say which WORDS matched. "This touches payments" on an issue that mentions the event called
  // `refund` is only recognisable as a false positive if the person can see what matched.
  await stop('needs-human',
    'Intake stopped: this reads as touching ' + risks.join(' and ') + '.\n\n' +
    hits.map((h) => `- **${h.name}** — matched ${h.matched.map((w) => `\`${w}\``).join(', ')}`).join('\n') +
    '\n\nThis is a keyword check on the issue text, not on what will change: if those words are ' +
    'this product\u2019s vocabulary rather than the area itself, `/sdlc approve` continues, and ' +
    '`intake.risk_areas` in `.sdlc/config.yml` can switch an area off for this repo. The real ' +
    'boundary is enforced later, on the diff — any change touching `forbidden_paths` is refused ' +
    'whatever this step decided.');
}

// A bug with no reproduction produces a confident fix for the wrong thing.
const isBug = labels.includes('bug');
const hasRepro = hasReproSteps(data.body);
if (isBug && !hasRepro) {
  await stop('needs-human',
    'Intake stopped: this is labelled a bug but has no reproduction steps.\n\n' +
    'Planning from a vague report produces a confident fix for the wrong thing. ' +
    'Add numbered steps from a clean session, then comment `/sdlc approve`.');
}

// Possible duplicates are SUGGESTED, never closed.
//
// A vertical epic split produces siblings that read almost identically — "an equal split"
// and "a shares split" — and closing one on a title heuristic broke a chain three issues
// deep, invisibly, because a closed issue looks like a finished one. Siblings of the same
// epic are skipped entirely: they were deliberately created as separate pieces of one thing.
const open = await ghJson(['issue', 'list', '--state', 'open', '--limit', '80', '--json', 'number,title,body']);
const myEpic = epicOf(data.body);

const candidates = open
  .filter((o) => String(o.number) !== String(issue))
  .filter((o) => !(myEpic && epicOf(o.body) === myEpic));

const dupe = findDuplicate(data.title, candidates);
if (dupe) {
  await say(
    `This looks like it may duplicate #${dupe.number}. Proceeding anyway — a closed issue ` +
    'looks like a finished one, and closing the wrong one breaks whatever depends on it. ' +
    'Close it by hand if it really is a duplicate.');
}

// Dependencies. The maintainer splits an epic into pieces that build on each other — you
// cannot record an expense before groups exist — and starting them all at once means the
// later ones plan against code that does not exist yet.
//
// Parked, not queued: this issue answers one question about itself, and a merge wakes it.
// There is no queue to own and nothing to get stuck.
//
// Each dependency is looked up by number. This read the 100 newest issues and called anything
// else missing, so on a repo past a hundred issues an old dependency parked its dependant for
// good; and it read "closed" as done, so one closed as not planned started work on top of
// something nobody will build.
const deps = dependenciesOf(data.body);
if (deps.length) {
  const ready = readyToStart(deps, await dependencyStates(repoOf(), deps));
  const list = (ns) => ns.map((n) => `#${n}`).join(', ');

  if (!ready.ready && overridden) {
    // "`/sdlc approve` overrides" is printed on every park below, and it re-parked every time.
    await say(`Proceeding against ${list([...ready.waitingOn, ...ready.abandoned, ...ready.missing])}, ` +
      'which have not closed as done — a maintainer approved building this against the current code.');
  } else if (!ready.ready) {
    await say([
      ready.waitingOn.length && `Waiting on ${list(ready.waitingOn)}. This starts by itself when its ` +
        'dependencies close; nothing to do.',
      ready.abandoned.length && `${list(ready.abandoned)} was closed as not planned, so this will not ` +
        'start by itself: what it builds on is not going to exist. Change its dependency line, or close it.',
      ready.missing.length && `Also references ${list(ready.missing)}, which does not exist — check the split.`,
      '`/sdlc approve` overrides if you want it built against the current code anyway.',
    ].filter(Boolean).join('\n\n'));
    await label('sdlc:blocked');
    setOutput('next_state', 'blocked');
    process.stdout.write(`intake: blocked on ${list([...ready.waitingOn, ...ready.abandoned, ...ready.missing])}\n`);
    process.exit(0);
  }
}

await label('sdlc:planning');
setOutput('next_state', 'planning');
process.stdout.write('intake: proceeding to planning\n');
