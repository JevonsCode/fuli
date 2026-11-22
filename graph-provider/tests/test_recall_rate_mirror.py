"""The recall-rate benchmark mirrors the scoring stage of `search_knowledge`.

It imports the real functions, but it calls them itself, so a changed signature
would make it measure something the Provider no longer does. These assertions
fail loudly instead, naming acceptance/recall-rate/rank_fixture_world.py.
"""
import inspect

from fuli_graph import knowledge_search
from fuli_graph.search_projection import fact_result, is_default_retrievable

MIRROR = 'acceptance/recall-rate/rank_fixture_world.py'


def test_the_benchmark_mirror_still_calls_what_the_search_calls():
    for name in ('_edge_record', '_edge_relevance', '_entity_search_result', '_ranked_records', '_ranked_relevance',
                 '_relevance', '_term_weights', '_tie_weight', '_dedupe_ranked_edges',
                 '_dedupe_ranked_entities'):
        assert hasattr(knowledge_search, name), f'{MIRROR} imports {name}'
    assert callable(fact_result) and callable(is_default_retrievable)


def test_the_mirrored_call_signatures_are_unchanged():
    signatures = {
        '_edge_relevance': ['query', 'edge', 'names', 'position', 'total', 'retrieval', 'term_weights'],
        '_edge_record': ['edge', 'names', 'retrieval'],
        '_relevance': ['query', 'record', 'term_weights'],
        '_term_weights': ['query', 'records'],
        '_ranked_relevance': ['base_score', 'metadata'],
        '_dedupe_ranked_edges': ['ranked', 'metadata_by_id', 'active_project_id', 'project_agent_id'],
        '_dedupe_ranked_entities': ['ranked', 'active_project_id', 'project_agent_id'],
    }
    for name, expected in signatures.items():
        actual = list(inspect.signature(getattr(knowledge_search, name)).parameters)
        assert actual[:len(expected)] == expected, f'{name} changed shape; update {MIRROR}'
