import json
from datetime import UTC, datetime
from types import SimpleNamespace

from fuli_graph.search_projection import fact_result, is_default_retrievable


def test_default_retrieval_uses_auditable_confirmation_not_discovery_quadrant():
    assert is_default_retrievable({
        'confirmation_status': 'confirmed',
        'origin_quadrant': 'unknown_known',
        'confirmation_basis_json': json.dumps({
            'existence_reason': 'The user reviewed this item.',
            'quadrant_reason': 'It was inferred before review.',
            'proposed_by': {'kind': 'agent'},
            'confirmed_by': {'kind': 'user'},
            'confirmed_at': '2026-07-29T08:00:00Z',
        }),
    })
    assert is_default_retrievable({
        'confirmation_status': 'agent_confirmed',
        'origin_quadrant': 'unknown_unknown',
        'confirmation_basis_json': json.dumps({
            'existence_reason': 'Repeated material use retained this item.',
            'quadrant_reason': 'It surfaced during exploration.',
            'proposed_by': {'kind': 'agent'},
            'confirmed_by': {'kind': 'agent'},
            'confirmed_at': '2026-07-29T08:00:00Z',
            'agent_policy_version': 'agent-usage-v1',
        }),
    })
    assert not is_default_retrievable({
        'confirmation_status': 'pending',
        'origin_quadrant': 'known_known',
    })
    assert not is_default_retrievable({
        'confirmation_status': 'confirmed',
        'origin_quadrant': 'known_known',
    })
    assert not is_default_retrievable({
        'origin_quadrant': 'known_known',
        'epistemic_status': 'confirmed',
    })


def test_fact_search_projection_includes_the_authorized_space_for_deep_links():
    edge = SimpleNamespace(
        uuid='relationship-1',
        group_id='group-1',
        source_node_uuid='source-1',
        target_node_uuid='target-1',
        name='IMPLEMENTS',
        fact='来源标记打开对应知识',
        valid_at=None,
        invalid_at=None,
        created_at=datetime.now(UTC),
        episodes=['episode-1'],
    )

    result = fact_result(
        edge,
        {'source-1': '来源标记', 'target-1': '知识详情'},
        'project-space',
        {
            'source_references': [
                {
                    'uri': 'https://docs.example.invalid/project/requirements-v1',
                    'reference_time': datetime(2026, 7, 20, tzinfo=UTC),
                },
                {
                    'uri': 'https://docs.example.invalid/project/requirements-v2',
                    'reference_time': datetime(2026, 7, 22, tzinfo=UTC),
                },
                {
                    'uri': 'https://docs.example.invalid/project/requirements-v1',
                    'reference_time': datetime(2026, 7, 21, tzinfo=UTC),
                },
            ],
        },
    )

    assert result.space_id == 'project-space'
    assert result.source_uris == [
        'https://docs.example.invalid/project/requirements-v2',
        'https://docs.example.invalid/project/requirements-v1',
    ]


def test_fact_search_projection_includes_human_change_review_state():
    changed_at = datetime.now(UTC)
    edge = SimpleNamespace(
        uuid='relationship-1',
        group_id='group-1',
        source_node_uuid='source-1',
        target_node_uuid='target-1',
        name='IMPLEMENTS',
        fact='人工调整后的关系',
        valid_at=None,
        invalid_at=None,
        created_at=changed_at,
        episodes=[],
    )

    result = fact_result(
        edge,
        {},
        'personal-space',
        {
            'human_edited': True,
            'human_change_status': 'unseen',
            'human_change_version': 3,
            'last_human_changed_at': changed_at,
        },
    )

    assert result.human_edited is True
    assert result.human_change_status == 'unseen'
    assert result.human_change_version == 3
