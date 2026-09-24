// Decides which agent handles a ticket, and who has to look at the result.
//
// Pure functions so the decisions are testable without GitHub. Every one of these is a
// policy choice a project will want to change, which is why they read from config rather
// than being spelled out in a workflow condition.

import { lastJsonBlock } from './actions.js';

/**
 * A bug is a question about what a running system is actually doing, and it is answered by
 * reproducing it. A feature is a design problem. Sending both to the same agent is why a
 * planner reasons statically about a bug and produces a confident fix for the wrong thing.
 *
 * @returns {'debugger'|'planner'}
 */
export function agentForIssue(issue = {}, config = {}) {
  const labelNames = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());

  // An epic is too large for one work order by definition — that is what the label means.
  // Sending it to the planner produces either a plan that covers a fraction of it, or one
  // so broad no implementer can apply it. It goes to the maintainer to be split first.
  if (labelNames.includes('sdlc:epic') || labelNames.includes('epic')) return 'maintainer';

  if (config.route_bugs_to_debugger === false) return 'planner';
  const labels = labelNames;
  if (labels.includes('bug') || labels.includes('defect') || labels.includes('regression')) {
    return 'debugger';
  }
  // Fall back to the issue form's own classification when a label is missing.
  if (issue.kind === 'bug') return 'debugger';
  return 'planner';
}

/** Which prompt packs run for a stage, in order. */
export function councilFor(stage, config = {}) {
  const mode = config.councils?.[stage] ?? 'single';
  if (mode !== 'council') return [{ role: stage, pack: `${stage}.md` }];

  if (stage === 'plan') {
    return [
      { role: 'proposer', pack: 'plan-council/1-proposer.md', emits: 'plan/proposal.json' },
      { role: 'critic', pack: 'plan-council/2-critic.md', emits: 'plan/critique.json' },
      { role: 'arbiter', pack: 'plan-council/3-arbiter.md', emits: 'work-order.json' },
    ];
  }
  if (stage === 'review') {
    return [
      { role: 'correctness', pack: 'review-council/1-correctness.md', emits: 'review/correctness.json' },
      { role: 'design', pack: 'review-council/2-design.md', emits: 'review/design.json' },
    ];
  }
  return [{ role: stage, pack: `${stage}.md` }];
}

/**
 * Who, if anyone, must look at this plan before code is written.
 *
 * The asymmetry that shapes this: approving a bad plan costs an implement, a CI run and a QA
 * cycle, and usually produces a PR that looks finished. Rejecting a good one costs a replan.
 * So every uncertain case routes upward.
 *
 * @returns {{gate: 'human'|'agent'|'none', reason: string}}
 */
export function planGate(workOrder = {}, config = {}) {
  const gates = config.gates ?? {};
  const min = gates.min_confidence ?? 0;
  const confidence = workOrder.confidence;

  // A bug fix planned without reproducing the bug is a guess, however confident it sounds.
  if (workOrder.kind === 'bug' && workOrder.reproduced === false) {
    return { gate: 'human', reason: 'the bug was never reproduced — the diagnosis is inferred, not observed' };
  }
  // An absent score is not a passing score.
  if (min > 0 && (typeof confidence !== 'number' || confidence < min)) {
    return {
      gate: 'human',
      reason: typeof confidence === 'number'
        ? `confidence ${confidence} is below min_confidence ${min}`
        : `the plan carries no confidence score, and min_confidence is ${min}`,
    };
  }
  if (gates.plan_approval) return { gate: 'human', reason: 'gates.plan_approval is on' };
  if (gates.plan_review_agent) return { gate: 'agent', reason: 'gates.plan_review_agent is on' };
  return { gate: 'none', reason: 'both plan gates are off — code will be written against an unreviewed plan' };
}

/**
 * Findings only reach the PR if they survived the second reviewer's independent check.
 * A single reviewer's false positive lands as fact, wastes the implementer's next attempt,
 * and teaches everyone to skim reviews.
 */
