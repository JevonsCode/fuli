"""Rank a fictional world with the Provider's own scoring, without Neo4j.

The recall-rate benchmark drives three Node surfaces, but two of them rank
through the Provider. Rather than re-implement the ranking in JavaScript, this
script imports the real functions from `fuli_graph.knowledge_search` and runs
the scoring and ordering stage of `search_knowledge` over fixture records.

Reads one JSON request on stdin and writes one JSON response on stdout:

    {"items": [...], "searches": [{"id", "query", "limit", "project_ids",
                                   "include_personal_global", "include_pending",
                                   "include_historical", "active_project_id"}]}
    -> {"results": {"<id>": {"facts": [...], "entities": [...]}}, "timings_ms": {...},
        "candidates": {"<id>": scored candidates in scope}}

What it covers: a stand-in for candidate generation (below), candidate
scoping, the history and confirmation filters, `_edge_matches` (term weights
over this search's own candidates, with its fallback), `_relevance`,
`_ranked_relevance`, the documented sort keys, and deduplication.

Candidate generation: `search_knowledge` weighs a relationship's terms over
the candidates Graphiti's hybrid search returned (at most
`min(max(limit * 8, 40), 100)`) plus those its retrieval terms find, all of
them already related to the query. The stand-in takes, in fixture order, the
relationships that share at least one term with the query, under the same
cap, plus the retrieval-term finds. Graphiti also returns candidates by
meaning and by BM25 over its own tokenizer, so real pools differ: who counts
as "common" can differ too.

What it does not cover, and so cannot measure: Graphiti's own hybrid search
(BM25 tokenization, embeddings, its own order), authorization, Cypher-side
filtering, semantic vectors and RRF fusion, and tag re-ranking.
"""
import json
import sys
import time
from datetime import datetime, timezone

from graphiti_core.edges import EntityEdge

from fuli_graph.knowledge_search import (
    _dedupe_ranked_edges,
    _dedupe_ranked_entities,
    _edge_matches,
    _edge_record,
    _entity_search_result,
    _haystack,
    _normalized,
    _ranked_records,
    _ranked_relevance,
    _relevance,
    _term_weights,
    _terms,
    _tie_weight,
)
from fuli_graph.search_projection import fact_result, is_default_retrievable

SPACE_ID = 'fixture-personal-space'


