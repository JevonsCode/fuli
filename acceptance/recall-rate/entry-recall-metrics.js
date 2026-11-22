// Surface B: what the task entry recalls on its own.
//
// Drives the real `recallTaskKnowledge` against the fixture world. The entry
// decides its own queries, so the queries are collected by running it once
// with an empty store, ranked, and the entry is then run again for real. A
// changed control flow asks for a query nobody ranked yet, so the collect-rank
// -replay loop repeats until it asks for nothing new.

import { recallTaskKnowledge } from '../../src/graphiti/task-knowledge-recall.js';
import { approxTokens } from '../../src/text/token-estimate.js';
import { ITEMS } from './knowledge-world.js';
import { ENTRY_CASES, SEARCH_SCOPE } from './recall-cases.js';
import { rankSearches } from './provider-ranking.js';

const SPACE = 'fixture-personal-space';
const CONSOLE = 'http://127.0.0.1:2727';
const REPLAY_ROUNDS = 4;

function application(ranked, asked) {
  return {
    config: { personal: { spaceId: SPACE } },
    consoleUrl: CONSOLE,
    async searchKnowledge({ query, limit, includePending, includeHistorical }) {
      const key = JSON.stringify([query, limit, Boolean(includePending), Boolean(includeHistorical)]);
      asked.set(key, { query, limit, includePending, includeHistorical });
      return ranked.get(key) ?? { facts: [], entities: [] };
    }
  };
}

function searchFor(key, index) {
  const [query, limit, include_pending, include_historical] = JSON.parse(key);
  return { ...SEARCH_SCOPE, id: `eb-${index}`, query, limit, include_pending, include_historical };
}

// Every id the entry actually handed the Agent, in its delivered order.
function deliveredIds(recall) {
  return [...(recall.facts ?? []), ...(recall.entities ?? [])].map(item => item.id).filter(Boolean);
}

function listedIds(recall) {
  return [...(recall.knowledge_index?.items ?? []), ...(recall.pending_index?.items ?? [])]
    .map(item => (Array.isArray(item) ? item[0] : item?.id)).filter(Boolean);
}

export async function measureEntryRecall() {
  const ranked = new Map();
  let recalls = new Map();
  for (let round = 0; round < REPLAY_ROUNDS; round++) {
    const asked = new Map();
    recalls = new Map();
    for (const entry of ENTRY_CASES) {
      const started = process.hrtime.bigint();
      const recall = await recallTaskKnowledge(application(ranked, asked), { personalProjectId: SEARCH_SCOPE.active_project_id }, entry.prompt);
      recalls.set(entry.id, { recall, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    }
    const fresh = [...asked.keys()].filter(key => !ranked.has(key));
    if (!fresh.length) break;
    const searches = fresh.map(searchFor);
    const { results } = await rankSearches(ITEMS, searches);
    fresh.forEach((key, index) => ranked.set(key, results[searches[index].id]));
  }

  const cases = ENTRY_CASES.map(entry => {
    const { recall, ms } = recalls.get(entry.id);
    const ids = deliveredIds(recall);
    const present = new Set(ids);
    const listed = listedIds(recall);
    const bytes = Buffer.byteLength(JSON.stringify(recall));
    return {
      id: entry.id,
      status: recall.status,
      prompt: entry.prompt,
      queries: recall.query_count ?? 0,
      delivered: ids,
      listed,
      missing: entry.expect.filter(id => !present.has(id)),
      wrong: entry.forbid.filter(id => present.has(id)),
      // Delivered but not asked for by this case: the irrelevant-recall rate.
      off_target: ids.filter(id => !entry.expect.includes(id)),
      bytes,
      approx_tokens: approxTokens(JSON.stringify(recall)),
      ms: Number(ms.toFixed(2))
    };
  });

  const sum = (read) => cases.reduce((total, entry) => total + read(entry), 0);
  const expected = ENTRY_CASES.reduce((total, entry) => total + entry.expect.length, 0);
  const forbidden = ENTRY_CASES.reduce((total, entry) => total + entry.forbid.length, 0);
  const deliveredTotal = sum(entry => entry.delivered.length);
  return {
    cases,
    totals: {
      cases: cases.length,
      should_recall: expected,
      recalled: expected - sum(entry => entry.missing.length),
      must_not_recall: forbidden,
      wrongly_recalled: sum(entry => entry.wrong.length),
      delivered_items: deliveredTotal,
      off_target_items: sum(entry => entry.off_target.length),
      precision: deliveredTotal ? Number(((deliveredTotal - sum(entry => entry.off_target.length)) / deliveredTotal).toFixed(3)) : null,
      mean_bytes: Math.round(sum(entry => entry.bytes) / cases.length),
      mean_approx_tokens: Math.round(sum(entry => entry.approx_tokens) / cases.length),
      mean_ms: Number((sum(entry => entry.ms) / cases.length).toFixed(2))
    }
  };
}
