# Autonomous Growth OS

An autonomous growth intelligence system: it researches markets, runs bounded advertising
experiments, measures real business outcomes against first-party truth rather than platform
self-reporting, learns causally from what it did, and improves its own strategy — while never
holding the credentials that would let it spend money unchecked.

**Nothing is built yet.** The specification is in
[`docs/spec/autonomous-growth-os.md`](docs/spec/autonomous-growth-os.md), and the architecture
it gets built against is being decided on the first issue.

## How this repository is built

Every line here is written by an autonomous SDLC pipeline. Issues are tickets, labels are the
state machine, comments are the message bus, and GitHub Actions is the scheduler. An issue is
routed, planned by a council, implemented, reviewed, driven in a real browser by an adversarial
QA agent, and merged — with a human gate only where one is worth a person's time.

The pipeline itself lives in [`.sdlc/`](.sdlc) and [`.github/workflows/`](.github/workflows).

## The three constraints that shape everything

1. **The model never holds advertising write credentials.** Every mutation passes a
   deterministic Policy Kernel that issues a signed, scoped, expiring capability to an isolated
   Executor. The agent cannot modify the mechanism that defines what it is allowed to modify.
2. **The simulator comes before the first real credential.** A fake advertising universe with
   delayed conversions, saturation, quality variance, outages and external changes — because
   autonomous logic cannot be safely built against real spend without somewhere to replay it.
3. **The target is not the finish line.** Reaching a CPL goal is a milestone, not a completion
   condition. The system keeps asking what the next unit of budget is worth and whether
   advertising is still the bottleneck at all.
