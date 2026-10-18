"""The read contract uses evidence-backed display weights, never authorization."""
import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.graph_query import _graph_edge, _graph_node
from fuli_graph.knowledge_search import _entity_search_result
from fuli_graph.models import GraphEvidence
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
    assert human.get('weight_percent') == 100
    assert human['requires_attention'] is True


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
