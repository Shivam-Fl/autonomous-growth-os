#!/usr/bin/env node
// Pulls the most recent failure packet out of a PR's or an issue's comments, to stdout.
//
// Same idiom as fetch-work-order.mjs, and for the same reason: artifacts cross agent
// boundaries as fenced JSON on the timeline, so a re-dispatched stage can read what the last
// one produced without any shared filesystem between two workflow runs.
//
// Exits 1 with nothing on stdout when there is no packet, so a shell can branch on it. A
// stage asking for one is usually a rework that may or may not have come from a failure, and
// a missing packet is an ordinary answer there, not a broken run.

import { ghJson } from './lib/actions.js';

const pr = process.env.PR;
const issue = process.env.ISSUE;

const isPacket = (o) => o && typeof o === 'object'
  && typeof o.error_signature === 'string' && typeof o.raw_excerpt === 'string';

// A packet is posted to the PR when one exists and to the issue otherwise, so look at both —
// newest first, and prefer the PR because that is where the failing build lives.
const sources = [];
if (pr) sources.push(['pr', pr]);
if (issue) sources.push(['issue', issue]);

for (const [kind, number] of sources) {
  const data = await ghJson([kind, 'view', String(number), '--json', 'comments']).catch(() => null);
  for (const c of (data?.comments ?? []).slice().reverse()) {
    // Not extractJsonBlock: a failure-packet comment carries exactly one fenced block, but a
    // PR body or a QA report may carry several, and the first one is not always the packet.
    for (const m of String(c.body ?? '').matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
      try {
        const o = JSON.parse(m[1]);
        if (!isPacket(o)) continue;
        process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
        process.exit(0);
      } catch { /* not the block we are looking for */ }
    }
  }
}

process.stderr.write('no failure packet found\n');
process.exit(1);
