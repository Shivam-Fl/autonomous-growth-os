// Interactive prompts over readline. No dependency — a setup tool that needs its own
// install step before it can help you install something has missed the point.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let rl;
let closed = false;
const io = () => (rl ??= createInterface({ input: stdin, output: stdout }));
export const closePrompts = () => { closed = true; rl?.close(); rl = undefined; };

// Non-interactive (piped stdin, CI, --yes) takes every default. That makes the same tool
// scriptable, and it means an exhausted stdin degrades to sensible answers rather than
// throwing ERR_USE_AFTER_CLOSE halfway through writing a config.
export const interactive = () => stdin.isTTY && !process.argv.includes('--yes') && !closed;

async function askRaw(question) {
  if (!interactive()) return '';
  try {
    return await io().question(question);
  } catch {
    closed = true;          // stdin ended; everything after this uses defaults
    return '';
  }
}

export function heading(text) {
  stdout.write(`\n${C.bold(text)}\n${C.dim('─'.repeat(Math.min(text.length, 60)))}\n`);
}
export function say(text = '') { stdout.write(text + '\n'); }
export function detected(what, value) {
  stdout.write(`  ${C.green('detected')} ${what}: ${C.bold(String(value))}\n`);
}
export function note(text) { stdout.write(`  ${C.dim(text)}\n`); }

/** Free text with a default. Enter accepts the default. */
export async function ask(question, fallback = '', { hint } = {}) {
  if (hint) say(C.dim(`  ${hint}`));
  const shown = fallback ? ` ${C.dim(`[${fallback}]`)}` : '';
  const answer = (await askRaw(`  ${question}${shown} `)).trim();
  if (!interactive()) stdout.write(`  ${question}${shown} ${C.dim('(default)')}\n`);
  return answer || fallback;
}

/** yes/no. `fallback` is what Enter means. */
export async function confirm(question, fallback = true) {
  const shown = fallback ? 'Y/n' : 'y/N';
  const answer = (await askRaw(`  ${question} ${C.dim(`[${shown}]`)} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('y');
}

/**
 * Pick one of several, each with a one-line explanation of what it means.
 * The explanation is the point: "preview | compose | none" tells nobody which is right.
 */
export async function choose(question, options, { fallback = 0, hint } = {}) {
  say(`\n  ${C.bold(question)}`);
  if (hint) say(C.dim(`  ${hint}`));
  options.forEach((o, i) => {
    const mark = i === fallback ? C.green('●') : C.dim('○');
    say(`  ${mark} ${C.cyan(String(i + 1))}. ${C.bold(o.label)}`);
    if (o.detail) say(`       ${C.dim(o.detail)}`);
  });
  const raw = (await askRaw(`  choose ${C.dim(`[${fallback + 1}]`)} `)).trim();
  const idx = raw ? Number(raw) - 1 : fallback;
  return options[Number.isInteger(idx) && options[idx] ? idx : fallback].value;
}

export const colour = C;
