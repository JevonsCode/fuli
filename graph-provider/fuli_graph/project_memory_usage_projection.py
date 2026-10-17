"""Render observations separately from confirmed project relationships."""

from .graph_models import GraphEdge, GraphNode


def append_memory_usage_projection(nodes, edges, observations, *, group_id, project_id=None):
    nodes = [node.model_copy(update={'attributes': dict(node.attributes)}) for node in nodes]
    edges = list(edges)
    projects = {node.attributes['projectId']: node for node in nodes
                if node.type in {'PersonalProject', 'RelatedPersonalProject'}
                and node.attributes.get('projectId')}
    outgoing = {}
    for observation in observations:
        source, target = observation['source_project_id'], observation['target_project_id']
        if project_id and project_id not in {source, target}:
            continue
        if not project_id and (source not in projects or target not in projects):
            continue
        for key, name in [(source, observation['source_name']), (target, observation['target_name'])]:
            if key not in projects:
                node = GraphNode(id=f'personal-project-observed:{key}', name=name,
                    type='RelatedPersonalProject', group_id=group_id,
                    summary='项目取忆观测 / Observed project memory use', attributes={'projectId': key})
                projects[key] = node
                nodes.append(node)
        statistics = observation['statistics']
        edges.append(GraphEdge(id=f"project-memory-usage:{observation['id']}",
            source=projects[source].id, target=projects[target].id, type='PROJECT_MEMORY_ACCESS',
            fact=f"{observation['source_name']} → {observation['target_name']}: {statistics['totalCount']}",
            attributes=dict(statistics), valid_at=None, invalid_at=None))
        outgoing.setdefault(source, []).append({'projectId': target, 'name': observation['target_name'], **statistics})
    for source, items in outgoing.items():
        projects[source].attributes['frequentProjects'] = sorted(items,
            key=lambda item: (-item['recent30dCount'], -item['totalCount'], item['projectId']))[:3]
    return nodes, edges
