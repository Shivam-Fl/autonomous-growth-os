// Which stages does THIS ticket actually need?
//
// Every issue used to get the whole chain, because the chain was the code. An audit — "scan
// the checkout flow, file what you find, fix nothing" — still spun up a planner and an
// implementer to produce a PR nobody asked for. A one-line typo still bought a three-agent
// plan council. A design question still could not stop after the plan.
//
// Two phases, cheapest first. This file is phase one: deterministic rules, no model, free,
// and it must be *visible* when one fires — a route chosen by script and a route chosen by a
// model are different things and a reader has to be able to tell which happened. What falls
// through goes to a cheap model with the repo's memory in front of it.
//
// Pure functions. The rules decide how much money a ticket costs and whether a human sees it,
// so they are testable without GitHub.

import { epicOf } from './deps.js';
import { riskAreas } from './triage.js';
import { decisionsOf, DECISIONS_HEADING } from './issue-body.js';

/** The chain the framework shipped with, for anything the rules will not commit to. */
export const FULL = ['plan', 'implement', 'review', 'qa'];

const labelNames = (issue = {}) =>
  (issue.labels ?? []).map((l) => String(typeof l === 'string' ? l : l.name).toLowerCase());

/**
 * Strip fenced code, quoted replies and link text before matching prose against it.
 *
 * An issue pasting a stack trace that contains the word "audit", or quoting someone who
 * asked a question, is not an audit and not a question. The risk scorer learned this lesson
 * the expensive way with `out of scope: payments`.
 */
export function prose(body = '') {
  return String(body)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** Where the spec lives when config does not say: spec-index.mjs reads the same default. */
export const SPEC_PATHS = ['docs/spec', 'SPEC.md'];

/**
 * The spec path the text names or links (`docs/spec/x.md`, a blob URL, a bare `SPEC.md`), or null.
 * A path under a spec directory counts, and so does the directory itself; `docs/specification.md`
 * and `MYSPEC.md` do not.
 */
export function specPointer(text = '', specPaths = SPEC_PATHS) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const p of specPaths ?? SPEC_PATHS) {
    const path = String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path) continue;
    const m = String(text).match(new RegExp(`(?<![\\w.-])${esc(path)}(?:/[\\w./-]*[\\w-])?(?![\\w-])`, 'i'));
    if (m) return m[0];
  }
  return null;
}

/** Paths the issue names explicitly, in backticks, that we can check actually exist. */
export function namedPaths(body = '') {
  const out = new Set();
  for (const m of String(body).matchAll(/`([\w./@-]+\.[a-z]{1,6})`/gi)) out.add(m[1]);
  return [...out];
}

// Audit, question and trivial commit only on a signal a person gave on purpose: a label, or a
// title that says what it is. They used to fire on a word anywhere in the title, and each is
// expensive to get wrong. "Audit trail for expense edits" and "Scan the receipt to prefill the
// expense form" were audits — routed to QA alone and closed with nothing built. "Why does the
// total show NaN?" is a bug report, and was answered with a plan. "Copy the invite link" and
// "Rename a group" are features, and lost their review as trivial chores. Anything short of a
// signal is the model pass's to judge; that is what it is for.
const AUDIT_TITLE = /^\s*audit\s*:/i;
const QUESTION_TITLE = /^\s*question\s*:/i;
// An issue stating what must be true when it is done wants it built, whatever it is called.
const ACCEPTANCE = /^#{1,6}\s*acceptance\b|\bAC-\d+\b/im;
const FIX_VERB = 'fix|repair|resolve|patch|implement|add|build|change|update|refactor|migrate';

// "Do not fix anything" is the clearest possible statement that nothing is to be fixed, and
// matching `fix` in it turns that sentence into the reason the audit route did not fire. The
// risk scorer learned this with "out of scope: payments"; the same shape, one file over.
const NEGATED_FIX = new RegExp(
  `\\b(?:do not|do n't|don'?t|never|no need to|without|rather than|instead of)\\s+(?:\\w+\\s+){0,2}(?:${FIX_VERB})\\w*` +
  `|\\b(?:${FIX_VERB})\\w*\\s+(?:nothing|none of)\\b` +
  `|\\bno\\s+(?:${FIX_VERB})(?:es|s)?\\b`, 'gi');

const WANTS_FIX = new RegExp(`\\b(${FIX_VERB})\\b`, 'i');

