#!/usr/bin/env node
// Prints the failure packet a re-dispatched stage has to answer, to stdout.
//
// The ledger's copy, which dispatch-fix writes and apply-triage adds its diagnosis to. This used
// to take the newest packet-shaped JSON block from the PR's or the issue's comments, whoever
// wrote it — and on a public repository anyone can comment, so an outsider's block newer than
// the bot's became the "raw_excerpt" the implementer is told to read first.
//
// And only while the code is still the code it failed on. Nothing ever cleared the ledger's
// packet, so every `fix:` rework after it got it: a sync-branch's fix:ci-red, a `/sdlc retry ci`
// days later, each told to fix exactly one error that was old or from another stage. dispatch-fix
// stamps the sdlc/issue-<n> head it failed at; a packet whose head is not the branch's head now
// is about other code. The triage and root-cause read it straight after it is written, at the
// same head. The comment fallback went for the same reason: those packets name no head.
//
// Exits 1 with nothing on stdout when there is no packet, so a shell can branch on it. A
// stage asking for one is usually a rework that may or may not have come from a failure, and
// a missing packet is an ordinary answer there, not a broken run.

import { gh, repo as repoOf } from './lib/actions.js';
import { readLedger } from './lib/state-io.js';

const issue = process.env.ISSUE;

const isPacket = (o) => o && typeof o === 'object'
  && typeof o.error_signature === 'string' && typeof o.raw_excerpt === 'string';

if (issue) {
  const repo = repoOf();
  const { ledger } = await readLedger(repo, Number(issue)).catch(() => ({ ledger: null }));
  const packet = ledger?.failure_packet;
  if (isPacket(packet)) {
    // null for a branch that does not exist; undefined for one that could not be read, which
    // matches nothing — an unverifiable packet is not handed over.
    const now = await gh(['api', `repos/${repo}/branches/sdlc/issue-${issue}`, '--jq', '.commit.sha'])
      .then((sha) => sha || null)
      .catch((e) => (/404|Not Found/.test(String(e.stderr ?? e.message)) ? null : undefined));
    // A packet with no head says nothing about which code it is about, and matches nothing.
    if (packet.head !== undefined && packet.head === now) {
      process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
      process.exit(0);
    }
    process.stderr.write(`the failure packet is about ${packet.head === undefined ? 'a head nobody could read' : packet.head ?? 'no branch'}, and sdlc/issue-${issue} ` +
      `is at ${now === undefined ? 'a head that could not be read' : now ?? 'no branch'} — not handing it over\n`);
    process.exit(1);
  }
}

process.stderr.write('no failure packet found\n');
process.exit(1);