def _moment(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')) if value else None


def _as_edge(item):
    return EntityEdge(
        uuid=item['id'],
        name=item.get('name') or '',
        fact=item.get('fact') or '',
        group_id='personal-group',
        source_node_uuid=f"{item['id']}::source",
        target_node_uuid=f"{item['id']}::target",
        created_at=_moment(item.get('created_at')) or datetime.now(timezone.utc),
        invalid_at=_moment(item.get('invalid_at')),
        episodes=[f"{item['id']}::episode"],
    )


def _retrieval(item):
    return {
        'retrieval_terms': item.get('retrieval_terms') or [],
        'retrieval_context': item.get('retrieval_context'),
        'attributes': item.get('attributes') or {},
    }


def _in_scope(item, search):
    project_id = item.get('defined_project_id')
    if project_id is None:
        return bool(search.get('include_personal_global', True))
    return project_id in (search.get('project_ids') or [])


def _scoped(item, search):
    """Another project in scope reads as one step away, as a referenced one does."""
    project_id = item.get('defined_project_id')
    distance = 0 if project_id in (None, search.get('active_project_id')) else 1
    return {**item, 'scope_distance': max(int(item.get('scope_distance') or 0), distance)}


def _admitted(items, search):
    kept = []
    for item in items:
        if not _in_scope(item, search):
            continue
        if item.get('invalid_at') and not search.get('include_historical'):
            continue
        if not search.get('include_pending') and not is_default_retrievable(item):
            continue
        kept.append(_scoped(item, search))
    return kept


def _names(items, edges):
    names = {}
    for item, edge in zip(items, edges):
        names[edge.source_node_uuid] = item.get('source_entity')
        names[edge.target_node_uuid] = item.get('target_entity')
    return names


def _fact_candidates(facts, search):
    """Stand-in for Graphiti's hybrid search over the whole group (every
    project, every version), capped as `search_knowledge` caps it, then the
    relationships `_term_edge_candidates` finds by their retrieval terms."""
    query_terms = _terms(_normalized(search['query']))
    edges = [_as_edge(item) for item in facts]
    names = _names(facts, edges)
    sharing = [item for item, edge in zip(facts, edges)
               if query_terms & _terms(_haystack(_edge_record(edge, names, _retrieval(item))))]
    found = sharing[: min(max(search['limit'] * 8, 40), 100)]
    seen = {item['id'] for item in found}
    by_terms = [item for item in facts if item['id'] not in seen and item.get('retrieval_terms')
                and _relevance(search['query'], {'summary': item.get('fact'), **_retrieval(item)}) > 0]
    return [*found, *by_terms]


def _rank_facts(facts, search):
    items = _admitted(_fact_candidates(facts, search), search)
    edges = [_as_edge(item) for item in items]
    names = _names(items, edges)
    by_id = {item['id']: item for item in items}
    edge_by_id = {edge.uuid: edge for edge in edges}
    matched = _edge_matches(search['query'], edges, names, {item['id']: _retrieval(item) for item in items})
    ranked = [
        (score, edge) for score, _, edge in sorted(
            ((_ranked_relevance(base, by_id[edge.uuid]), base, edge) for base, edge in matched),
            key=lambda entry: (entry[0], _tie_weight(by_id[entry[2].uuid]), entry[1]),
            reverse=True,
        ) if score > 0
    ]
    ranked = _dedupe_ranked_edges(ranked, by_id, search.get('active_project_id'), None)
    results = [
        fact_result(edge_by_id[edge.uuid], names, SPACE_ID, by_id[edge.uuid])
        .model_copy(update={'score': round(score, 4), 'matched_by': 'lexical'})
        .model_dump(mode='json')
        for score, edge in ranked[: search['limit']]
    ]
    return results, len(items)


def _rank_entities(items, search):
    items = _admitted(items, search)
    term_weights = _term_weights(search['query'], items)
    ranked = _ranked_records([(item, _relevance(search['query'], item, term_weights)) for item in items])
    ranked = _dedupe_ranked_entities(ranked, search.get('active_project_id'), None)
    results = [
        _entity_search_result(_projectable(record), round(score, 4), SPACE_ID, 'lexical').model_dump(mode='json')
        for record, score in ranked[: search['limit']]
    ]
    return results, len(items)


# Keys the fixture carries for the benchmark's own bookkeeping; the Provider's
# read query never returns them.
_BENCHMARK_ONLY = ('kind', 'scope')


def _projectable(record):
    value = {key: item for key, item in record.items() if key not in _BENCHMARK_ONLY}
    value.setdefault('group_id', 'personal-group')
    value.setdefault('evidence_ids', [f"{record['id']}::episode"])
    return value


def main():
    request = json.load(sys.stdin)
    items = request['items']
    facts = [item for item in items if item.get('kind') == 'relationship']
    entities = [item for item in items if item.get('kind') == 'entity']
    results, timings, candidates = {}, {}, {}
    for search in request['searches']:
        search.setdefault('limit', 12)
        started = time.perf_counter()
        ranked_facts, fact_candidates = _rank_facts(facts, search)
        ranked_entities, entity_candidates = _rank_entities(entities, search)
        timings[search['id']] = round((time.perf_counter() - started) * 1000, 4)
        results[search['id']] = {'facts': ranked_facts, 'entities': ranked_entities}
        candidates[search['id']] = fact_candidates + entity_candidates
    json.dump({'results': results, 'timings_ms': timings, 'candidates': candidates}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
