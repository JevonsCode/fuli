from collections.abc import Iterable

from .graph_models import GraphEdge, GraphNode
from .models import ProjectProfile
from .provider_values import native_datetime


def management_projection(
    space: dict,
    personal_projects: Iterable[dict] = (),
    project_relations: Iterable[dict] = (),
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Expose Fuli management nodes beside Graphiti knowledge entities."""
    root_id = f"space:{space['id']}"
    root_type = 'ProjectSpace' if space['kind'] == 'project' else 'PersonalSpace'
    fallback = '公共项目空间' if space['kind'] == 'project' else '本机个人知识空间'
    nodes = [GraphNode(
        id=root_id,
        name=space['name'],
        type=root_type,
        group_id=space['group_id'],
        summary=_profile_summary(space.get('profile_json')) or space.get('description') or fallback,
    )]
    edges: list[GraphEdge] = []

    project_node_ids = {}
    for project in personal_projects:
        project_node_id = f"personal-project:{project['id']}"
        project_node_ids[project.get('project_id', project['id'])] = project_node_id
        nodes.append(GraphNode(
            id=project_node_id,
            name=project['name'],
            type='PersonalProject',
            group_id=space['group_id'],
            summary=_profile_summary(project.get('profile_json')) or '本机个人项目档案',
            attributes={
                'projectId': project.get('project_id', project['id']),
                'publicationKey': project.get('publication_key'),
            },
        ))
        edges.append(GraphEdge(
            id=f"contains-project:{project['id']}",
            source=root_id,
            target=project_node_id,
            type='CONTAINS_PROJECT',
            fact=f"个人项目“{project['name']}”保存在该个人空间中。",
            valid_at=None,
            invalid_at=None,
        ))

    for relation in project_relations:
        source_id = project_node_ids.get(relation['source_project_id'])
        target_id = project_node_ids.get(relation['target_project_id'])
        if not source_id or not target_id:
            continue
        edges.append(GraphEdge(
            id=f"personal-project-relation:{relation['id']}",
            source=source_id,
            target=target_id,
            type=relation['relation_type'],
            fact=_relation_fact(relation),
            attributes=_relation_attributes(relation),
            valid_at=None,
            invalid_at=None,
        ))
    return nodes, edges


def personal_project_projection(
    space: dict,
    project: dict,
    project_relations: Iterable[dict] = (),
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Expand one local project profile without leaking the rest of the personal graph."""
    profile = ProjectProfile.model_validate_json(project['profile_json'])
    project_id = project['id']
    root_id = f'personal-project:{project_id}'
    group_id = space['group_id']
    nodes = [GraphNode(
        id=root_id,
        name=profile.name,
        type='PersonalProject',
        group_id=group_id,
        summary=profile.purpose or profile.technical_summary or profile.scope or '本机个人项目档案',
        attributes={
            'projectId': project['project_id'],
            'lifecycle': profile.lifecycle,
            'publicationKey': project.get('publication_key'),
        },
    )]
    edges: list[GraphEdge] = []

    related_node_ids = set()
    for relation in project_relations:
        current_project_id = project['project_id']
        if current_project_id not in {
            relation['source_project_id'], relation['target_project_id']
        }:
            continue
        current_is_source = relation['source_project_id'] == current_project_id
        related_project_id = (
            relation['target_project_id'] if current_is_source
            else relation['source_project_id']
        )
        related_name = relation['target_name'] if current_is_source else relation['source_name']
        related_id = f'personal-project-related:{related_project_id}'
        if related_id not in related_node_ids:
            related_node_ids.add(related_id)
            nodes.append(GraphNode(
                id=related_id,
                name=related_name,
                type='RelatedPersonalProject',
                group_id=group_id,
                summary='与当前个人项目显式关联的项目。',
                attributes={'projectId': related_project_id},
            ))
        edges.append(GraphEdge(
            id=f"personal-project-relation:{relation['id']}",
            source=root_id if current_is_source else related_id,
            target=related_id if current_is_source else root_id,
            type=relation['relation_type'],
            fact=_relation_fact(relation),
            attributes=_relation_attributes(relation),
            valid_at=None,
            invalid_at=None,
        ))

    fields = (
        ('purpose', '项目目标', 'ProjectPurpose', profile.purpose, 'HAS_PURPOSE'),
        ('scope', '项目范围', 'ProjectScope', profile.scope, 'HAS_SCOPE'),
        (
            'technical-summary', '技术说明', 'TechnicalSummary',
            profile.technical_summary, 'HAS_TECHNICAL_SUMMARY',
        ),
    )
    for key, name, node_type, summary, relation in fields:
        if summary:
            _append_profile_node(
                nodes, edges, root_id, group_id, project_id, key,
                name, node_type, summary, relation,
            )

    for source in profile.sources:
        _append_profile_node(
            nodes, edges, root_id, group_id, project_id, f'source:{source.key}',
            source.title, 'ProjectSource', source.summary or source.uri or '已登记项目资料',
            'HAS_SOURCE', attributes={
                'kind': source.kind,
                'uri': source.uri,
                'sensitivity': source.sensitivity,
            },
        )

    for index, boundary in enumerate(profile.boundaries):
        _append_profile_node(
            nodes, edges, root_id, group_id, project_id, f'boundary:{index}',
            _compact_name(boundary), 'ProjectBoundary', boundary, 'GOVERNS',
        )

    if profile.assessment:
        assessment = profile.assessment
        assessment_id = _append_profile_node(
            nodes, edges, root_id, group_id, project_id, 'assessment',
            f'资料覆盖 {assessment.score}', 'ProjectAssessment',
            _assessment_summary(assessment), 'ASSESSED_AS', attributes={
                'score': assessment.score,
                'label': assessment.label,
                'analyzedAt': assessment.analyzed_at.isoformat(),
                'confirmed': assessment.confirmed,
                'inferred': assessment.inferred,
            },
        )
        for dimension in assessment.dimensions:
            _append_profile_node(
                nodes, edges, assessment_id, group_id, project_id,
                f'assessment:{dimension.key}', dimension.label,
                'AssessmentDimension',
                '；'.join(dimension.evidence[:3]) or dimension.label,
                'MEASURES', attributes={
                    'score': dimension.score,
                    'state': dimension.state,
                    'evidence': dimension.evidence,
                },
            )

    return nodes, edges


def _relation_attributes(relation: dict) -> dict:
    return {
        'status': relation.get('status') or 'pending',
        'confirmationAuthority': relation.get('confirmation_authority'),
        'decisionRevision': int(relation.get('decision_revision') or 0),
        'reviewReason': relation.get('review_reason'),
        'reviewedBy': relation.get('reviewed_by'),
        'reviewedAt': native_datetime(relation.get('reviewed_at')),
    }


def coalesce_personal_project_identity(
    project: dict,
    management_nodes: list[GraphNode],
    management_edges: list[GraphEdge],
    knowledge_nodes: list[GraphNode],
    knowledge_edges: list[GraphEdge],
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Render one project root while preserving its Graphiti evidence and relations."""
    return coalesce_personal_project_identities(
        [project],
        management_nodes,
        management_edges,
        knowledge_nodes,
        knowledge_edges,
    )


def coalesce_personal_project_identities(
    projects: Iterable[dict],
    management_nodes: list[GraphNode],
    management_edges: list[GraphEdge],
    knowledge_nodes: list[GraphNode],
    knowledge_edges: list[GraphEdge],
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Use one canonical node per personal project in an aggregate personal graph."""
    identities = [_project_identity(project) for project in projects]
    aliases_by_root: dict[str, list[GraphNode]] = {}
    alias_targets: dict[str, str] = {}

    for node in knowledge_nodes:
        target = _matching_project_root(node, identities)
        if target is None:
            continue
        alias_targets[node.id] = target
        aliases_by_root.setdefault(target, []).append(node)

    if not alias_targets:
        return management_nodes + knowledge_nodes, management_edges + knowledge_edges

    nodes = [
        _merge_project_root(node, aliases_by_root[node.id])
        if node.id in aliases_by_root else node
        for node in management_nodes
    ]
    nodes.extend(node for node in knowledge_nodes if node.id not in alias_targets)

    edges = list(management_edges)
    for edge in knowledge_edges:
        source = alias_targets.get(edge.source, edge.source)
        target = alias_targets.get(edge.target, edge.target)
        if source == target:
            continue
        edges.append(edge.model_copy(update={'source': source, 'target': target}))
    return nodes, edges


def _project_identity(project: dict) -> dict[str, str]:
    profile = ProjectProfile.model_validate_json(project['profile_json'])
    return {
        'project_id': project['project_id'],
        'name': profile.name,
        'root_id': f"personal-project:{project['id']}",
    }


def _matching_project_root(node: GraphNode, identities: list[dict[str, str]]) -> str | None:
    if node.type != 'Project':
        return None
    explicit_project_id = node.attributes.get(
        'projectId', node.attributes.get('project_id')
    )
    if explicit_project_id is not None:
        matches = [
            identity for identity in identities
            if identity['project_id'] == str(explicit_project_id)
        ]
    else:
        normalized_name = _normalized_project_name(node.name)
        matches = [
            identity for identity in identities
            if _normalized_project_name(identity['name']) == normalized_name
        ]
    return matches[0]['root_id'] if len(matches) == 1 else None


def _append_profile_node(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    parent_id: str,
    group_id: str,
    project_id: str,
    key: str,
    name: str,
    node_type: str,
    summary: str,
    relation: str,
    *,
    attributes: dict | None = None,
) -> str:
    node_id = f'project-profile:{project_id}:{key}'
    nodes.append(GraphNode(
        id=node_id,
        name=name,
        type=node_type,
        group_id=group_id,
        summary=summary,
        attributes={key: value for key, value in (attributes or {}).items() if value is not None},
    ))
    edges.append(GraphEdge(
        id=f'project-profile-edge:{project_id}:{key}',
        source=parent_id,
        target=node_id,
        type=relation,
        fact=summary,
        valid_at=None,
        invalid_at=None,
    ))
    return node_id


def _merge_project_root(root: GraphNode, aliases: list[GraphNode]) -> GraphNode:
    attributes = {}
    for alias in aliases:
        attributes.update(alias.attributes)
    project_definitions = list(dict.fromkeys(
        alias.summary for alias in aliases if alias.summary
    ))
    if project_definitions:
        attributes['projectDefinition'] = '；'.join(project_definitions)
    attributes.update(root.attributes)
    created_values = [
        node.created_at for node in [root, *aliases] if node.created_at is not None
    ]
    summary = root.summary
    if summary == '本机个人项目档案':
        summary = next((node.summary for node in aliases if node.summary), summary)
    human_alias = max(
        (node for node in aliases if node.human_edited),
        key=lambda node: str(node.last_human_changed_at or node.created_at or ''),
        default=None,
    )
    return root.model_copy(update={
        'summary': summary,
        'attributes': attributes,
        'evidence': _unique_records(root.evidence, aliases, 'evidence'),
        'revisions': _unique_records(root.revisions, aliases, 'revisions'),
        'assignments': _unique_records(root.assignments, aliases, 'assignments'),
        'project_references': _unique_records(
            root.project_references, aliases, 'project_references'
        ),
        'conflicts': _unique_records(root.conflicts, aliases, 'conflicts'),
        'audit_events': _unique_records(root.audit_events, aliases, 'audit_events'),
        'human_edited': human_alias is not None,
        'human_change_status': (
            human_alias.human_change_status if human_alias else 'none'
        ),
        'human_change_version': (
            human_alias.human_change_version if human_alias else 0
        ),
        'last_human_changed_at': (
            human_alias.last_human_changed_at if human_alias else None
        ),
        'last_agent_viewed_at': (
            human_alias.last_agent_viewed_at if human_alias else None
        ),
        'last_agent_reviewed_at': (
            human_alias.last_agent_reviewed_at if human_alias else None
        ),
        'created_at': min(created_values) if created_values else None,
        'reasoning_summary': root.reasoning_summary or next(
            (node.reasoning_summary for node in aliases if node.reasoning_summary),
            None,
        ),
    })


def _unique_records(existing: list, aliases: list[GraphNode], field: str) -> list:
    records = [*existing]
    for alias in aliases:
        records.extend(getattr(alias, field))
    result = []
    seen = set()
    for record in records:
        record_id = getattr(record, 'id', None)
        if record_id in seen:
            continue
        seen.add(record_id)
        result.append(record)
    return result


def _normalized_project_name(value: str) -> str:
    return ''.join(value.casefold().split())


def _compact_name(value: str) -> str:
    return value if len(value) <= 24 else f'{value[:23]}…'


def _assessment_summary(assessment) -> str:
    recorded = len(assessment.confirmed) + len(assessment.inferred)
    dimensions = sum(1 for dimension in assessment.dimensions if dimension.evidence)
    return f'已记录 {recorded} 项已有信息，覆盖 {dimensions} 个资料维度。'


def _profile_summary(raw_profile: str | None) -> str:
    if not raw_profile:
        return ''
    try:
        profile = ProjectProfile.model_validate_json(raw_profile)
    except ValueError:
        return ''
    return profile.purpose or profile.technical_summary or profile.scope or ''


def _relation_fact(relation: dict) -> str:
    return (
        f"个人项目“{relation['source_name']}”通过 {relation['relation_type']} "
        f"关联“{relation['target_name']}”。"
    )