/** True when the text asks for a change AFTER the "do not change anything" clauses are gone. */
function asksForAChange(text) {
  return WANTS_FIX.test(String(text).replace(NEGATED_FIX, ' '));
}
// A title that starts by naming the change. Not "copy" or "rename": those are verbs, and
// "Copy the invite link to the clipboard" is a feature.
const TRIVIAL = /^\s*(?:#+\s*)?(typo|wording|spelling|grammar|label text|placeholder text)\b/i;

/**
 * Phase one. Returns a flow plan, or null to say "a model should look at this".
 *
 * Every branch that commits sets `matched_rule`, because a decision a script made silently is
 * indistinguishable from one a model made badly.
 *
 * @param {{number: number, title?: string, body?: string, labels?: any[], kind?: string}} issue
 * @param {{existingPaths?: string[], greenfield?: boolean, specPaths?: string[]}} facts
 *        existingPaths: paths from namedPaths() that really exist in the repo; greenfield:
 *        `.sdlc/memory/project.md` is still a stub; specPaths: config's `spec.paths`
 */
export function fastPath(issue = {}, facts = {}) {
  const labels = labelNames(issue);
  const title = String(issue.title ?? '');
  const body = prose(issue.body ?? '');
  const text = `${title}\n${body}`;
  const plan = (o) => ({ issue: Number(issue.number), risk: 0, confidence: 95, ...o });

  // An epic is too large for one work order by definition. It does not get a route of its
  // own; it gets split, and each piece is routed separately.
  if (labels.includes('sdlc:epic') || labels.includes('epic')) {
    return plan({
      kind: 'epic',
      reasoning: 'Labelled an epic, which means it is too large for one work order. It goes to the maintainer to be split, and each piece is routed on its own.',
      route: ['maintainer'],
      on_complete: 'comment-only',
      matched_rule: 'label:epic',
    });
  }

  // An audit asks a question about code that already exists. There is no PR, so there is
  // nothing to plan, implement or review — QA runs against the deployed target and every
  // finding becomes its own issue.
  const audit = labels.includes('sdlc:audit') || AUDIT_TITLE.test(title);
  if (audit && !asksForAChange(text) && !ACCEPTANCE.test(body) && !epicOf(issue.body ?? '')) {
    return plan({
      kind: 'audit',
      reasoning: 'Asks for a sweep of existing behaviour and asks for nothing to be changed. There is no PR to plan or review, so QA runs against the deployed target and files what it finds.',
      route: ['qa'],
      on_complete: 'file-issue-only',
      confidence: 85,
      matched_rule: 'audit-no-fix',
    });
  }

  // A question wants an answer, not a branch. The planner is the agent that reads the repo
  // and writes down what it found, which is exactly what answering one requires.
  if (labels.includes('question') || QUESTION_TITLE.test(title)) {
    return plan({
      kind: 'question',
      reasoning: 'Asks what should be done rather than asking for it to be done. The plan is the answer; building anything from it is a separate decision a person makes.',
      route: ['plan'],
      on_complete: 'comment-only',
      councils: { plan: 'single' },
      confidence: 80,
      matched_rule: 'question-no-implementation-ask',
    });
  }

  if (labels.includes('sdlc:trivial') || TRIVIAL.test(title)) {
    const real = facts.existingPaths ?? [];
    // The planner stays, and the council and the review go.
    //
    // Dropping the planner too would mean a script assembling the work order, and the
    // implementer takes nothing but a validated work order. For "fix the typo in
    // `src/Button.tsx`" a script could just about do it; for anything described a little less
    // exactly it is a script doing judgement, which is the mirror image of asking a model to
    // do arithmetic. The expensive part of a trivial ticket was never the plan — it was three
    // council agents and a reviewer arguing about a wording change.
    const word = (title.match(TRIVIAL) ?? [, 'trivial'])[1].toLowerCase();
    return plan({
      kind: 'chore',
      reasoning: real.length === 1
        ? `A ${word} change in one named file that exists (${real[0]}). One planning pass decides it; three council agents and a reviewer arguing about it cost more than the change.`
        : `Reads as a ${word} change. One planning pass is enough to decide it — a council is for plans that are expensive to get wrong, and this is not one.`,
      route: ['plan', 'implement', 'qa'],
      on_complete: 'merge',
      councils: { plan: 'single' },
      confidence: real.length === 1 ? 85 : 75,
      matched_rule: real.length === 1 ? 'trivial-single-named-file' : 'trivial-unclear-target',
    });
  }

  // A bug with reproduction steps goes to the debugger, which reproduces before diagnosing.
  // This is not a new decision — routing.js has always made it — it is the same decision
  // expressed as a route so that the stages after it are a choice rather than a given.
  if (labels.includes('bug') || labels.includes('defect') || labels.includes('regression') || issue.kind === 'bug') {
    return plan({
      kind: 'bug',
      reasoning: 'A bug is a question about what a running system is doing, and it is answered by reproducing it rather than by reasoning about the code. The debugger replaces the planner; everything after it is unchanged.',
      route: ['debug', 'implement', 'review', 'qa'],
      on_complete: 'merge',
      confidence: 90,
      matched_rule: 'label:bug',
    });
  }

  // On a greenfield repo the issue that points at the spec IS the product epic. Nothing is built
  // and nothing is decided, so what it asks for is everything the spec describes, and a single
  // plan for that is one plan for the whole product that stops at a comment — no epics, ever.
  // Seen live: "Decide the architecture ... specified in docs/spec/… ... break it into epics" was
  // routed project -> plan, comment-only, and only worked before because it carried the label.
  // Last, so a label a person gave on purpose still wins; never on a piece of an epic.
  const spec = facts.greenfield && !epicOf(issue.body ?? '')
    && specPointer(`${title}\n${issue.body ?? ''}`, facts.specPaths);
  if (spec) {
    return plan({
      kind: 'epic',
      reasoning: `Points at the spec (${spec}) on a repository that has not decided what it is built out of, which makes it the product itself. It goes to the maintainer to be split into epics once the architecture is decided, and each piece is routed on its own.`,
      route: ['maintainer'],
      on_complete: 'comment-only',
      confidence: 90,
      matched_rule: 'greenfield-spec',
    });
  }

  // Nothing matched with any confidence. That is the honest answer, and it is what the model
  // pass exists for — guessing the full chain here would make the cheap phase look decisive
  // while quietly costing every ticket the same as before.
  return null;
}

/**
 * Config wins on gates, always.
 *
 * The Router decides how much deliberation a ticket gets. It does not decide whether a human
 * sees it — a routing decision that could waive `merge_approval` is a routing decision that
 * can ship unreviewed code, and no amount of confidence makes that the Router's call. So the
 * plan's gates are ORed in: it may ask for a gate the config does not require, never the
 * other way round.
 */
export function effectiveGates(configGates = {}, planGates = {}) {
  const out = { ...configGates };
  for (const [k, v] of Object.entries(planGates)) {
    if (v === true) out[k] = true;                 // tighten: allowed
    // v === false is ignored on purpose. Not an error — the Router is allowed to have an
    // opinion — it simply does not get to act on this one.
  }
  return out;
}

/**
 * Does this plan get to run unattended?
 *
 * Mirrors planGate()'s rule for work orders, including the part that makes the score mean
 * something: an absent confidence counts as below the threshold, not as a pass.
 */
export function routeGate(plan = {}, config = {}) {
  const min = config.gates?.min_route_confidence ?? 0;
  const c = plan.confidence;

  if (!Array.isArray(plan.route) || plan.route.length === 0) {
    return { gate: 'human', reason: 'the Router did not commit to a route, which is a refusal to decide rather than a decision to do nothing' };
  }
  if (min > 0 && (typeof c !== 'number' || c < min)) {
    return {
      gate: 'human',
      reason: typeof c === 'number'
        ? `route confidence ${c} is below min_route_confidence ${min}`
        : `the route carries no confidence score, and min_route_confidence is ${min}`,
    };
  }
  const maxRisk = config.gates?.max_route_risk ?? 100;
  if (typeof plan.risk === 'number' && plan.risk > maxRisk) {
    // Not when the risk is only about areas this repo switched off. The model scored an area
    // high because its pack said to, whatever `intake.risk_areas` said — so switching an area
    // off at intake moved the stop one stage later instead of removing it. A reason naming no
    // area at all, or any area still on, still stops.
    const named = riskAreas({ body: plan.reasoning }).risky;
    const off = named.filter((n) => config.intake?.risk_areas?.[n] === false);
    if (!named.length || off.length < named.length) {
      return { gate: 'human', reason: `route risk ${plan.risk} is above max_route_risk ${maxRisk}` };
    }
    return { gate: 'none', reason: `route risk ${plan.risk} is about ${off.join(' and ')}, which intake.risk_areas switches off here` };
  }
  return { gate: 'none', reason: `route confidence ${c ?? '(none)'} clears the bar` };
}

/**
 * The human decisions the Router is given, as prompt text: the pipeline-maintained section of
 * the issue body, never a comment.
 *
 * The prompt grepped every comment for "## Route note from", so anyone on a public repository
 * could post one and drop the review from a ticket or redirect it. run-command writes decisions
 * into the body, which an outsider cannot edit — except on an issue they filed themselves, where
 * they can write that heading too. So on an outsider's issue only the entries run-command also
 * recorded on the ledger (same author, same moment) count; on a trusted reporter's issue the
 * body is theirs or the pipeline's, and all of it does.
 *
 * @param {{answers?: {at: string, by: string}[], route_notes?: {at: string, by: string}[]}|null} ledger
 */
export function recordedDecisions(body, { reporterTrusted = false, ledger = null } = {}) {
  const key = (e) => `${e.at}\u0000${String(e.by ?? '').toLowerCase()}`;
  const onLedger = new Set([...(ledger?.answers ?? []), ...(ledger?.route_notes ?? [])].map(key));
  const kept = decisionsOf(body).filter((d) => reporterTrusted || onLedger.has(key(d)));
  if (!kept.length) return `(none recorded in "${DECISIONS_HEADING}")`;
  return kept.map((d) => `- ${d.kind} by @${d.by} (${d.at}):\n${d.text.split('\n').map((l) => `  ${l}`).join('\n')}`).join('\n');
}
