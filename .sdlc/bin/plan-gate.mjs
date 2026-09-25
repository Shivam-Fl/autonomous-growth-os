#!/usr/bin/env node
// Decides who must look at a finished work order before code is written.
//
// The ONE place that is decided. It used to be decided here and then again in post-work-order
// from `gates.plan_approval` alone — so with that flag off, a plan this called `human` (below
// min_confidence, an unreproduced bug, a route that asked for approval) skipped both reviewers
// and was implemented, under a comment telling the owner a person would decide. The plan
// workflow runs this to choose the reviewer; post-work-order runs it again for every producer,
// root-cause included, and acts on the answer. Outputs only: acting is the caller's.
import { readFileSync } from 'node:fs';
import { gh, setOutput, loadConfig, trustedComments, isPipelineAuthor, repo as repoOf } from './lib/actions.js';
import { planGate } from './lib/routing.js';
import { effectiveGates } from './lib/route.js';
import { readLedger } from './lib/state-io.js';

const cfg = await loadConfig();
const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));
const issue = Number(process.env.ISSUE || wo.issue);
const from = process.env.FROM_STAGE || 'plan';

// A gate the ROUTE asked for counts too — additively. The Router may look at a ticket and
// decide a person should read the plan even though config does not require it; what it can
// never do is the reverse, and effectiveGates is where that asymmetry is enforced rather
// than remembered. Not caught: a ledger that cannot be read is not a route that asked nothing.
const { ledger } = await readLedger(repoOf(), issue);
const gates = effectiveGates(cfg.gates ?? {}, ledger?.flow_plan?.gates ?? {});

// What the gate judges is what the pipeline knows, not what the plan says about itself.
//
// The reproduction gate fired only on `kind: bug, reproduced: false`, and both are the agent's
// own optional fields: a debugger plan that left either out passed, and `reproduced: true` needed
// no evidence. A plan from the debugger IS a bug fix whatever it calls itself, and a bug counts
// as reproduced only when the plan says what was observed.
const kind = from === 'debug' ? 'bug' : wo.kind;
// A root-cause revision answers a failure the pipeline itself observed — a QA run with its trace
// and evidence, or CI's output — so it is reproduced by construction. The rule below exists for a
// debugger diagnosing a reported bug nobody has watched happen. Applied to root-cause, it sent
// growth-os's v2 work order to a person as "never reproduced" minutes after QA had reproduced the
// crash on the exact commit, and skipped the plan reviewer that should have read it.
//
// So is a bug the pipeline filed itself: its reviewer's follow-ups, cited to the line, or a
// pre-existing bug QA hit in a live run. growth-os #31 — three review findings, re-checked by the
// planner against main with five file:line citations, and honestly `reproduced: false` because
// dead code and a missing argument are not things you run — waited half an hour for a person.
// The author is GitHub's, not the plan's: nobody else can open an issue as the pipeline.
const filedByPipeline = kind === 'bug' && from !== 'debug' && await gh(['api', `repos/${repoOf()}/issues/${issue}`, '--jq', '.user.login'])
  .then((login) => isPipelineAuthor(login.trim())).catch(() => false);
const observed = from === 'root-cause' || filedByPipeline;
const judged = kind === 'bug'
  ? { ...wo, kind, reproduced: observed || (wo.reproduced === true && (wo.evidence ?? []).length > 0) }
  : wo;
let { gate, reason } = planGate(judged, { ...cfg, gates });
// Say whose gate it is. The route may add plan approval to a ticket the config does not gate —
// the router can sense something a person should read — but "gates.plan_approval is on" named
// the config, on a repository whose config has it off, and sent its owner looking for a switch
// nobody had flipped (growth-os #40).
if (gate === 'human' && gates.plan_approval && !cfg.gates?.plan_approval && reason === 'gates.plan_approval is on') {
  reason = 'the router asked for a person to read this plan when it routed the issue — its reason is in the Route comment above; config does not require it';
}

// The plan reviewer approved but said the confidence is higher than the plan has earned. That is
// the finding min_confidence exists for, reached by a reader instead of a number.
if (process.env.TOO_HIGH === 'true') {
  gate = 'human';
  reason = 'the plan reviewer judged its confidence higher than what it verified';
}

// How many times this plan has already been sent back. The reviewer needs it, because the
// right bar is not the same on round one and round four.
//
// Three rejections on one issue, each naming entirely different defects, each of them real —
// and the fourth plan was approved after the budget had spent seven of its ten attempts. The
// reviewer was not wrong any of those times; it was answering "is every detail pinned?", a
// question that always has another answer, while the implementer's own contract already makes
// it responsible for the details a plan does not spell out.
//
// Counted from the pipeline's own comments only. Every comment starting "## Plan review:
// rejected" counted, whoever posted it, so on a public repository four outsider comments told
// the reviewer it was on round five — where its pack says to block only what ships wrong — and a
// real defect went through as a note. A person's `/sdlc reject` is on the ledger; its comment
// ("rejected by @...") is left out here so it is not counted twice.
const REVIEWER_REJECTION = /^## Plan review: (rejected|could not verify)(?! by @)/;
const rejections = await trustedComments('issue', issue, cfg, { pipelineOnly: true })
  .then((cs) => cs.filter((c) => REVIEWER_REJECTION.test(c.body)).length)
  .catch(() => 0) + (ledger?.human_rejections ?? []).length;
setOutput('rejections', String(rejections));

// The risk areas this repository switched off in `intake.risk_areas`, for the reviewer. Intake
// stops honouring an area the moment a repo disables it, but the reviewer's pack reserves auth,
// payments, migrations and infra for a person — so on a repo where `session` is analytics
// vocabulary, a plan intake let through was escalated by the reviewer instead.
const off = Object.entries(cfg.intake?.risk_areas ?? {}).filter(([, on]) => on === false).map(([k]) => k);
setOutput('risk_off', off.join('; ') || 'none');

setOutput('gate', gate);
setOutput('reason', reason);
setOutput('confidence', String(wo.confidence ?? ''));
process.stdout.write(`this plan goes to: ${gate} (${reason})\n`);
