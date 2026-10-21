"""Authoritative read-back of knowledge items (rec#20).

The per-turn receipt and the console's quick edit both show what is stored, read
again after it was saved: content, category, actual scope, weight with its
basis, attached tags, confirmation and source. A turn's receipt lists only the
items its episodes created or replaced; an item mentioned again changed nothing.
"""
import json
import re

from fastapi import HTTPException

from .knowledge_basis_review import basis_review
from .knowledge_dependencies import dependents_of, item_bases
from .knowledge_item_view_models import (
    KnowledgeEvidenceSource,
    KnowledgeItemRef,
    KnowledgeItemScope,
    KnowledgeItemSummary,
    KnowledgeItemTag,
    KnowledgeItemView,
    KnowledgeItemWeight,
    KnowledgeReceiptEntry,
    KnowledgeScopeProject,
    KnowledgeTurnReceipt,
    KnowledgeTurnReceiptRead,
    KnowledgeWeightBasis,
)
from .knowledge_management import _read_assignment, _read_item, _source_project_ids
from .knowledge_tags import PERSONAL_NAMESPACE, project_namespace
from .knowledge_versions import item_revisions, version_chain, version_status
from .knowledge_weight import effective_confirmation_status, knowledge_weight
from .provider_values import json_object, native_datetime

EVIDENCE_LIMIT = 10
REVISION_LIMIT = 20
EXCERPT_LIMIT = 280
_ASPECT_CATEGORY = {'taste': 'taste', 'judgment_preference': 'judgment', 'personality': 'personality'}
_RULE_TYPE = re.compile(r'rule|policy|convention|constraint|guideline|standard', re.IGNORECASE)


async def read_knowledge_item_view(store, actor: dict, request: KnowledgeItemRef) -> KnowledgeItemView:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    current = await _read_item(store, space, request.item_id, request.item_kind)
    if current is None:
        raise HTTPException(status_code=404, detail='knowledge item not found')
    evidence, source_ids = await item_evidence(store, space, request.item_kind, request.item_id)
    revisions = (await item_revisions(store, space, request.item_kind, [request.item_id])).get(request.item_id, [])
    summary = await item_summary(store, space, request.item_kind, request.item_id, current,
                                 source_ids=source_ids, revisions=revisions)
    versions = await version_chain(store, space, request.item_kind, request.item_id)
    head = next((version['item_id'] for version in versions if version['status'] == 'current'), None)
    return KnowledgeItemView(
        basis_review=basis_review(current, revisions),
        dependent_count=len(await dependents_of(store, space, request.item_kind, head or request.item_id)),
        **summary.model_dump(), evidence=evidence, evidence_count=len(source_ids),
        revisions=revisions[:REVISION_LIMIT], versions=versions,
        current_item_id=head,
        bases=await item_bases(store, space, request.item_kind, request.item_id, current))


async def read_turn_receipt(store, actor: dict, request: KnowledgeTurnReceiptRead) -> KnowledgeTurnReceipt:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    entries, unchanged = [], 0
    for item_kind, item_id, change in await episode_changes(store, space, request.episode_ids):
        if change is None:
            unchanged += 1
            continue
        current = await _read_item(store, space, item_id, item_kind)
        if current is None:
            continue
        _, source_ids = await item_evidence(store, space, item_kind, item_id, limit=0)
        summary = await item_summary(store, space, item_kind, item_id, current, source_ids=source_ids)
        entries.append(KnowledgeReceiptEntry(**summary.model_dump(), change=change))
    return KnowledgeTurnReceipt(entries=entries, unchanged_count=unchanged)


