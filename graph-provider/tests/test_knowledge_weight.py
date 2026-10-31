"""One knowledge weight: shown on read, used for ranking, never authorization."""
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from fuli_graph.graph_query import _graph_edge, _graph_node
from fuli_graph.knowledge_search import (
    _dedupe_ranked_entities, _edge_relevance, _entity_search_result, search_knowledge,
)
from fuli_graph.knowledge_weight import knowledge_weight
from fuli_graph.models import GraphEvidence, SearchRequest
from fuli_graph.search_projection import fact_result, is_default_retrievable
from fuli_graph.collaboration_context import _node_item


def record(status='pending', actor=None, **changes):
    basis = {
        'existence_reason': 'A synthetic sourced statement.',
        'quadrant_reason': 'Explicitly recorded for this test.',
        'proposed_by': {'kind': 'agent'},
    }
    if actor:
        basis.update(confirmed_by={'kind': actor}, confirmed_at='2026-10-18T00:00:00Z')
    if status == 'agent_confirmed':
        basis['agent_policy_version'] = 'agent-usage-v1'
    return {
        'id': 'synthetic-weight', 'key': 'synthetic-weight',
        'name': 'A useful rule', 'title': 'A useful rule', 'type': 'Preference',
        'summary': 'A synthetic rule.', 'instruction': 'A synthetic rule.',
        'group_id': 'synthetic-group', 'profile_aspect': 'judgment_preference',
        'preference_scope': 'global', 'confirmation_status': status,
        'confirmation_basis_json': json.dumps(basis), **changes,
    }


def graph(record, evidence=None):
    return _graph_node(record, evidence or {}, {}, {}, {}, {}).model_dump(mode='json')


@pytest.mark.parametrize('status,actor,expected,person', [
    ('pending', None, 10, False),
    ('agent_confirmed', 'agent', 70, False),
    ('confirmed', 'user', 100, True),
    ('confirmed', 'authoritative_source', 100, False),
])
def test_read_weights_follow_valid_confirmation_authority(status, actor, expected, person):
    item = graph(record(status, actor))
    assert item.get('weight_percent') == expected
    assert item.get('confirmed_by_person') is person


@pytest.mark.parametrize('bad_basis', [None, '{}', '{bad json', json.dumps({
    'existence_reason': 'Agent claim.', 'quadrant_reason': 'Unverified.',
    'proposed_by': {'kind': 'agent'}, 'confirmed_by': {'kind': 'agent'},
    'confirmed_at': '2026-10-18T00:00:00Z',
})])
def test_legacy_or_spoofed_confirmation_never_gets_human_weight(bad_basis):
    item = record('confirmed', 'user', confirmation_basis_json=bad_basis)
    payload = graph(item)
    assert payload.get('weight_percent') == 10
    assert payload.get('confirmed_by_person') is False
    assert not is_default_retrievable(item)


@pytest.mark.parametrize('status,actor,low,high', [
    ('pending', None, 10, 69), ('agent_confirmed', 'agent', 70, 95),
])
def test_usage_and_verified_support_raise_weight_within_the_existing_band(status, actor, low, high):
    item = record(status, actor)
    initial = graph(item)
    used = graph({**item, 'qualified_use_count': 3, 'distinct_task_count': 2})
    evidence = GraphEvidence(id='episode-a', name='Source', source_kind='tool',
                             source_description='A synthetic source.', summary='Supporting context.')
    supported = graph({**item, 'qualified_use_count': 3, 'distinct_task_count': 2,
                       'episodes': ['episode-a', 'episode-a']}, {'episode-a': evidence})
    single = graph({**item, 'qualified_use_count': 3, 'distinct_task_count': 2,
                    'episodes': ['episode-a']}, {'episode-a': evidence})
    assert initial.get('weight_percent') == low
    assert low < used.get('weight_percent', 0) < supported.get('weight_percent', 0) <= high
    assert supported.get('weight_percent') == single.get('weight_percent')
    missing = graph({**item, 'episodes': ['missing-episode']})
    assert missing.get('weight_percent') == low
    maximum = graph({**item, 'qualified_use_count': 10**6, 'distinct_task_count': 10**6,
                     'episodes': ['episode-a']}, {'episode-a': evidence})
    assert low < maximum.get('weight_percent', 0) <= high
    sources = {f'episode-{i}': evidence.model_copy(update={'id': f'episode-{i}'}) for i in range(5)}
    saturated = graph({**item, 'qualified_use_count': 100, 'distinct_task_count': 100,
                       'episodes': list(sources)}, sources)
    assert saturated['weight_percent'] == high


