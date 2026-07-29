from fuli_graph.graph_projection import (
    coalesce_personal_project_identities,
    coalesce_personal_project_identity,
    management_projection,
    personal_project_projection,
)
from fuli_graph.models import GraphEdge, GraphEvidence, GraphNode


def test_public_project_space_is_visible_as_the_graph_root():
    nodes, edges = management_projection({
        'id': 'project-1',
        'name': 'Fuli',
        'kind': 'project',
        'group_id': 'workspace-project-1',
        'description': None,
        'profile_json': '{"name":"Fuli","purpose":"Reusable context","sources":[],"boundaries":[]}',
    })

    assert len(nodes) == 1
    assert nodes[0].id == 'space:project-1'
    assert nodes[0].type == 'ProjectSpace'
    assert nodes[0].summary == 'Reusable context'
    assert edges == []


def test_personal_projects_are_connected_to_the_personal_space_root():
    nodes, edges = management_projection(
        {
            'id': 'personal-1',
            'name': 'Me',
            'kind': 'personal',
            'group_id': 'personal-group',
            'description': None,
        },
        [{
            'id': 'project-node-1',
            'project_id': 'hotel-theme',
            'publication_key': None,
            'name': 'Hotel Theme',
            'profile_json': '{"name":"Hotel Theme","purpose":"Campaign pages","sources":[],"boundaries":[]}',
        }],
    )

    assert [node.type for node in nodes] == ['PersonalSpace', 'PersonalProject']
    assert edges[0].source == 'space:personal-1'
    assert edges[0].target == 'personal-project:project-node-1'
    assert edges[0].type == 'CONTAINS_PROJECT'
    assert nodes[1].attributes['projectId'] == 'hotel-theme'


def test_personal_project_projection_expands_profile_without_personal_space_siblings():
    nodes, edges = personal_project_projection(
        {'id': 'personal-1', 'kind': 'personal', 'group_id': 'personal-group'},
        {
            'id': 'project-node-1',
            'project_id': 'fuli',
            'publication_key': 'publication-key',
            'profile_json': '''{
              "name":"Fuli",
              "purpose":"Reusable project context",
              "scope":"Personal and public graphs",
              "lifecycle":"active",
              "sources":[{
                "key":"prd",
                "kind":"prd",
                "title":"Product requirements",
                "uri":"docs/prd.md",
                "sensitivity":"normal"
              }],
              "boundaries":["Only explicit project knowledge belongs here"]
            }''',
        },
    )

    assert nodes[0].type == 'PersonalProject'
    assert all(node.type != 'PersonalSpace' for node in nodes)
    assert {node.type for node in nodes} >= {
        'ProjectPurpose', 'ProjectScope', 'ProjectSource', 'ProjectBoundary'
    }
    source = next(node for node in nodes if node.type == 'ProjectSource')
    assert source.attributes['uri'] == 'docs/prd.md'
    assert {edge.type for edge in edges} >= {'HAS_PURPOSE', 'HAS_SOURCE', 'GOVERNS'}


def test_personal_project_identity_coalesces_graphiti_project_entity():
    project = {
        'id': 'project-node-1',
        'project_id': 'fuli',
        'publication_key': None,
        'profile_json': '''{
          "name":"Fuli",
          "purpose":"Reusable project context",
          "sources":[],
          "boundaries":[]
        }''',
    }
    management_nodes, management_edges = personal_project_projection(
        {'id': 'personal-1', 'kind': 'personal', 'group_id': 'personal-group'},
        project,
    )
    knowledge_nodes = [
        GraphNode(
            id='entity-project',
            name='Fuli',
            type='Project',
            group_id='personal-group',
            summary='Personal and public context graph tool',
            evidence=[GraphEvidence(
                id='episode-1',
                name='Project definition',
                source_description='Confirmed project definition',
                source_kind='conversation',
                summary='Defines Fuli as a context graph tool',
                source_application='codex',
                source_turn_id='turn-7',
                source_excerpt='The user confirmed the project definition.',
            )],
        ),
        GraphNode(
            id='entity-rule',
            name='Knowledge rule',
            type='ProductRequirement',
            group_id='personal-group',
            summary='Keep evidence',
        ),
    ]
    knowledge_edges = [GraphEdge(
        id='edge-1',
        source='entity-project',
        target='entity-rule',
        type='REQUIRES',
        fact='Fuli requires the knowledge rule.',
        valid_at=None,
        invalid_at=None,
    )]

    nodes, edges = coalesce_personal_project_identity(
        project,
        management_nodes,
        management_edges,
        knowledge_nodes,
        knowledge_edges,
    )

    project_nodes = [node for node in nodes if node.name == 'Fuli']
    assert len(project_nodes) == 1
    assert project_nodes[0].type == 'PersonalProject'
    assert project_nodes[0].attributes['projectDefinition'] == (
        'Personal and public context graph tool'
    )
    assert [item.id for item in project_nodes[0].evidence] == ['episode-1']
    assert project_nodes[0].evidence[0].source_application == 'codex'
    assert next(edge for edge in edges if edge.id == 'edge-1').source == project_nodes[0].id


