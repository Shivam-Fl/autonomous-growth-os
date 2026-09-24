---
id: intake
runtime: script
triggers: [issues.opened, issues.reopened]
tools: [gh]
emits: labels, ledger-row
timeout_minutes: 5
---

# Intake Agent

Cheap triage. Runs on every new issue and decides whether the pipeline should even start.

## Does

1. **Classify** from the issue form: `bug` | `feature` | `chore` | `question`. Questions get
   answered and closed, never planned.
2. **Dedupe** against open issues and `.sdlc/memory/patterns/`. A duplicate is linked and
   closed. This is the only step worth a model call, and only when the title search is
   ambiguous.
3. **Risk-score** — anything touching `forbidden_paths`, auth, payments, migrations, or
   infra goes straight to `sdlc:needs-human` and stops. The rest proceed to `sdlc:planning`.
4. **Open the ledger row** and apply labels.

## Refuses to proceed when

- The issue has no reproduction steps and is labelled a bug — ask for them and wait. Planning
  from a vague bug report produces a confident fix for the wrong thing.
- The reporter is not on the allowlist and the repo takes outside contributions — a human
  triages it first. Issue text from a stranger is untrusted input, and the whole pipeline
  downstream acts on it.
- The pipeline is switched off. Intake never gets as far as deciding: `sdlc halt` disables
  the workflows so no run starts, and the repository variable `SDLC_ENABLED` set to `false`
  fails the run at its kill-switch step, before anything reads the issue. `sdlc resume` undoes
  both. An unset variable is not a stop.
