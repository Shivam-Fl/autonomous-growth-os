// The layered research mesh (TR-17, spec §5): plan the sources, then walk
// Layer 0 (first-party truth) → Layer 1 (official structured) → Layer 2
// (search abstraction) → Layer 3 (fetch/extract through the sanitize gate)
// → Layer 4 (browser last, recorded as a skip when fetch sufficed). Pure
// over its inputs: no driver imports; the search provider, fetcher and
// browser are injected. Claims get evidence tiers A–E, corroboration across
// distinct domains, contradiction detection and a TTL cache keyed by the
// normalized question for slow-changing data.

import { runSearch, contentHashOf } from './search.js';
import { sanitizeForPipeline } from './sanitize.js';

/** The exact claim states research memory may hold (spec §5.5). */
export const CLAIM_STATES = Object.freeze(['KNOWN', 'BELIEVED', 'UNKNOWN', 'CONTRADICTORY', 'STALE', 'REJECTED']);

/** Evidence tiers and their weights (spec §5.4): A above B above C above D above E. */
export const TIER_SCORES = Object.freeze({ A: 1, B: 0.8, C: 0.6, D: 0.4, E: 0.2 });

const SOURCE_TYPE_TIERS = Object.freeze({
  first_party: 'A',
  official: 'B',
  research: 'C',
  forum: 'D',
  social: 'D',
  marketing: 'E',
});

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** The cache key: lowercase, whitespace-collapsed question text. */
export function normalizeQuery(question) {
  return String(question ?? '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** The source plan: the ordered layers the pipeline walks, cheapest and
 * most first-party first. The browser (Layer 4) is recorded as skipped
 * until the cheaper layers cannot serve the question. */
export function planSources({ question, tenantScope } = {}) {
  return [
    { layer: 0, name: 'first-party truth', scope: tenantScope ?? null },
    { layer: 1, name: 'official structured sources' },
    { layer: 2, name: 'web search providers', query: nonEmptyString(question) ? question : null },
    { layer: 3, name: 'fetch and extraction' },
    { layer: 4, name: 'browser', skipped_until_needed: true },
  ];
}

/** Tier lookup by source type; unknown types fall to E by design so a new
 * vendor cannot slip in above the tiers the plan opened. */
export function tierFor(sourceType) {
  return SOURCE_TYPE_TIERS[sourceType] ?? 'E';
}

/** Sentences are the claim granularity; the v1 extractor is pure text
 * splitting so the pipeline stays deterministic and testable. */
export function extractClaims(contentMarkdown, { maxClaims = 3 } = {}) {
  return sentencesOf(contentMarkdown).slice(0, maxClaims);
}

function sentencesOf(contentMarkdown) {
  return String(contentMarkdown ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8);
}

const POSITIVE_WORDS = new Set(['above', 'higher', 'more', 'increase', 'increases', 'rises', 'greater']);
const NEGATIVE_WORDS = new Set(['below', 'lower', 'fewer', 'less', 'decrease', 'decreases', 'drops']);

/** Topic key: the claim stripped of numbers, punctuation and polarity
 * words, so an opposing sentence on the same subject lands on one key. */
export function claimTopic(claim) {
  return String(claim ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !POSITIVE_WORDS.has(word) && !NEGATIVE_WORDS.has(word))
    .sort()
    .join(' ');
}

function claimPolarity(claim) {
  const words = String(claim ?? '').toLowerCase().split(/\s+/);
  if (words.some((word) => POSITIVE_WORDS.has(word))) {
    return 1;
  }
  if (words.some((word) => NEGATIVE_WORDS.has(word))) {
    return -1;
  }
  return 0;
}

function domainOf(url) {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** One claim's state: two or more independent domains corroborating is
 * KNOWN; anything less is BELIEVED. Contradictions never score here — they
 * merge upstream. */
export function stateFor(independence) {
  if (independence >= 2) {
    return 'KNOWN';
  }
  return 'BELIEVED';
}

/**
 * Score one claim: tier from its strongest source, independence from the
 * count of distinct domains corroborating it; corroboration lifts the
 * score above that tier seen alone, never past the tier's ceiling.
 */
export function scoreEvidence(sources) {
  let tier = 'E';
  for (const source of sources) {
    if (TIER_SCORES[source.tier] > TIER_SCORES[tier]) {
      tier = source.tier;
    }
  }
  const domains = [...new Set(sources.map((source) => source.domain).filter(Boolean))];
  const independence = domains.length;
  const score = TIER_SCORES[tier] * (1 + Math.min(Math.max(independence - 1, 0), 2) * 0.1);
  return { tier, score: Math.round(score * 1000) / 1000, independence };
}

/**
 * Contradiction detection: two claims on the same topic with opposite
 * polarity merge into one CONTRADICTORY observation retaining both source
 * lists — never a silent overwrite (IAC-2, spec §5.5).
 */
export function detectContradictions(claims) {
  const merged = [];
  const consumed = new Set();
  for (let i = 0; i < claims.length; i += 1) {
    if (consumed.has(i)) {
      continue;
    }
    for (let j = i + 1; j < claims.length; j += 1) {
      if (consumed.has(j)) {
        continue;
      }
      const sameTopic = claims[i].topic !== '' && claims[i].topic === claims[j].topic;
      const opposite = claims[i].polarity !== 0 && claims[i].polarity !== claims[j].polarity;
      if (sameTopic && opposite) {
        merged.push({
          claim: claims[i].claim,
          topic: claims[i].topic,
          state: 'CONTRADICTORY',
          tier: null,
          score: null,
          independence: null,
          sources: [...claims[i].sources, ...claims[j].sources],
        });
        consumed.add(i);
        consumed.add(j);
        break;
      }
    }
  }
  return { merged, consumed };
}

function normalizedRow(row, forcedSourceType) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const text = nonEmptyString(row.contentMarkdown)
    ? row.contentMarkdown
    : (nonEmptyString(row.snippet) ? row.snippet : (nonEmptyString(row.title) ? row.title : ''));
  return {
    url: nonEmptyString(row.url) ? row.url : null,
    title: nonEmptyString(row.title) ? row.title : '',
    publishedAt: nonEmptyString(row.publishedAt) ? row.publishedAt : null,
    retrievedAt: nonEmptyString(row.retrievedAt) ? row.retrievedAt : null,
    contentMarkdown: text,
    contentHash: nonEmptyString(row.contentHash) ? row.contentHash : contentHashOf(text),
    sourceType: forcedSourceType ?? (nonEmptyString(row.sourceType) ? row.sourceType : 'marketing'),
  };
}

/** Observations: dedupe documents, extract claims, merge contradicting
 * pairs, and score what survives. Sort is fully deterministic. */
function observationsFrom(documents) {
  const seen = new Map();
  for (const document of documents) {
    const key = document.url ?? `hash:${document.contentHash}`;
    if (!seen.has(key)) {
      seen.set(key, document);
    }
  }

  const claims = [];
  for (const document of seen.values()) {
    const tier = tierFor(document.sourceType);
    for (const sentence of extractClaims(document.contentMarkdown).slice(0, 3)) {
      claims.push({
        claim: sentence,
        topic: claimTopic(sentence),
        polarity: claimPolarity(sentence),
        tier,
        sources: [{ url: document.url, domain: domainOf(document.url), tier }],
      });
    }
  }

  const { merged, consumed } = detectContradictions(claims);
  const observations = [...merged];
  const byTopic = new Map();
  for (let index = 0; index < claims.length; index += 1) {
    if (consumed.has(index)) {
      continue; // folded into its CONTRADICTORY observation
    }
    const claim = claims[index];
    const key = claim.topic === '' ? `raw:${claim.claim}` : claim.topic;
    if (!byTopic.has(key)) {
      byTopic.set(key, []);
    }
    byTopic.get(key).push(claim);
  }
  for (const [topic, members] of byTopic) {
    const sources = members.flatMap((member) => member.sources);
    const scored = scoreEvidence(sources);
    observations.push({
      claim: members[0].claim,
      topic,
      state: stateFor(scored.independence),
      tier: scored.tier,
      score: scored.score,
      sources,
      independence: scored.independence,
    });
  }

  // Deterministic order: contradictions first, then strongest score down;
  // claim text breaks ties so equal claims sort identically every run.
  observations.sort((a, b) => {
    const aContradicted = a.state === 'CONTRADICTORY';
    const bContradicted = b.state === 'CONTRADICTORY';
    if (aContradicted !== bContradicted) {
      return aContradicted ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.claim < b.claim) {
      return -1;
    }
    if (a.claim > b.claim) {
      return 1;
    }
    return 0;
  });
  return observations;
}

/** The default Layer 4 browser leg: v1 records a skipped browser leg and
 * never opens a real browser (live automation stays out of scope). */
export function FakeBrowserLeg({ reason = 'fetch sufficed' } = {}) {
  const runLeg = () => ({ skipped: true, reason });
  return runLeg;
}

/** Run the layered pipeline for one research question. Args: question,
 * firstPartyRows, officialRows, searchProvider, fetcher, browser,
 * tenantScope, nowIso, cache, ttlSeconds. Returns {ok, question,
 * observations, toolCalls, auditNotes, plan, fromCache}. A dropped page
 * departs as an audit note naming the reason — no browser leg opens and
 * no tool call fires after Layer 3 saw its text (TR-11). */
export async function runResearch({
  question,
  firstPartyRows = [],
  officialRows = [],
  searchProvider = null,
  fetcher = null,
  browser = null,
  tenantScope = null,
  nowIso = null,
  cache = null,
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  const occurredAt = nonEmptyString(nowIso) ? nowIso : new Date().toISOString();
  const cacheKey = cache ? normalizeQuery(question) : null;
  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached && Date.parse(occurredAt) - Date.parse(cached.storedAt) < cached.ttlSeconds * 1000) {
      return { ...cached.value, fromCache: true };
    }
  }

  const plan = planSources({ question, tenantScope });
  const auditNotes = [];
  const toolCalls = [];
  const documents = [];

  // Layer 0 — first-party truth, tier A by definition.
  for (const row of firstPartyRows) {
    documents.push({ ...normalizedRow(row, 'first_party'), layer: 0 });
  }
  // Layer 1 — official structured sources, tier B.
  for (const row of officialRows) {
    documents.push({ ...normalizedRow(row, 'official'), layer: 1 });
  }
  // Layer 2 — the shared search abstraction: the vendor is never named.
  let searchResults = [];
  if (searchProvider) {
    const searched = await runSearch(searchProvider, { query: question });
    searchResults = searched.results;
    toolCalls.push({ tool: 'research_search', provider: searchProvider.providerId, count: searched.results.length });
  }
  // Layer 3 — fetch/extract through the sanitize gate. A dropped page
  // exists only as an audit note naming the reason (TR-11).
  let dropped = 0;
  for (const result of searchResults) {
    if (!fetcher) {
      documents.push({ ...normalizedRow(result, null), layer: 2 });
      continue;
    }
    const fetched = await fetcher({ url: result.url, title: result.title });
    const text = nonEmptyString(fetched?.contentMarkdown) ? fetched.contentMarkdown : result.snippet;
    const gate = sanitizeForPipeline({ url: result.url, text, retrievedAt: occurredAt });
    if (gate.dropped) {
      dropped += 1;
      auditNotes.push({ layer: 3, code: 'CONTENT_DROPPED', reason: gate.reason, url: result.url });
      continue;
    }
    documents.push({ ...normalizedRow(fetched, null), url: result.url, layer: 3 });
  }

  // Layer 4 — browser last, and only when the gate dropped nothing: a
  // dropped page never reaches an open browser and never sends a call.
  const leg = browser ?? FakeBrowserLeg();
  if (dropped > 0) {
    auditNotes.push({
      layer: 4,
      code: 'BROWSER_LEG_SKIPPED',
      reason: `${dropped} external page${dropped === 1 ? '' : 's'} dropped at the sanitize gate`,
    });
  } else {
    const legResult = await leg({ question, tenantScope });
    toolCalls.push({ tool: 'research_browser', skipped: legResult.skipped, reason: legResult.reason });
    auditNotes.push({ layer: 4, code: 'BROWSER_LEG_SKIPPED', reason: legResult.reason });
  }

  const observations = observationsFrom(documents);

  const result = {
    ok: true,
    question,
    observations,
    toolCalls,
    auditNotes,
    plan,
    fromCache: false,
  };
  if (cache && cacheKey && ttlSeconds > 0) {
    cache.set(cacheKey, { value: result, storedAt: occurredAt, ttlSeconds });
  }
  return result;
}