def test_negative_evidence_reduces_weight_and_never_rewrites_confirmation():
    item = record('agent_confirmed', 'agent', qualified_use_count=8, distinct_task_count=3)
    before = graph(item)
    after = graph({**item, 'negative_evidence_count': 2})
    assert 70 <= after.get('weight_percent', 0) < before.get('weight_percent', 0) <= 95
    assert after['confirmation_status'] == 'agent_confirmed'
    assert after['confirmation_basis'] == before['confirmation_basis']
    human = graph(record('confirmed', 'user', negative_evidence_count=100, requires_attention=True))
    # Attention halves even a person's weight; the confirmation itself stays.
    assert human.get('weight_percent') == 50
    assert human['confirmation_status'] == 'confirmed'
    assert human['confirmed_by_person'] is True
    assert human['requires_attention'] is True


def test_confirmation_orders_otherwise_equal_items_and_attention_pulls_any_down():
    evidence = {'qualified_use_count': 100, 'distinct_task_count': 100}
    person = knowledge_weight(record('confirmed', 'user', **evidence))['weight_percent']
    agent = knowledge_weight(record('agent_confirmed', 'agent', **evidence))['weight_percent']
    pending = knowledge_weight(record(**evidence))['weight_percent']
    assert person > agent > pending
    flagged = knowledge_weight(record('agent_confirmed', 'agent', requires_attention=True,
                                      **evidence))['weight_percent']
    assert flagged < pending


def test_use_fades_with_time_since_the_last_use_but_sources_and_people_do_not():
    now = datetime(2026, 11, 1, tzinfo=UTC)
    used = {'qualified_use_count': 10, 'distinct_task_count': 4}
    fresh = knowledge_weight(record(**used, last_used_at=now), now=now)['weight_percent']
    half = knowledge_weight(record(**used, last_used_at=now - timedelta(days=90)), now=now)['weight_percent']
    old = knowledge_weight(record(**used, last_used_at=now - timedelta(days=900)), now=now)['weight_percent']
    undated = knowledge_weight(record(**used), now=now)['weight_percent']
    assert fresh == undated > half > old >= 10
    # 40 points of use: fresh 10 + 59*0.40, half-faded 10 + 59*0.20.
    assert (fresh, half) == (34, 22)
    sourced = knowledge_weight(record(last_used_at=now - timedelta(days=900)),
                               evidence_ids=['a'], now=now)['weight_percent']
    assert sourced == knowledge_weight(record(), evidence_ids=['a'], now=now)['weight_percent']
    person = knowledge_weight(record('confirmed', 'user', last_used_at=now - timedelta(days=900)), now=now)
    assert person['weight_percent'] == 100


