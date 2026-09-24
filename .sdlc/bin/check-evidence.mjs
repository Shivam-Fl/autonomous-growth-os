#!/usr/bin/env node
// Did the evidence QA cites actually survive — and is it evidence?
//
// QA drove a real browser, took screenshots and recorded a trace for the bug it found — into
// /tmp/qa-evidence/, outside the workspace. The upload step globs the workspace, so it matched
// the report and nothing else, and `if-no-files-found: warn` said so in a line nobody reads.
// The report shipped citing three files that no longer exist anywhere.
//
// The prompt had said "trace/video/HAR on" without saying WHERE, which is the same mistake as
// asking a model to open a PR: an instruction satisfiable in more than one way eventually gets
// satisfied the other way. The workflow now names the directory — and this checks it was used,
// because "the agent wrote it somewhere else" is otherwise indistinguishable from "the agent
// took no screenshots at all".
//
// And then the other half. A "pass" that cited nothing printed "0 cited, all present" and
// merged: thirty passing rows, no browser ever launched. One `touch qa-evidence/x.png` made
// every dead citation non-fatal. The "never production" and "no 5xx" rules were sentences in a
// prompt, and checkApiOrigins had no caller. A pass is what merges, so a pass has to stand on
// files that are what they claim to be, and on a HAR this script — not the agent — has read.
//
// Run twice: in the test job right after the agent, where file times are still real
// (QA_STARTED), and in the judge job on the uploaded copy, where they are download times and
// are not compared. The judge is the gate — it runs from a checkout the code under test never
// saw — so the test job names what predates the run (`predates`) and the judge is handed that
// list (QA_PREDATES) rather than trusting a step that ran beside the PR's code.

import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { setOutput, die, loadConfig } from './lib/actions.js';
import { checkApiOrigins } from './lib/guards.js';

// A report that does not parse is the judge's validate step's to reject: by name, with the text
// kept on the ledger for the rerun to correct. Parsing it here crashed the test job first, so
// validate never ran and nothing was kept.
let report;
try {
  report = JSON.parse(readFileSync(process.env.REPORT ?? 'qa-report.json', 'utf8'));
} catch (e) {
  process.stdout.write(`the QA report cannot be read (${String(e.message).split('\n')[0]}) — nothing to check the ` +
    'evidence against; the validate step rejects it by name\n');
  process.exit(0);
}
const dir = resolve(process.env.QA_EVIDENCE_DIR ?? 'qa-evidence');
const started = process.env.QA_STARTED ? Date.parse(process.env.QA_STARTED) : null;
const pass = report.verdict === 'pass';
const cfg = await loadConfig();

const local = (e) => typeof e === 'string' && /[/\\]/.test(e) && !/^https?:/.test(e);
const cited = [
  ...(report.bugs ?? []).flatMap((b) => b.evidence ?? []),
  ...(report.tests ?? []).flatMap((t) => t.evidence ?? []),
  ...Object.values(report.artifacts ?? {}),
].filter(local);

const files = existsSync(dir) && statSync(dir).isDirectory()
  ? readdirSync(dir, { recursive: true }).map((f) => resolve(dir, f)).filter((f) => statSync(f).isFile())
  : [];
const kept = files.length;
setOutput('files', String(kept));

// Cited paths that are outside the collected directory, or simply absent, are dead links.
const lost = cited.filter((p) => {
  const abs = resolve(p);
  return relative(dir, abs).startsWith('..') || !existsSync(abs);
});

const problems = [];
const predates = (process.env.QA_PREDATES ?? '').split('\n').filter(Boolean);

// --- a pass stands on evidence, file by file ------------------------------------------
if (pass) {
  const byId = new Map((report.tests ?? []).map((t) => [t.id, t]));
  const proving = new Set((report.acceptance_rollup ?? [])
    .filter((a) => a.status === 'pass')
    .flatMap((a) => (a.test_ids ?? []).filter((id) => id !== 'ci')));
  const bare = [...proving].filter((id) => !(byId.get(id)?.evidence ?? []).some(local));
  if (bare.length) problems.push(`${bare.join(', ')} prove${bare.length === 1 ? 's' : ''} a passing criterion and cite${bare.length === 1 ? 's' : ''} no evidence file`);
  if (lost.length) problems.push(`cited but not under ${dir}: ${lost.join(', ')}`);

  const MAGIC = { '.png': '89504e47', '.zip': '504b0304' };
  for (const p of new Set(cited.filter((c) => !lost.includes(c)).map((c) => resolve(c)))) {
    const st = statSync(p);
    if (!st.size) { problems.push(`${p} is empty`); continue; }
    if (started && st.mtimeMs < started) predates.push(p);
    const want = MAGIC[extname(p).toLowerCase()];
    if (want && head(p) !== want) problems.push(`${p} is not the ${extname(p)} file its name says`);
    if (extname(p).toLowerCase() === '.har' && !har(p)) problems.push(`${p} is not a HAR (it does not parse)`);
  }
  for (const p of predates) problems.push(`${p} predates this QA run`);
}
setOutput('predates', predates.join('\n'));

