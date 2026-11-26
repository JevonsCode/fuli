// Surface C: the searches an Agent makes for itself.
//
// Two things are measured separately, because they fail separately:
//   ranking  — is the gold answer in the top of what the Provider returned;
//   delivery — does it survive the page budget on the way to the Agent.
// A call can rank perfectly and still hand the Agent nothing it needed.

import { searchCurrentProjectKnowledge } from '../../src/graphiti/current-project-knowledge-search.js';
import { approxTokens } from '../../src/text/token-estimate.js';
import { CATEGORIES, SEARCH_CALLS, SEARCH_SCOPE } from './recall-cases.js';
import { rankSearches } from './provider-ranking.js';

const SPACE = 'fixture-personal-space';
const TOP_K = 5;
const LIMIT_PER_QUERY = 12;

const idsOf = result => [...(result.facts ?? []), ...(result.entities ?? [])].map(item => item.id);

// Where the gold answer sits across the whole call: the queries run in
// parallel, so an Agent reads them as one list.
function bestRank(order, goldIds) {
  const ranks = goldIds.map(id => order.indexOf(id)).filter(index => index >= 0).map(index => index + 1);
  return ranks.length ? Math.min(...ranks) : null;
}

function application(ranked) {
  return {
    config: { personal: { spaceId: SPACE } },
    consoleUrl: 'http://127.0.0.1:2727',
    personal: { async graph() { throw new Error('no graph in the fixture world'); } },
    async searchKnowledge({ query }) { return ranked.get(query) ?? { facts: [], entities: [] }; }
  };
}

export async function measureOnDemandSearch(items) {
  const searches = SEARCH_CALLS.flatMap(call => call.queries.map((query, index) => ({
    ...SEARCH_SCOPE, ...call.scope, id: `${call.id}#${index}`, query, limit: LIMIT_PER_QUERY
  })));
  const { results, timings_ms, candidates } = await rankSearches(items, searches);

  const cases = [];
  for (const call of SEARCH_CALLS) {
    // Per call: the same query text may run under another scope elsewhere.
    const ranked = new Map(call.queries.map((query, index) => [query, results[`${call.id}#${index}`]]));
    // One Agent reading one call: every query's results, best rank first.
    const order = call.queries
      .flatMap(query => idsOf(ranked.get(query)).map((id, index) => ({ id, index })))
      .sort((left, right) => left.index - right.index)
      .map(entry => entry.id)
      .filter((id, index, list) => list.indexOf(id) === index);
    const topK = order.slice(0, TOP_K);
    const rank = bestRank(order, call.expect);

    const started = process.hrtime.bigint();
    const page = await searchCurrentProjectKnowledge(application(ranked), { personalProjectId: SEARCH_SCOPE.active_project_id },
      { queries: call.queries, limitPerQuery: LIMIT_PER_QUERY, includePending: true });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const pageIds = new Set((page.results ?? []).flatMap(idsOf));
    const rankedGold = call.expect.filter(id => order.includes(id));
    const serialized = JSON.stringify(page);

    const deliveredGold = call.expect.filter(id => pageIds.has(id));
    cases.push({
      id: call.id,
      language: call.language,
      category: call.category ?? null,
      queries: call.queries.length,
      ranked_total: order.length,
      found_in_ranking: rankedGold.length,
      should_find: call.expect.length,
      best_rank: rank,
      reciprocal_rank: rank ? Number((1 / rank).toFixed(4)) : 0,
      in_top_k: Boolean(rank && rank <= TOP_K),
      forbidden_in_top_k: call.forbid.filter(id => topK.includes(id)),
      // Gold the Provider ranked but the page budget did not hand over.
      lost_to_budget: rankedGold.filter(id => !pageIds.has(id)),
      delivered_gold: deliveredGold.length,
      delivered_ids: [...pageIds],
      // What one query had to choose from (in scope, before the score cut),
      // and what it ranked: how much competition a right answer met.
      candidates_per_query: call.queries.map((_, index) => candidates?.[`${call.id}#${index}`] ?? null),
      ranked_per_query: call.queries.map(query => idsOf(ranked.get(query)).length),
      delivered_items: page.retrieval_budget?.returned_items ?? pageIds.size,
      total_items: page.retrieval_budget?.total_items ?? order.length,
      complete: page.retrieval_budget?.complete ?? true,
      bytes: Buffer.byteLength(serialized),
      approx_tokens: approxTokens(serialized),
      rank_ms: call.queries.reduce((total, _, index) => total + (timings_ms[`${call.id}#${index}`] ?? 0), 0),
      page_ms: Number(ms.toFixed(2))
    });
  }

  const sum = (list, read) => list.reduce((total, entry) => total + read(entry), 0);
  const mean = values => (values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null);
  const summarize = list => (list.length ? {
    calls: list.length,
    should_find: sum(list, entry => entry.should_find),
    found_in_ranking: sum(list, entry => entry.found_in_ranking),
    in_top_k: list.filter(entry => entry.in_top_k).length,
    mrr: Number((sum(list, entry => entry.reciprocal_rank) / list.length).toFixed(3)),
    forbidden_in_top_k: sum(list, entry => entry.forbidden_in_top_k.length),
    lost_to_budget: sum(list, entry => entry.lost_to_budget.length),
    delivered_gold: sum(list, entry => entry.delivered_gold),
    delivered_items_total: sum(list, entry => entry.delivered_items),
    // Of what reached the Agent, the share it asked for. As strict as B's:
    // anything not named gold counts against it.
    precision: sum(list, entry => entry.delivered_items)
      ? Number((sum(list, entry => entry.delivered_gold) / sum(list, entry => entry.delivered_items)).toFixed(3)) : null,
    mean_candidates_per_query: mean(list.flatMap(entry => entry.candidates_per_query)),
    mean_ranked_per_query: mean(list.flatMap(entry => entry.ranked_per_query)),
    truncated_calls: list.filter(entry => !entry.complete).length,
    mean_delivered_items: Number((sum(list, entry => entry.delivered_items) / list.length).toFixed(2)),
    mean_total_items: Number((sum(list, entry => entry.total_items) / list.length).toFixed(2)),
    mean_bytes: Math.round(sum(list, entry => entry.bytes) / list.length),
    mean_approx_tokens: Math.round(sum(list, entry => entry.approx_tokens) / list.length),
    mean_rank_ms: Number((sum(list, entry => entry.rank_ms) / list.length).toFixed(3)),
    mean_page_ms: Number((sum(list, entry => entry.page_ms) / list.length).toFixed(2))
  } : null);

  return {
    cases,
    totals: summarize(cases),
    by_language: Object.fromEntries(['zh', 'en', 'mixed']
      .map(language => [language, summarize(cases.filter(entry => entry.language === language))])),
    by_category: Object.fromEntries([['regular', null], ...CATEGORIES.map(category => [category, category])]
      .map(([name, category]) => [name, summarize(cases.filter(entry => entry.category === category))]))
  };
}