@pytest.mark.asyncio
async def test_higher_displayed_weight_ranks_higher_at_equal_relevance():
    now = datetime.now(UTC)
    variants = {
        'person': record('confirmed', 'user'),
        'agent-used': record('agent_confirmed', 'agent', qualified_use_count=8, distinct_task_count=4,
                             last_used_at=now),
        'agent': record('agent_confirmed', 'agent'),
        'agent-flagged': record('agent_confirmed', 'agent', requires_attention=True),
        'pending-used': record(qualified_use_count=8, distinct_task_count=4, last_used_at=now),
        'pending-faded': record(qualified_use_count=8, distinct_task_count=4,
                                last_used_at=now - timedelta(days=360)),
        'pending': record(),
    }
    edges = [SimpleNamespace(uuid=key, group_id='synthetic-group', name='PREFERS',
                             fact='Release notes stay short.', source_node_uuid='a', target_node_uuid='b',
                             valid_at=None, invalid_at=None, created_at=now, episodes=[])
             for key in reversed(list(variants))]
    store = SimpleNamespace(
        authorize=_project_space,
        runtime=SimpleNamespace(graphiti=_Graphiti(edges), driver=_WeightDriver(variants)),
    )
    result = await search_knowledge(store, {'id': 'actor'}, SearchRequest(
        space_ids=['synthetic-space'], query='release notes', limit=10, include_pending=True))
    order = [fact.id for fact in result.facts]
    shown = [fact.weight_percent for fact in result.facts]
    assert shown == sorted(shown, reverse=True) and len(set(shown)) == len(shown)
    # Listed lightest first, so semantic order alone would reverse this.
    assert order == list(variants)
    for position, edge in enumerate(edges):
        fact = next(fact for fact in result.facts if fact.id == edge.uuid)
        relevance = _edge_relevance('release notes', edge, {}, position, len(edges))
        assert fact.score == pytest.approx(relevance * fact.weight_percent / 100, abs=1e-4)


def test_equal_scores_keep_the_heavier_item_first():
    light = {**record(), 'id': 'a-light', 'key': 'light'}
    heavy = {**record('agent_confirmed', 'agent'), 'id': 'z-heavy', 'key': 'heavy'}
    ranked = _dedupe_ranked_entities([(light, 5.0), (heavy, 5.0)], None)
    assert [item['id'] for item, _ in ranked] == ['z-heavy', 'a-light']


async def _project_space(actor, space_id, role):
    del actor, role
    return {'id': space_id, 'kind': 'project', 'group_id': 'synthetic-group'}


class _Graphiti:
    def __init__(self, edges):
        self.edges = edges

    async def search(self, query, *, group_ids, num_results):
        del query, group_ids, num_results
        return self.edges


class _WeightDriver:
    def __init__(self, variants):
        self.variants = variants

    async def execute_query(self, query, **parameters):
        if 'MATCH (n:Entity)' in query:
            return [], None, None
        return [{**value, 'id': key} for key, value in self.variants.items()
                if key in parameters.get('edge_ids', [])], None, None


def test_graph_relationship_search_and_active_preference_share_the_weight_contract():
    item = record('agent_confirmed', 'agent', qualified_use_count=5, distinct_task_count=3)
    node = graph(item)
    edge = _graph_edge({**item, 'source': 'a', 'target': 'b', 'fact': item['summary']},
                       {}, {}, {}, {}, {}).model_dump(mode='json')
    source = SimpleNamespace(uuid=item['id'], group_id=item['group_id'], source_node_uuid='a',
                             target_node_uuid='b', name='PREFERS', fact=item['summary'], valid_at=None,
                             invalid_at=None, created_at=datetime.now(UTC), episodes=[])
    fact = fact_result(source, {}, 'synthetic-space', item).model_dump(mode='json')
    entity_record = {key: item[key] for key in (
        'id', 'group_id', 'name', 'type', 'summary', 'key', 'profile_aspect',
        'preference_scope', 'confirmation_status', 'confirmation_basis_json',
        'qualified_use_count', 'distinct_task_count',
    )}
    entity = _entity_search_result(entity_record, .8, 'synthetic-space').model_dump(mode='json')
    preference = _node_item(item, {}).model_dump(mode='json')
    for view in (edge, fact, entity, preference):
        assert view.get('weight_percent') == node.get('weight_percent')
        assert view.get('confirmed_by_person') is False
    assert node.get('weight_percent', 0) >= 70


def test_high_pending_weight_does_not_grant_default_retrieval():
    item = record(qualified_use_count=100, distinct_task_count=100,
                  weight_percent=100, confirmed_by_person=True)
    payload = graph(item)
    assert 10 <= payload.get('weight_percent', 0) <= 69
    assert payload.get('confirmed_by_person') is False
    assert payload['confirmation_status'] == 'pending'
    assert not is_default_retrievable(item)