// --- where the page sent data, from the HAR rather than from the agent ----------------
const hars = files.filter((f) => extname(f).toLowerCase() === '.har');
const entries = hars.flatMap((f) => har(f)?.log?.entries ?? []);
// Where the page SENT data: a write, or a request its own code made. Every GET counted, fonts,
// scripts and images included — a compose app that loads Google Fonts failed every QA run on
// fonts.googleapis.com. `_resourceType` is DevTools' field; Sec-Fetch-Dest says the same thing
// in any Chromium HAR (fetch, XHR and EventSource are `empty`), recorded by whatever tool.
const SENDS = new Set(['xhr', 'fetch', 'websocket', 'eventsource']);
const header = (e, name) => String((e.request?.headers ?? []).find((h) => String(h.name).toLowerCase() === name)?.value ?? '');
const sends = (e) => !['GET', 'HEAD', 'OPTIONS'].includes(String(e.request?.method ?? 'GET').toUpperCase())
  || SENDS.has(String(e._resourceType ?? '').toLowerCase())
  || ['empty', 'websocket'].includes(header(e, 'sec-fetch-dest').toLowerCase());
// For every verdict, a page that sent data to a host nobody allowed is a stop — a person's, not a
// crash. This died in the test job, so the report was never posted, triage ran QA again at the
// same host, and the second identical failure sent it to root-cause. `blocked` is read by
// post-qa-report, which records the run as blocked and never merges or revises on it.
let blocked = null;
if (entries.length) {
  const origins = checkApiOrigins(entries.filter(sends).map((e) => e.request?.url).filter(Boolean), cfg.env?.api_allowlist ?? []);
  if (!origins.ok) blocked = origins.reason;
}
if (blocked) {
  setOutput('blocked', blocked);
  process.stdout.write(`::warning::${blocked} — QA is recorded as blocked and handed to a person\n`);
}
if (pass) {
  if (!hars.length) problems.push(`no HAR under ${dir} — nothing shows where the page sent data`);
  const path = (u) => { try { return new URL(u, 'http://x').pathname; } catch { return String(u); } };
  const reported = new Set((report.network_failures ?? []).map((n) => path(n.url)));
  const unreported = entries.filter((e) => Number(e.response?.status) >= 500 && !reported.has(path(e.request?.url)));
  if (unreported.length) {
    problems.push(`the HAR shows ${unreported.length} 5xx response(s) the report does not list in network_failures: ` +
      [...new Set(unreported.map((e) => `${e.response.status} ${e.request.url}`))].slice(0, 5).join(', '));
  }
}

// Blocked outranks the rest: the run stops for a person whatever else is wrong with its evidence,
// and dying over the rest sends the same page round again, at the same host.
if (problems.length && blocked) {
  process.stdout.write(`::warning::the evidence does not hold up either:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(0);
}
if (problems.length) {
  die(`the QA report's evidence does not hold up:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
      `Everything QA keeps must be written under ${dir} (QA_EVIDENCE_DIR), be what its name says, ` +
      'and a pass needs a HAR of the run — a pass is what merges.');
}

if (!lost.length) {
  process.stdout.write(`evidence: ${kept} file(s) collected, ${cited.length} cited, all present\n`);
  process.exit(0);
}

// Loud, but NOT fatal on a report that does not pass while real evidence exists.
//
// This used to kill the run, which threw away a complete QA report — matrix, verdict, bugs and
// all — over a citation. A dangling path is worth shouting about and worth nobody trusting,
// but a failing report with 51 good traces and one bad link is still the most useful thing
// produced that hour, and the pipeline's job is to deliver it with the flaw named. A pass is
// different, and was judged above.
process.stdout.write(
  `::warning::${lost.length} of ${cited.length} cited evidence file(s) are not under ${dir} and will not survive this run:\n` +
  lost.map((p) => `  ${p}`).join('\n') +
  `\nEverything QA keeps must be written under $QA_EVIDENCE_DIR; ${kept} file(s) are there.\n`);
setOutput('lost', String(lost.length));

// Nothing collected at all IS fatal: the report then rests entirely on claims nobody can
// check, which is exactly what driving a real browser was supposed to replace.
if (!kept) {
  die(`the report cites ${cited.length} evidence file(s) and NONE were collected. ` +
      `Everything must be written under ${dir} (QA_EVIDENCE_DIR) — anything elsewhere on the ` +
      'runner is destroyed with it, so there is no evidence for any of this report\'s claims.');
}

function head(p) {
  const fd = openSync(p, 'r');
  try { const b = Buffer.alloc(4); readSync(fd, b, 0, 4, 0); return b.toString('hex'); } finally { closeSync(fd); }
}
function har(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
