#!/usr/bin/env node
// Post stdin as a comment on an issue or a PR, through gh() — the one path that fits a body to
// GitHub's 65,536-character limit. A step piping an agent's file straight into
// `gh ... --body-file -` failed on a long one, and the run with it.
import { readFileSync } from 'node:fs';
import { gh, die } from './lib/actions.js';

const [kind, number] = process.argv.slice(2);
if (!['issue', 'pr'].includes(kind) || !number) die('usage: post-comment.mjs <issue|pr> <number> < body');
process.stdout.write(`${await gh([kind, 'comment', number, '--body', readFileSync(0, 'utf8')])}\n`);