export function mergeReviewFindings(correctness = {}, design = {}) {
  const verdicts = new Map();
  for (const v of design.verification_of_a ?? []) verdicts.set(v.index, v);

  const kept = [];
  const dropped = [];
  (correctness.findings ?? []).forEach((f, i) => {
    const v = verdicts.get(i);
    if (!v || v.status === 'confirmed') {
      kept.push({ ...f, from: 'correctness', verified: Boolean(v) });
    } else if (v.status === 'overstated') {
      kept.push({ ...f, from: 'correctness', verified: true, severity: 'minor', note: v.reasoning });
    } else {
      dropped.push({ ...f, from: 'correctness', dropped_because: v.reasoning });
    }
  });

  for (const f of design.findings ?? []) kept.push({ ...f, from: 'design', verified: true });

  const blocking = kept.filter((f) => f.severity === 'blocking');
  return {
    findings: kept.sort((a, b) => rank(a.severity) - rank(b.severity)),
    dropped,
    verdict: blocking.length ? 'request-changes' : 'approve',
    blocking_count: blocking.length,
    // What route-review needs and could not get. The council posts a comment, never a review,
    // and route-review read both of these from PR reviews — so in council mode an approval's
    // major findings were never filed, and every rejection was recorded as being about nothing,
    // which meant a criterion rejected ten rounds running never reached root-cause. Criterion
    // ids only: a file path is where a finding is, not what it is about, and two different bugs
    // in one file are not the same rejection twice.
    blocking_criteria: [...new Set(blocking.flatMap((f) =>
      criteriaOf(f.ac ?? f.claim).filter((c) => /^ac-\d+$/.test(c))))].sort(),
    unresolved: asFollowUps(kept.filter((f) => f.severity !== 'blocking').map((f) => ({
      title: f.claim,
      detail: [f.claim, f.file && `\`${f.file}${f.line ? `:${f.line}` : ''}\``,
        f.evidence && `Evidence: ${f.evidence}`, f.fix && `Fix: ${f.fix}`].filter(Boolean).join('\n\n'),
    }))),
  };
}

const rank = (s) => ({ blocking: 0, major: 1, minor: 2 }[s] ?? 3);

/**
 * What did review decide, and therefore where does the PR go next?
 *
 * Until this existed the answer was "nowhere". The reviewer requested changes on the first
 * real PR, said so clearly, and nothing read it — `post-review.mjs` set an output no step
 * consumed. A review nobody routes on is a comment.
 *
 * Two shapes to read, because there are two review modes:
 *   council — `declared` carries the merged verdict, computed from cross-verified findings.
 *   single  — `reviews` carries the reviewer's review/review.md, which route-review reads
 *             through REVIEW; the verdict is the one it wrote there.
 *
 * Returns null when there is nothing to read at all. That is NOT an approval: an agent that
 * finished without reviewing is the absent-value bug this pipeline keeps producing, and the
 * caller escalates it to a human instead of letting silence merge code.
 */
/**
 * A verdict in the one spelling the pipeline routes on, or null.
 *
 * The contract spelled it `request_changes` while this matched `request-changes` exactly, so a
 * reviewer following its own pack read as having said nothing: "The review stage finished
 * without posting a review", which was false, and a person woken for a routine rework. Models
 * write "Approved", "changes requested", "reject"; each has one meaning, so each is read as it.
 *
 * `comment` is its own outcome — the reviewer found something it cannot judge without a
 * person — and never an approval.
 *
 * @returns {'approve'|'request-changes'|'comment'|null}
 */
export function normaliseVerdict(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (s === 'approve' || s === 'approved') return 'approve';
  if (['request-changes', 'changes-requested', 'reject', 'rejected'].includes(s)) return 'request-changes';
  if (s === 'comment') return 'comment';
  return null;
}

/**
 * The block a review states its verdict in: the LAST fenced json block that carries one.
 *
 * The first block was taken, so a review that quoted a package.json or a work order before its
 * verdict read as no verdict at all. What an agent decides is the last thing it writes; what
 * comes before it is evidence.
 */
export const verdictBlock = (body) => lastJsonBlock(body, (o) => 'verdict' in o);

export function reviewVerdict({ declared = null, reviews = [] } = {}) {
  const said = normaliseVerdict(declared);
  if (said) return said;

  // Latest wins deliberately: a human approving after the bot requested changes is exactly
  // how someone overrides a finding they disagree with, and it must not be outvoted by an
  // older review that is still sitting in the list.
  const latest = [...reviews].filter(Boolean).pop();
  if (!latest) return null;

  // Read the verdict the reviewer WROTE, not the button it happened to press.
  //
  // This used to map the review's state, with COMMENTED counted as approval — justified by
  // "the Actions token cannot submit a formal approval", which turned out to be false: the
  // same agent submitted real APPROVED reviews on one PR and bare COMMENTED ones on the next.
  // So a comment-shaped review, whatever it said, became an approval and went to QA, while the
  // PR itself showed no approval at all and `reviewDecision` stayed empty.
  //
  // The state is the model's choice of button. The block is its stated verdict, in the same
  // fenced-JSON form every other agent here uses, and it is what the orchestrator acts on.
  const stated = normaliseVerdict(verdictBlock(latest.body)?.verdict);
  if (stated) return stated;

  // No stated verdict. CHANGES_REQUESTED still stops the PR — that one is unambiguous
  // whatever else is missing — but a bare comment is NOT an approval: it is a reviewer that
  // did not say, and saying nothing must never be how code proceeds.
  if (latest.state === 'CHANGES_REQUESTED') return 'request-changes';
  if (latest.state === 'APPROVED') return 'approve';
  return null;
}