async def item_summary(store, space, item_kind, item_id, current, *, source_ids,
                       revisions=None) -> KnowledgeItemSummary:
    """`version` is the edit revision a save names (knowledge_item_version);
    `status` says whether this is the version current answers use."""
    if revisions is None:
        revisions = (await item_revisions(store, space, item_kind, [item_id])).get(item_id, [])
    scope = await item_scope(store, space, item_kind, item_id, current)
    namespaces = [PERSONAL_NAMESPACE, *(project_namespace(project.id) for project in scope.projects)]
    tags = await store.knowledge_tag_vocabulary().item_tags(space['id'], item_kind, item_id, namespaces)
    status = effective_confirmation_status(current)
    weight = knowledge_weight(current, evidence_ids=source_ids)
    title = current.get('name') if item_kind == 'entity' else current.get('type')
    content = (current.get('summary') or current.get('name')) if item_kind == 'entity' else current.get('fact')
    return KnowledgeItemSummary(
        item_kind=item_kind, item_id=item_id, version=len(revisions),
        title=title or item_id, content=content or title or '', type=current.get('type') or 'Entity',
        profile_aspect=current.get('profile_aspect'),
        category=item_category(current.get('profile_aspect'), current.get('type') or ''),
        scope=scope,
        weight=KnowledgeItemWeight(percent=weight['weight_percent'], basis=KnowledgeWeightBasis(
            confirmation_status=status, confirmed_by_person=weight['confirmed_by_person'],
            qualified_use_count=int(current.get('qualified_use_count') or 0),
            distinct_task_count=int(current.get('distinct_task_count') or 0),
            source_count=len(set(source_ids)),
            negative_evidence_count=int(current.get('negative_evidence_count') or 0))),
        tags=[KnowledgeItemTag(id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'],
                               status=tag['status'], project_id=tag.get('namespace_project_id'))
              for tag in tags],
        confirmation_status=status, content_source=current.get('content_source'),
        invalid_at=native_datetime(current.get('invalid_at')),
        created_at=native_datetime(current.get('created_at')),
        status=version_status(current.get('invalid_at'), current.get('replaced_by_item_id'), revisions))


def item_category(profile_aspect: str | None, item_type: str) -> str:
    if profile_aspect in _ASPECT_CATEGORY:
        return _ASPECT_CATEGORY[profile_aspect]
    if 'experience' in item_type.lower():
        return 'experience'
    if _RULE_TYPE.search(item_type):
        return 'rule'
    return 'fact' if item_type.lower().endswith('fact') else 'knowledge'


async def item_scope(store, space, item_kind, item_id, current) -> KnowledgeItemScope:
    """Where the item applies now. A preference carries its own scope; other
    knowledge belongs to its assigned project, else the projects its sources name."""
    status = 'undetermined' if current.get('scope_status') == 'undetermined' else 'set'
    agent_id = None
    if current.get('profile_aspect'):
        preference_scope = current.get('preference_scope') or 'global'
        if preference_scope == 'global':
            return KnowledgeItemScope(kind='global', status=status)
        project_ids = list(current.get('preference_project_ids') or []) or [
            project for project in [current.get('preference_project_id')] if project]
        agent_id = current.get('preference_agent_id') if preference_scope == 'agent' else None
    else:
        assignment = await _read_assignment(store, space['id'], item_id, item_kind)
        project_ids = [assignment.project_id] if assignment else await _source_project_ids(
            store, space, item_id, item_kind)
    projects = await scope_projects(store, space, project_ids)
    if not projects:
        return KnowledgeItemScope(kind='unknown', status=status)
    if agent_id:
        return KnowledgeItemScope(kind='agent', projects=projects, agent_id=agent_id,
                                  agent_name=await _agent_name(store, space, agent_id), status=status)
    kind = 'temporary' if all(project.temporary for project in projects) else 'projects'
    return KnowledgeItemScope(kind=kind, projects=projects, status=status)


async def personal_reader_space(store, actor, space_id):
    store._require_personal()
    space = await store.authorize(actor, space_id, 'reader')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='knowledge item views are personal-only')
    return space


