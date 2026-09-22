# QA environment notes

The Librarian appends here after every QA run that hit an environment quirk. This file is the
single highest-value thing in memory: it is what makes browser QA get *less* flaky over time
instead of staying constant.

## Demo app
- Static site, no backend. `localStorage` key: `demo.todos`.
- **Clear `localStorage` between cases.** State leaks across tests otherwise and produces
  failures that look like product bugs but are leftover fixtures.
- Health endpoint: `/api/health` (rewritten to `health.json`).
- No auth, so no test accounts are needed. A real project will need `fixtures[]` entries here.

## Known flaky
_(none recorded yet — add entries as they are found, with the symptom and the workaround)_
