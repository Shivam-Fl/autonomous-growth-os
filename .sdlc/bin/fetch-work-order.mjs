#!/usr/bin/env node
// Pulls the most recent work order out of the issue's comments, to stdout.
import { ghJson, extractJsonBlock, die } from './lib/actions.js';

const issue = process.env.ISSUE;
const data = await ghJson(['issue', 'view', issue, '--json', 'comments']);

for (const c of (data.comments ?? []).slice().reverse()) {
  const wo = extractJsonBlock(c.body);
  if (wo?.files && wo?.acceptance) {
    process.stdout.write(JSON.stringify(wo, null, 2) + '\n');
    process.exit(0);
  }
}
die('no work order found on issue #' + issue);