async def scope_projects(store, space, project_ids) -> list[KnowledgeScopeProject]:
    if not project_ids:
        return []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->
              (project:FuliPersonalProject)
        WHERE project.project_id IN $project_ids
        RETURN project.project_id AS id, project.name AS name,
               project.profile_json AS profile_json, project.scope_type AS scope_type
        ''', space_id=space['id'], project_ids=list(project_ids), routing_='r')
    found = {record['id']: record for record in records}
    return [KnowledgeScopeProject(
        id=project_id,
        name=found[project_id]['name'] or json_object(found[project_id]['profile_json']).get('name'),
        temporary=found[project_id]['scope_type'] == 'temporary',
    ) for project_id in project_ids if project_id in found]


async def _agent_name(store, space, agent_id) -> str | None:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: $agent_id})
        RETURN agent.profile_json AS profile_json
        ''', space_id=space['id'], agent_id=agent_id, routing_='r')
    return json_object(records[0]['profile_json']).get('name') if records else None


async def episode_changes(store, space, episode_ids):
    """(kind, id, change) for every item the episodes wrote. created: the item
    came into being with that episode; updated: a new fact replaced an older
    one; None: the episode only mentioned an existing item again."""
    entities, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item:Entity {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids
        WITH item, collect(episode.created_at) AS episode_times
        RETURN item.uuid AS item_id, item.created_at IN episode_times AS created,
               item.created_at AS created_at
        ORDER BY created_at, item_id
        ''', group_id=space['group_id'], episode_ids=episode_ids, routing_='r')
    relationships, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids
        UNWIND coalesce(episode.entity_edges, []) AS edge_id
        MATCH ()-[item:RELATES_TO {uuid: edge_id, group_id: $group_id}]->()
        WITH item, collect(episode.created_at) AS episode_times
        OPTIONAL MATCH ()-[old:RELATES_TO {group_id: $group_id}]->()
        WHERE old.fuli_replaced_by_item_id = item.uuid
        WITH item, episode_times, count(old) AS replaced
        RETURN item.uuid AS item_id, item.created_at IN episode_times AS created,
               replaced > 0 AS replaces, item.created_at AS created_at
        ORDER BY created_at, item_id
        ''', group_id=space['group_id'], episode_ids=episode_ids, routing_='r')
    return [
        *(('entity', record['item_id'], 'created' if record['created'] else None) for record in entities),
        *(('relationship', record['item_id'],
           ('updated' if record['replaces'] else 'created') if record['created'] else None)
          for record in relationships),
    ]


async def item_evidence(store, space, item_kind, item_id, *, limit=EVIDENCE_LIMIT):
    match = (
        'MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(:Entity {uuid: $item_id, group_id: $group_id})'
        if item_kind == 'entity' else
        'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->() '
        'UNWIND coalesce(item.episodes, []) AS episode_id '
        'MATCH (episode:Episodic {uuid: episode_id, group_id: $group_id})')
    records, _, _ = await store.runtime.driver.execute_query(
        match + '''
        WITH DISTINCT episode ORDER BY episode.created_at DESC
        WITH collect(episode) AS episodes
        RETURN [episode IN episodes | episode.uuid] AS ids, [episode IN episodes[..$limit] | episode {
          .uuid, .created_at, .fuli_source_kind, .fuli_source_application, .fuli_session_id,
          .fuli_conversation_id, .fuli_source_turn_id, .fuli_source_excerpt, .fuli_personal_project_id
        }] AS episodes
        ''', group_id=space['group_id'], item_id=item_id, limit=limit, routing_='r')
    if not records:
        return [], []
    return [KnowledgeEvidenceSource(
        episode_id=episode['uuid'], source_kind=episode.get('fuli_source_kind'),
        source_application=episode.get('fuli_source_application'),
        session_id=episode.get('fuli_session_id'), conversation_id=episode.get('fuli_conversation_id'),
        source_turn_id=episode.get('fuli_source_turn_id'),
        excerpt=(episode.get('fuli_source_excerpt') or '')[:EXCERPT_LIMIT] or None,
        personal_project_id=episode.get('fuli_personal_project_id'),
        created_at=native_datetime(episode.get('created_at')),
    ) for episode in records[0]['episodes']], list(records[0]['ids'])


def scope_snapshot(scope: KnowledgeItemScope) -> dict:
    """The scope as a revision records it, so history shows where it applied."""
    return json.loads(scope.model_dump_json(include={'kind', 'projects', 'agent_id', 'status'}))