/**
 * Non-blocking findings the reviewer is approving DESPITE — the ones nobody fixed.
 *
 * "A finding recorded in prose nobody actions is a finding that was not made." That sentence
 * is already in this codebase, written for QA, which opens an issue for every bug it scopes
 * out of a PR. Review had no equivalent, so a non-blocking finding had exactly one fate: the
 * implementer answered "the reviewer marked it optional" and it ceased to exist.
 *
 * Optional is the reviewer's statement about SEVERITY — they will not hold the merge for it.
 * It is not a judgement that the finding is wrong. Somebody did the work of finding it and
 * saying what the fix was; the cheapest possible outcome is a ticket.
 *
 * Read from the same fenced JSON block as the verdict, because a second mechanism is a second
 * thing to keep in sync.
 *
 * @param {{body?: string}[]} reviews
 * @returns {{title: string, detail: string}[]}
 */
// Section headings that are structure, not a finding.
const NOT_A_FINDING = /^(review(\s+summary)?|findings?|verdict|blocking|what(\s|')?s?\s+(good|right|looks right)|recommendation|summary|root[-\s]cause)\b/i;
// A reviewer's own words for "I am not holding the merge for this".
const NON_BLOCKING = /\b(not[-\s]?blocking|non[-\s]?blocking|nits?|minor|optional|suggestions?)\b/i;

/**
 * The findings a review left behind, read from its PROSE.
 *
 * The structured `unresolved` field is what this should come from, and when the reviewer fills
 * it in that is what gets used. But the field was documented in the schema and not in the
 * prompt, so for a long time no reviewer filled it — and a review that approved a PR while
 * naming an XSS hole, a wrong bind address and a lost-update race recorded `filed_findings=0`.
 * All three would have ceased to exist the moment the PR merged.
 *
 * So the prose is the fallback, and it tolerates the shapes reviewers actually write rather
 * than one canonical layout: `**2. XSS in UI rendering (not blocking)**` under a `### Findings`
 * heading, or items under a `### Non-blocking` heading, or `- **nit:** ...`.
 */
export function unresolvedFromProse(body = '') {
  const text = String(body).replace(/```json[\s\S]*?```/g, '');
  const lines = text.split('\n');

  const out = [];
  let section = '';
  let current = null;
  const flush = () => {
    if (!current) return;
    const detail = current.detail.join('\n').trim();
    // Inline marker on the item, or the section it sits under said so.
    if (NON_BLOCKING.test(current.title) || NON_BLOCKING.test(section)) {
      out.push({ title: current.title.replace(/\s*\(.*?not[-\s]?blocking.*?\)/i, '').trim(), detail });
    }
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^#{2,6}\s*(.+?)\s*$/);
    if (heading) {
      flush();
      const title = heading[1].replace(/[*`]/g, '').trim();
      // A non-blocking SECTION heading opens a section; anything else either is one finding's
      // own heading or is structure.
      if (NON_BLOCKING.test(title) || NOT_A_FINDING.test(title)) { section = title; continue; }
      section = section && NON_BLOCKING.test(section) ? section : '';
      current = { title, detail: [] };
      continue;
    }
    // `**3. Node version drift (not blocking)**` — the shape reviewers reach for most.
    const numbered = line.match(/^\*\*(?:\d+[.)]\s*)?(.+?)\*\*\s*$/);
    if (numbered && !NOT_A_FINDING.test(numbered[1])) {
      flush();
      current = { title: numbered[1].trim(), detail: [] };
      continue;
    }
    if (current) current.detail.push(line);
  }
  flush();
  return out.filter((f) => f.title);
}

export function unresolvedFindings(reviews = []) {
  const latest = [...reviews].filter(Boolean).pop();
  const body = String(latest?.body ?? '');

  let raw = verdictBlock(body)?.unresolved;
  // The reviewer said nothing structured, so read what it wrote. A finding recorded in prose
  // that nobody actions is a finding that was not made.
  if (!Array.isArray(raw)) raw = unresolvedFromProse(body);
  return asFollowUps(raw);
}

// Repair the cosmetic, refuse the false: an over-long title is trimmed, an entry with no title
// at all is dropped. A ticket called "undefined" is worse than no ticket, because somebody has
// to open it to find that out.
const asFollowUps = (raw) => raw
  .map((f) => ({
    title: String(f?.title ?? '').trim().slice(0, 120),
    detail: String(f?.detail ?? f?.fix ?? '').trim().slice(0, 4000),
  }))
  .filter((f) => f.title)
  // Capped. A reviewer that decides to emit forty of these is a reviewer misusing the field,
  // and forty new issues is worse than none — it buries the backlog it is meant to protect.
  .slice(0, 10);

/**
 * What one blocking entry is about, as the keys a repeat is counted on.
 *
 * Kept verbatim, "AC-3: total is wrong" and "AC-3 (rounding)" were two different criteria, so
 * one criterion rejected round after round never counted as a repeat and root-cause never got
 * its turn. The acceptance-criterion ids an entry names are what it is about; an entry naming
 * none (a file path) is kept whole. Lower-cased, as every recorded review_history entry is —
 * changing the case would restart every streak already in flight.
 */
export function criteriaOf(entry) {
  const text = String(entry?.id ?? entry ?? '').trim();
  return (text.match(/\bAC-\d+\b/gi) ?? (text ? [text] : [])).map((c) => c.toLowerCase());
}

/**
 * What this rejection was ABOUT — the acceptance criteria its blocking findings named.
 *
 * @returns {string[]} sorted, de-duplicated, lower-cased. Empty when it cannot be told.
 */
export function rejectionCriteria(reviews = []) {
  const latest = [...reviews].filter(Boolean).pop();
  const body = String(latest?.body ?? '');

  let about = verdictBlock(body)?.blocking ?? [];
  if (!Array.isArray(about) || !about.length) {
    // The reviewer did not say. Read the criteria its BLOCKING prose names — everything after
    // the non-blocking heading is explicitly not what held the merge, and counting it would
    // make every thorough review look like a repeat of the last one.
    // Everything from the first non-blocking-ish heading onward is explicitly NOT what held
    // the merge. Counting it would make every thorough review read as a repeat of the last
    // one and escalate the reviewers doing the most work. The heading is the reviewer's own
    // prose, so this tolerates the shapes they actually write rather than one exact string.
    const head = body.split(/^#{1,6}\s*(?:non[-\s]?blocking|nits?|minor|optional|suggestions?|scope)\b/im)[0];
    about = [...head.matchAll(/\bAC-\d+\b/g)].map((m) => m[0]);
  }
  return [...new Set(about.flatMap(criteriaOf))].sort();
}

/**
 * The criterion that keeps coming back, and how many rounds running it has.
 *
 * Counting whole rejections as equal was the obvious design and it is wrong, which the first
 * real case showed immediately. Three rounds on one ProdOS ticket blocked on {AC-3},
 * {AC-3, AC-8}, {AC-2, AC-3} — three different sets, so a set-equality signature matches
 * nothing, while what a person sees is that AC-3 has been rejected three times.
 *
 * Reviews legitimately pick up new findings each round. The signal is not the whole set
 * repeating; it is one criterion surviving every fix aimed at it.
 *
 * @param {string[][]} history  criteria per past rejection, newest LAST, excluding this one
 * @param {string[]} current
 * @returns {{criterion: string, rounds: number} | null}
 */
export function repeatedCriterion(history = [], current = [], head = null) {
  // A round only counts if the implementer ANSWERED it.
  //
  // Two rejections of the same criterion mean the fix did not work — but only if there was a
  // fix. When the rework run dies before producing anything, or is dispatched without being
  // told it is a rework and rebuilds instead of answering, the next review rejects the same
  // criterion against a head nobody changed. Counting that as a second round escalates a
  // criterion that has been attempted once.
  //
  // The head SHA is what distinguishes them: same head, same code, so it is the same round
  // being re-judged rather than a second attempt that also failed. Entries are objects now;
  // a bare array is an older entry from before this was recorded, and is trusted as a round
  // because there is nothing better to do with it.
  const criteriaOf = (e) => (Array.isArray(e) ? e : e?.criteria);
  const headOf = (e) => (Array.isArray(e) ? null : e?.head);

  let worst = null;
  for (const c of current) {
    let rounds = 1;                                  // this rejection
    let seenAt = head;
    for (let i = history.length - 1; i >= 0; i--) {  // then walk back while it keeps appearing
      const listed = criteriaOf(history[i]);
      if (!Array.isArray(listed) || !listed.includes(c)) break;
      const at = headOf(history[i]);
      // Same commit as the round we last counted: nothing was built in between.
      if (at && seenAt && at === seenAt) continue;
      rounds++;
      if (at) seenAt = at;
    }
    if (!worst || rounds > worst.rounds) worst = { criterion: c, rounds };
  }
  return worst;
}
