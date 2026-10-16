from datetime import UTC, datetime

import pytest

from fuli_graph import knowledge_audit
from fuli_graph.graph_query import _edge_query, _graph_edge, _graph_node, _node_query


def synthetic_record(**values):
    return {
        'id': 'synthetic-item',
        'name': 'Synthetic candidate',
        'type': 'Requirement',
        'group_id': 'personal-group',
        'summary': 'Synthetic fixture only.',
        'source': 'synthetic-a',
        'target': 'synthetic-b',
        'fact': 'Synthetic fixture only.',
        'attributes_json': '{}',
        'episodes': [],
        **values,
    }


def project(record, *, conflicts=None, preference_conflicts=None, kind='node'):
    build = _graph_node if kind == 'node' else _graph_edge
    item = build(
        record,
        {}, {}, {}, {},
        {record['id']: conflicts} if conflicts else {},
        preference_conflicts=(
            {record['id']: preference_conflicts} if preference_conflicts else {}
        ),
    )
    return item.model_dump(mode='json')


def knowledge_conflict(status):
    now = datetime(2026, 10, 17, tzinfo=UTC)
    return {
        'id': f'conflict-{status}',
        'item_id': 'other-item',
        'target_item_id': 'synthetic-item',
        'target_project_id': 'project-a',
        'status': status,
        'resolution': 'defer' if status == 'pending' else 'use_source',
        'reason': 'Synthetic conflict.',
        'created_at': now,
        'updated_at': now,
    }


@pytest.mark.parametrize('project_scoped', [False, True])
@pytest.mark.parametrize('paginated', [False, True])
def test_graph_queries_read_raw_usage_counts_without_coalescing(project_scoped, paginated):
    node_query = _node_query(project_scoped, paginated)
    edge_query = _edge_query(project_scoped, paginated)
    assert 'node.fuli_qualified_use_count AS raw_qualified_use_count' in node_query
    assert 'node.fuli_distinct_task_count AS raw_distinct_task_count' in node_query
    assert 'edge.fuli_qualified_use_count AS raw_qualified_use_count' in edge_query
    assert 'edge.fuli_distinct_task_count AS raw_distinct_task_count' in edge_query


@pytest.mark.parametrize('kind', ['node', 'edge'])
def test_progress_reports_counts_against_the_write_side_thresholds(kind):
    payload = project(synthetic_record(
        confirmation_status='pending',
        qualified_use_count=3,
        distinct_task_count=3,
        raw_qualified_use_count=3,
        raw_distinct_task_count=3,
    ), kind=kind)

    assert payload['agent_confirmation_progress'] == {
        'required_qualified_uses': knowledge_audit.AGENT_CONFIRMATION_MIN_USES,
        'required_distinct_tasks': knowledge_audit.AGENT_CONFIRMATION_MIN_TASKS,
        'qualified_use_count': 3,
        'distinct_task_count': 3,
        'has_open_conflict': False,
        'blocking_reasons': ['qualified_uses_below_threshold'],
    }


def test_progress_follows_a_changed_threshold_constant(monkeypatch):
    record = synthetic_record(
        confirmation_status='pending',
        raw_qualified_use_count=6,
        raw_distinct_task_count=3,
    )
    assert project(record)['agent_confirmation_progress']['blocking_reasons'] == []

    monkeypatch.setattr(knowledge_audit, 'AGENT_CONFIRMATION_MIN_USES', 7)
    monkeypatch.setattr(knowledge_audit, 'AGENT_CONFIRMATION_MIN_TASKS', 4)
    progress = project(record)['agent_confirmation_progress']

    assert progress['required_qualified_uses'] == 7
    assert progress['required_distinct_tasks'] == 4
    assert progress['blocking_reasons'] == [
        'qualified_uses_below_threshold',
        'distinct_tasks_below_threshold',
    ]


def test_missing_stored_counts_stay_unknown_while_legacy_fields_keep_zero():
    payload = project(synthetic_record(confirmation_status='pending'))

    assert payload['qualified_use_count'] == 0
    assert payload['distinct_task_count'] == 0
    assert payload['agent_confirmation_progress']['qualified_use_count'] is None
    assert payload['agent_confirmation_progress']['distinct_task_count'] is None
    assert payload['agent_confirmation_progress']['blocking_reasons'] == ['usage_unknown']


@pytest.mark.parametrize('kind', ['node', 'edge'])
def test_pending_knowledge_and_preference_conflicts_block_but_resolved_ones_do_not(kind):
    record = synthetic_record(
        confirmation_status='pending',
        raw_qualified_use_count=9,
        raw_distinct_task_count=5,
    )
    resolved = project(record, conflicts=[knowledge_conflict('resolved')], kind=kind)
    pending = project(record, conflicts=[knowledge_conflict('pending')], kind=kind)
    preference = project(
        record,
        preference_conflicts=[{'id': 'preference-conflict', 'status': 'ai_pending'}],
        kind=kind,
    )

    assert resolved['agent_confirmation_progress']['blocking_reasons'] == []
    for payload in (pending, preference):
        assert payload['agent_confirmation_progress']['has_open_conflict'] is True
        assert payload['agent_confirmation_progress']['blocking_reasons'] == ['open_conflict']


@pytest.mark.parametrize('stored_status', ['confirmed', 'agent_confirmed'])
def test_confirmed_items_are_not_candidates_for_usage_promotion(stored_status):
    progress = project(synthetic_record(
        confirmation_status=stored_status,
        raw_qualified_use_count=9,
        raw_distinct_task_count=5,
    ))['agent_confirmation_progress']

    assert progress['blocking_reasons'] == ['not_pending']
