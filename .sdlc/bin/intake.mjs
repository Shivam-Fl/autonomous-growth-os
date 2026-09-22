#!/usr/bin/env node
// Agent 1 — Intake. No model: classify, risk-score, decide whether the pipeline may start.
import { gh, ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { riskAreas, hasReproSteps, findDuplicate } from './lib/triage.js';
import { dependenciesOf, readyToStart, epicOf } from './lib/deps.js';

const issue = process.env.ISSUE;
const cfg = await loadConfig();

// REST, not `gh issue view --json`: the latter has no authorAssociation field at all, and
// asking for one fails with a wall of valid field names rather than a useful error.
const raw = await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/issues/${issue}`]);
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

const say = (body) => gh(['issue', 'comment', issue, '--body', body]);
// Ledger and label together. They used to be set in two places — the label here, the ledger
// in a later workflow step reading an output — which is one of the two ways this pipeline has
// managed to believe an issue was in a state it had left.
const label = (state) => advance(issue, state.replace(/^sdlc:/, ''), { agent: 'intake' });

// `/sdlc approve` on an issue intake stopped.
//
// Every stop below ends by telling a maintainer to type that, and for a long time typing it
// did nothing: an intake stop records no route and no resume point, so approve had nothing to
// dispatch. The one human gate every issue can hit was the one gate with no way past it, and
// the instruction printed on it was wrong.
//
// Authority is not taken from this flag. It is set by run-command.mjs, which only runs after
// parseCommand has proved the comment's author may issue privileged commands — the same
// boundary as every other /sdlc command. Nothing in the issue text can set it.
const overridden = String(process.env.APPROVED ?? '') === 'true';

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
const allowlist = (cfg.allowlist ?? []).map((u) => u.toLowerCase());

// The pipeline's own bot is inside the trust boundary. The maintainer splits an epic into
// issues; treating those as untrusted outside reports stops the pipeline with work it
// created itself, and the fix a human is offered — /sdlc approve, six times — teaches them
// to approve without reading.
//
// Scoped to this repo's Actions identity, not bots in general: anything else opening issues
// here is still an outside report.
const isOwnPipeline = /^(github-actions(\[bot\])?|app\/github-actions)$/.test(author);

const trusted = isOwnPipeline
  || allowlist.includes(author)
  || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
if (!trusted) {
  await stop('needs-human',
    'Intake stopped: @' + (process.env.AUTHOR ?? '?') + ' is not an allowlisted reporter.\n\n' +
    'Every agent downstream acts on this issue text, so an outside report is triaged by a human first. ' +
    'A maintainer can start the pipeline with `/sdlc approve`.');
}

// Risk: anything near the blast radius stops before a single token is spent.
// Sections describing what will NOT be done are excluded first — an issue saying
// "out of scope: payments" is the clearest statement that payments are not involved, and
// blocking it for saying so trains people to approve without reading.
const { risky: risks } = riskAreas({ title: data.title, body: data.body });
if (risks.length) {
  await stop('needs-human',
    'Intake stopped: this touches ' + risks.join(' and ') + '.\n\n' +
    'These areas are outside the agents\u2019 blast radius by policy (`forbidden_paths` in ' +
    '`.sdlc/config.yml`). A human should plan this one. Comment `/sdlc approve` to override.');
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
const deps = dependenciesOf(data.body);
if (deps.length) {
  const others = await ghJson(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,state']);
  const states = new Map(others.map((o) => [o.number, o.state.toLowerCase()]));
  const ready = readyToStart(deps, states);

  if (!ready.ready) {
    const waiting = ready.waitingOn.map((n) => `#${n}`).join(', ');
    const missing = ready.missing.map((n) => `#${n}`).join(', ');
    await say(
      `Waiting on ${waiting || 'a dependency'}.` +
      (missing ? `\n\nAlso references ${missing}, which does not exist — check the split.` : '') +
      '\n\nThis starts by itself when its dependencies close. Nothing to do; `/sdlc approve` ' +
      'overrides if you want it built against the current code anyway.');
    await label('sdlc:blocked');
    setOutput('next_state', 'blocked');
    process.stdout.write(`intake: blocked on ${waiting}${missing ? ` (missing ${missing})` : ''}\n`);
    process.exit(0);
  }
}

await label('sdlc:planning');
setOutput('next_state', 'planning');
process.stdout.write('intake: proceeding to planning\n');
