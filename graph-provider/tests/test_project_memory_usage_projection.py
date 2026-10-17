from datetime import UTC, datetime

from fuli_graph.graph_models import GraphNode
from fuli_graph.project_memory_usage_projection import append_memory_usage_projection


def observation(target, count):
    return dict(id='usage-' + target, source_project_id='a', source_name='A',
                target_project_id=target, target_name=target.upper(),
                statistics=dict(totalCount=count, recent30dCount=count,
                                lastUsedAt=datetime(2026, 10, 18, tzinfo=UTC),
                                tier='close', suggestKnowledgeReuse=True,
                                requiresHumanConfirmation=True, grantsAccess=False))


def test_observation_edges_are_separate_from_authority_and_top_three_are_deterministic():
    node = GraphNode(id='root-a', name='A', type='PersonalProject', group_id='g',
                     summary='A', attributes={'projectId': 'a'})
    nodes, edges = append_memory_usage_projection([node], [], [
        observation('d', 2), observation('c', 3), observation('b', 3), observation('e', 1),
    ], group_id='g', project_id='a')
    assert len(nodes) == 5
    assert {edge.type for edge in edges} == {'PROJECT_MEMORY_ACCESS'}
    assert all(edge.attributes['grantsAccess'] is False for edge in edges)
    assert [item['projectId'] for item in nodes[0].attributes['frequentProjects']] == ['b', 'c', 'd']
    assert node.attributes == {'projectId': 'a'}


def test_scoped_graph_does_not_include_an_unrelated_observation():
    nodes, edges = append_memory_usage_projection([], [], [observation('b', 1)],
                                                  group_id='g', project_id='unrelated')
    assert nodes == edges == []
