from datetime import UTC, datetime

from fuli_graph.graph_query import _edge_query, _graph_edge, _graph_node, _node_query


def test_graph_record_projection_parses_shared_json_attributes():
    node = _graph_node(
        {
            'id': 'entity-1',
            'name': 'Hotel Theme',
            'type': 'Project',
            'group_id': 'personal-group',
            'summary': 'Hotel theme project',
            'attributes_json': '{"projectId":"hotel-theme"}',
            'replaced_by_item_id': 'entity-current',
            'replaced_by_item_kind': 'entity',
            'episodes': [],
        },
        {},
        {},
        {},
        {},
        {},
    )
    edge = _graph_edge(
        {
            'id': 'relationship-1',
            'source': 'entity-1',
            'target': 'entity-2',
            'source_name': 'Hotel Theme',
            'target_name': 'Campaign',
            'type': 'CONTAINS',
            'fact': 'The project contains a campaign.',
            'attributes_json': '{"weight":2}',
            'episodes': [],
        },
        {},
        {},
        {},
        {},
        {},
    )

    assert node.attributes == {'projectId': 'hotel-theme'}
    assert edge.attributes == {'weight': 2}
    assert edge.source_name == 'Hotel Theme'
    assert edge.target_name == 'Campaign'
    assert node.replaced_by_item_id == 'entity-current'
    assert node.replaced_by_item_kind == 'entity'
    assert node.epistemic_state_explicit is False
    assert edge.epistemic_state_explicit is False
    assert node.confirmation_status == 'pending'
    assert edge.confirmation_status == 'pending'
    assert node.confirmation_state_explicit is False


def test_graph_record_projection_preserves_explicit_epistemic_state():
    node = _graph_node(
        {
            'id': 'entity-1',
            'name': 'Confirmed requirement',
            'type': 'Requirement',
            'group_id': 'personal-group',
            'summary': 'The user explicitly confirmed this requirement.',
            'origin_quadrant': 'known_known',
            'current_quadrant': 'known_known',
            'epistemic_status': 'confirmed',
            'epistemic_state_explicit': True,
            'confirmation_status': 'confirmed',
            'confirmation_state_explicit': True,
            'confirmation_basis_json': (
                '{"existence_reason":"Explicit user decision",'
                '"quadrant_reason":"Explicitly expressed",'
                '"proposed_by":{"kind":"agent"},'
                '"confirmed_by":{"kind":"user"},'
                '"confirmed_at":"2026-07-21T10:00:00Z"}'
            ),
            'attributes_json': '{}',
            'episodes': [],
        },
        {},
        {},
        {},
        {},
        {},
    )

    assert node.epistemic_state_explicit is True
    assert node.confirmation_state_explicit is True
    assert node.confirmation_status == 'confirmed'
    assert node.confirmation_basis.confirmed_by.kind == 'user'


def test_graph_projection_downgrades_legacy_confirmation_without_audit_basis():
    node = _graph_node(
        {
            'id': 'legacy-confirmed',
            'name': 'Legacy confirmed flag',
            'type': 'Requirement',
            'group_id': 'personal-group',
            'summary': 'No confirmer or confirmation time was stored.',
            'confirmation_status': 'confirmed',
            'confirmation_state_explicit': False,
            'confidence_score': 1.0,
            'attributes_json': '{}',
            'episodes': [],
        },
        {},
        {},
        {},
        {},
        {},
    )

    assert node.confirmation_status == 'pending'
    assert node.confirmation_state_explicit is False
    assert node.confidence_score == 0.5


def test_graph_projection_includes_human_change_state_and_permanent_audit_events():
    changed_at = datetime.now(UTC)
    node = _graph_node(
        {
            'id': 'entity-1',
            'name': 'Human-edited requirement',
            'type': 'Requirement',
            'group_id': 'personal-group',
            'summary': 'Waiting for Agent review.',
            'human_edited': True,
            'human_change_status': 'viewed',
            'human_change_version': 2,
            'last_human_changed_at': changed_at,
            'last_agent_viewed_at': changed_at,
            'attributes_json': '{}',
            'episodes': [],
        },
        {},
        {},
        {},
        {},
        {},
        {
            'entity-1': [{
                'id': 'audit-1',
                'item_id': 'entity-1',
                'item_kind': 'entity',
                'action': 'agent_view',
                'human_change_version': 2,
                'reason': 'Agent viewed the current change.',
                'created_at': changed_at,
            }]
        },
    )

    assert node.human_edited is True
    assert node.human_change_status == 'viewed'
    assert node.human_change_version == 2
    assert node.audit_events[0].action == 'agent_view'


def test_paginated_graph_queries_page_entities_and_relationships_independently():
    node_query = _node_query(project_scoped=False, paginated=True)
    edge_query = _edge_query(project_scoped=False, paginated=True)

    assert 'ORDER BY created_at DESC, id DESC' in node_query
    assert 'SKIP $offset LIMIT $limit' in node_query
    assert 'WHERE source.uuid IN $node_ids' not in edge_query
    assert 'source.name AS source_name' in edge_query
    assert 'target.name AS target_name' in edge_query
    assert 'SKIP $offset LIMIT $limit' in edge_query


def test_bounded_graph_query_keeps_edges_inside_the_returned_node_set():
    edge_query = _edge_query(project_scoped=False)

    assert 'WHERE source.uuid IN $node_ids AND target.uuid IN $node_ids' in edge_query
    assert 'SKIP $offset' not in edge_query