def test_personal_project_identity_respects_explicit_different_project_id():
    project = {
        'id': 'project-node-1',
        'project_id': 'fuli',
        'publication_key': None,
        'profile_json': '''{
          "name":"Fuli",
          "purpose":"Reusable project context",
          "sources":[],
          "boundaries":[]
        }''',
    }
    management_nodes, management_edges = personal_project_projection(
        {'id': 'personal-1', 'kind': 'personal', 'group_id': 'personal-group'},
        project,
    )
    different_project = GraphNode(
        id='entity-project',
        name='Fuli',
        type='Project',
        group_id='personal-group',
        summary='A different project with the same display name',
        attributes={'projectId': 'different-project'},
    )

    nodes, _ = coalesce_personal_project_identity(
        project,
        management_nodes,
        management_edges,
        [different_project],
        [],
    )

    assert len([node for node in nodes if node.name == 'Fuli']) == 2


def test_aggregate_personal_graph_coalesces_each_unambiguous_project_identity():
    projects = [
        {
            'id': 'project-node-1',
            'project_id': 'fuli',
            'publication_key': None,
            'name': 'Fuli',
            'profile_json': '{"name":"Fuli","purpose":"Context graph","sources":[],"boundaries":[]}',
        },
        {
            'id': 'project-node-2',
            'project_id': 'hotel-theme',
            'publication_key': None,
            'name': 'Hotel Theme',
            'profile_json': '{"name":"Hotel Theme","purpose":"Campaign flow","sources":[],"boundaries":[]}',
        },
    ]
    management_nodes, management_edges = management_projection(
        {
            'id': 'personal-1',
            'name': 'Me',
            'kind': 'personal',
            'group_id': 'personal-group',
            'description': None,
        },
        projects,
    )
    knowledge_nodes = [
        GraphNode(
            id='entity-fuli', name='Fuli', type='Project', group_id='personal-group',
            summary='Fuli knowledge identity',
        ),
        GraphNode(
            id='entity-hotel', name='Hotel Theme', type='Project',
            group_id='personal-group', summary='Hotel knowledge identity',
            attributes={'projectId': 'hotel-theme'},
        ),
        GraphNode(
            id='entity-rule', name='Rule', type='Requirement',
            group_id='personal-group', summary='Keep evidence',
        ),
    ]
    knowledge_edges = [GraphEdge(
        id='edge-1', source='entity-fuli', target='entity-rule',
        type='REQUIRES', fact='Fuli requires the rule.', valid_at=None, invalid_at=None,
    )]

    nodes, edges = coalesce_personal_project_identities(
        projects,
        management_nodes,
        management_edges,
        knowledge_nodes,
        knowledge_edges,
    )

    assert len([node for node in nodes if node.name == 'Fuli']) == 1
    assert len([node for node in nodes if node.name == 'Hotel Theme']) == 1
    fuli = next(node for node in nodes if node.name == 'Fuli')
    assert fuli.type == 'PersonalProject'
    assert fuli.attributes['projectDefinition'] == 'Fuli knowledge identity'
    assert next(edge for edge in edges if edge.id == 'edge-1').source == fuli.id


def test_aggregate_personal_graph_does_not_guess_between_duplicate_project_names():
    projects = [
        {
            'id': 'project-node-1', 'project_id': 'first', 'publication_key': None,
            'name': 'Same',
            'profile_json': '{"name":"Same","purpose":"First","sources":[],"boundaries":[]}',
        },
        {
            'id': 'project-node-2', 'project_id': 'second', 'publication_key': None,
            'name': 'Same',
            'profile_json': '{"name":"Same","purpose":"Second","sources":[],"boundaries":[]}',
        },
    ]
    management_nodes, management_edges = management_projection(
        {
            'id': 'personal-1', 'name': 'Me', 'kind': 'personal',
            'group_id': 'personal-group', 'description': None,
        },
        projects,
    )
    ambiguous = GraphNode(
        id='entity-same', name='Same', type='Project', group_id='personal-group',
        summary='Ambiguous project identity',
    )

    nodes, _ = coalesce_personal_project_identities(
        projects, management_nodes, management_edges, [ambiguous], []
    )

    assert len([node for node in nodes if node.name == 'Same']) == 3
