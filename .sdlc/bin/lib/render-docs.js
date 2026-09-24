// Renders the brief's product, technical, UI and research sections as real documents.
//
// They used to live only inside project-brief.json — a single machine artifact nobody opens.
// An agent three months later reads `docs/`, and a PRD that exists only as a JSON key is a PRD
// that was never written. Each file is generated, so the brief stays the source of truth and
// these never drift from it.
const bullets = (xs, f = (x) => x) => (xs?.length ? xs.map((x) => `- ${f(x)}`).join('\n') : '_none stated_');
const section = (title, body) => (body ? `\n## ${title}\n\n${body}\n` : '');

export function renderPrd(b) {
  const p = b.prd;
  if (!p) return null;
  return [
    `# Product requirements`, '',
    `_Generated from \`project-brief.json\` for #${b.issue}. Edit the brief, not this file._`, '',
    `## The problem`, '', p.problem, '',
    `## Who has it`, '',
    (p.users ?? []).map((u) =>
      `### ${u.who}\n\n- **When:** ${u.context}\n- **Pain:** ${u.pain}` +
      (u.sophistication ? `\n- **Sophistication:** ${u.sophistication}` : '')).join('\n\n') || '_none stated_',
    section('Jobs to be done', bullets(p.jobs)),
    section('In scope', bullets(p.scope)),
    section('Deliberately not doing', bullets(p.non_goals)),
    section('Success', (p.success ?? []).map((s) =>
      `- **${s.metric}** — ${s.target}${s.how_measured ? `\n  - measured by: ${s.how_measured}` : ''}`).join('\n')),
    p.constraints?.length ? section('Constraints', bullets(p.constraints)) : '',
  ].join('\n');
}

export function renderTrd(b) {
  const t = b.trd;
  if (!t) return null;
  const reqs = (t.requirements ?? []).map((r) =>
    `### ${r.id} — ${r.requirement}\n\n` +
    `**Why.** ${r.rationale}\n` +
    (r.priority ? `\n**Priority.** ${r.priority}\n` : '') +
    (r.verified_by ? `\n**Proved by.** ${r.verified_by}\n` : '')).join('\n');
  return [
    `# Technical requirements`, '',
    `_Generated from \`project-brief.json\` for #${b.issue}. Edit the brief, not this file._`, '',
    `## Requirements`, '', reqs || '_none stated_',
    section('Data model', (t.data_model ?? []).map((d) =>
      `### ${d.entity}\n\n${d.holds}` + (d.keys ? `\n\n**Keys.** ${d.keys}` : '') +
      (d.notes ? `\n\n${d.notes}` : '')).join('\n\n')),
    section('Interfaces', (t.interfaces ?? []).map((i) =>
      `### ${i.name}\n\n\`\`\`\n${i.shape}\n\`\`\`` +
      (i.errors ? `\n\n**On failure.** ${i.errors}` : '') +
      (i.idempotency ? `\n\n**Idempotency.** ${i.idempotency}` : '')).join('\n\n')),
    section('Non-functional', bullets(t.nfrs)),
  ].join('\n');
}

export function renderUi(b) {
  const u = b.ui;
  if (!u) return null;
  const tokens = u.theme?.tokens?.length
    ? ['| token | value | used for |', '|---|---|---|',
       ...u.theme.tokens.map((t) => `| \`${t.name}\` | \`${t.value}\` | ${t.use} |`)].join('\n')
    : '_none stated_';
  return [
    `# UI`, '',
    `_Generated from \`project-brief.json\` for #${b.issue}. Every ticket follows this rather`,
    `than inventing its own — five screens each inventing their own spacing is how one product`,
    `ends up looking like five._`, '',
    `## Theme`, '', tokens,
    u.theme?.typography ? `\n**Typography.** ${u.theme.typography}` : '',
    u.theme?.density ? `\n**Density.** ${u.theme.density}` : '',
    u.theme?.motion ? `\n**Motion.** ${u.theme.motion}` : '',
    u.theme?.dark_mode ? `\n**Dark mode.** ${u.theme.dark_mode}` : '',
    section('Patterns', (u.patterns ?? []).map((p) =>
      `### ${p.pattern}\n\n${p.rule}` + (p.example ? `\n\n_Example._ ${p.example}` : '')).join('\n\n')),
    section('Screens', (u.layouts ?? []).map((l) =>
      `### ${l.screen}\n\n**Answers.** ${l.purpose}\n\n**Regions.** ${l.regions}\n` +
      // Five named states, each its own line. They were one string, which is how a screen ends
      // up with an "empty / loading / error" sentence that describes none of them.
      (l.states
        ? '\n' + ['ideal', 'empty', 'loading', 'partial', 'error']
            .filter((k) => l.states[k])
            .map((k) => `- **${k}** — ${l.states[k]}`).join('\n') + '\n'
        : '') +
      (l.responsive ? `\n**Narrow.** ${l.responsive}` : '')).join('\n\n')),
    section('Accessibility', bullets(u.accessibility)),
  ].join('\n');
}

export function renderResearch(b) {
  const r = b.research;
  if (!r) return null;
  return [
    `# Research`, '',
    `_What was learned outside this repository before the architecture was decided, and where_`,
    `_it came from. Generated from \`project-brief.json\` for #${b.issue}._`, '',
    `## Questions`, '', bullets(r.questions),
    section('Findings', (r.findings ?? []).map((f) =>
      `### ${f.claim}\n\n` +
      `**What the source says.** ${f.evidence}\n\n` +
      `**Source.** ${f.source}\n` +
      (f.confidence != null ? `\n**Confidence.** ${f.confidence}\n` : '') +
      (f.affects ? `\n**Changed.** ${f.affects}\n` : '')).join('\n')),
    section('Sources not trusted', bullets(r.rejected_sources)),
    section('Assumptions this rests on', (b.assumptions ?? []).map((a) =>
      `### ${a.assumption}\n\n` +
      (a.basis ? `**Believed because.** ${a.basis}\n\n` : '') +
      `**If wrong.** ${a.if_wrong}\n` +
      (a.validate_by ? `\n**Cheapest check.** ${a.validate_by}\n` : '')).join('\n')),
  ].join('\n');
}
