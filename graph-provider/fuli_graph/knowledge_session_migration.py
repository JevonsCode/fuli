"""A session's batch migration into a formal project (rec#20 part 2).

What a host session saved while nobody chose where it applies waits in that
session's temporary project. Once the session works in a formal project, the
person is offered to move those items there: the preview lists exactly the
items still held, and the person moves all of them or any subset. Nothing
moves on its own, and an Agent can only link to the console page, except
the topic promotion below.

Each item moves through the quick edit's own scope change
(knowledge_scope_edit.apply_scope_change): the same ID, a scope_change
revision, its confirmation untouched, so an Agent-inferred item stays pending.
The whole batch is one transaction. When any chosen item changed since the
preview (a newer edit revision, or it no longer waits there), nothing moves
and the answer names every such item, so the person decides on what is
stored now.

One Agent/system path exists (rec#11 D-86): when the person's setting lets
Astro form a recurring topic into a project, or the person accepts it, what
the topic's own sessions hold moves there (move_session_knowledge), recorded
as the Assistant with a reason naming the topic. It moves exactly what is
held when it runs, with the same guard and revisions as the person's batch.
"""
from fastapi import HTTPException

from .knowledge_item_version import edit_revision
from .knowledge_item_view import item_evidence, item_scope, item_summary, personal_reader_space, scope_projects
from .knowledge_item_view_models import KnowledgeScopeChange
from .knowledge_management import _read_item
from .knowledge_project_scope import refused_for_match
from .knowledge_scope_edit import apply_scope_change, place_scope_as, scope_editor_space
from .knowledge_versions import lock_knowledge
from .knowledge_visibility import fla_own_work_cypher, hidden_refs, reader_parameter, request_reader
from .knowledge_session_migration_models import (
    SessionMigrationApply,
    SessionMigrationMoved,
    SessionMigrationPreview,
    SessionMigrationRead,
    SessionMigrationResult,
)
from .personal_project_access import authorize_personal_project
from .store_transactions import query_store_transaction
from .temporary_project_scope import session_temporary_project_id


async def preview_session_migration(store, actor: dict, request: SessionMigrationRead) -> SessionMigrationPreview:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    target = await _target_project(store, actor, space, request.target_project_id)
    temporary_id = session_temporary_project_id(space['id'], request.source_application, request.session_id)
    held = await held_items(store, space, temporary_id)
    # An Agent's offer neither counts nor lists another FLA's held items, nor
    # counts another FLA's words among a listed item's sources.
    reader = await request_reader(store, actor, space, request)
    hidden = await hidden_refs(store, space, reader, [(item_kind, item_id) for item_kind, item_id, _ in held])
    held = [row for row in held if (row[0], row[1]) not in hidden]
    items = []
    end = request.offset + request.limit
    if request.include_items:
        for item_kind, item_id, current in held[request.offset:end]:
            _, source_ids = await item_evidence(store, space, item_kind, item_id, limit=0, reader=reader)
            items.append(await item_summary(store, space, item_kind, item_id, current, source_ids=source_ids))
    return SessionMigrationPreview(
        temporary_project_id=temporary_id, target_project=target, held_count=len(held),
        linked_task_count=await _linked_task_count(store, space, request, reader), items=items,
        next_offset=end if request.include_items and end < len(held) else None)


async def apply_session_migration(store, actor: dict, request: SessionMigrationApply) -> SessionMigrationResult:
    space = await scope_editor_space(store, actor, request.personal_space_id)
    temporary_id = session_temporary_project_id(space['id'], request.source_application, request.session_id)
    async with query_store_transaction(store) as scoped:
        # Held check, version check and every write under one lock: no
        # reference or reassignment lands in between (dot P1-2).
        await lock_knowledge(scoped, space)
        await _target_project(scoped, actor, space, request.target_project_id)
        stale = await _stale_items(scoped, space, temporary_id, request.items)
        if stale:
            raise HTTPException(status_code=409, detail={
                'code': 'stale_version', 'stale_items': stale,
                'message': 'some items changed since the migration was shown; nothing moved, read it again'})
        moved = []
        for item in request.items:
            result = await apply_scope_change(scoped, actor, space, item.item_id, KnowledgeScopeChange(
                personal_space_id=space['id'], item_kind=item.item_kind, expected_version=item.expected_version,
                reason=request.reason, scope='projects', project_ids=[request.target_project_id]))
            moved.append(SessionMigrationMoved(**result))
    return SessionMigrationResult(target_project_id=request.target_project_id, moved=moved)


async def move_session_knowledge(scoped, actor: dict, space: dict, temporary_id: str, target_project_id: str, *,
                                 author_id: str, reason: str) -> dict:
    """The Agent/system path (rec#11 D-86): every item the session holds now
    moves to the target, inside the caller's transaction and knowledge lock.
    Each moves at the version read under that lock, through the same scope
    change and revision as the person's batch. An entity the target already
    has a match for stays held: only the person decides how two relate."""
    await _target_project(scoped, actor, space, target_project_id)
    moved, kept = [], []
    for item_kind, item_id, _ in await held_items(scoped, space, temporary_id):
        version = await edit_revision(scoped, space, item_kind, item_id)
        try:
            moved.append(await place_scope_as(scoped, actor, space, author_id, item_kind, item_id,
                                              expected_version=version, project_ids=[target_project_id],
                                              reason=reason))
        except HTTPException as error:
            if not refused_for_match(error):
                raise
            kept.append({'item_kind': item_kind, 'item_id': item_id, 'reason': 'project_has_match'})
    return {'moved': moved, 'kept': kept}


async def _stale_items(scoped, space, temporary_id, items) -> list[dict]:
    """Each chosen item no longer held, or at another version than was shown."""
    held = {(item_kind, item_id) for item_kind, item_id, _ in await held_items(scoped, space, temporary_id)}
    stale = []
    for item in items:
        if (item.item_kind, item.item_id) not in held:
            stale.append({'item_kind': item.item_kind, 'item_id': item.item_id, 'reason': 'not_held'})
            continue
        version = await edit_revision(scoped, space, item.item_kind, item.item_id)
        if version != item.expected_version:
            stale.append({'item_kind': item.item_kind, 'item_id': item.item_id, 'reason': 'changed',
                          'current_version': version})
    return stale


async def held_items(store, space, temporary_id) -> list[tuple[str, str, dict]]:
    """(kind, id, stored item) of every current item that applies to the
    temporary project alone, oldest first: what the session saved there or
    was placed there, and nothing that already applies anywhere else."""
    held = []
    for item_kind, item_id in await _candidates(store, space, temporary_id):
        current = await _read_item(store, space, item_id, item_kind)
        if current is None or current.get('invalid_at'):
            continue
        scope = await item_scope(store, space, item_kind, item_id, current)
        if scope.kind == 'temporary' and [project.id for project in scope.projects] == [temporary_id]:
            held.append((item_kind, item_id, current))
    return sorted(held, key=lambda row: (str(row[2].get('created_at') or ''), row[1]))


async def _candidates(store, space, temporary_id) -> list[tuple[str, str]]:
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.fuli_personal_project_id = $project_id
        OPTIONAL MATCH (episode)-[:MENTIONS]->(entity:Entity {group_id: $group_id})
        WITH episode, collect(DISTINCT entity.uuid) AS entity_ids
        RETURN entity_ids, coalesce(episode.entity_edges, []) AS edge_ids
        ''', group_id=space['group_id'], project_id=temporary_id, routing_='r')
    assigned, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_ASSIGNMENT]->
              (assignment:FuliKnowledgeAssignment {project_id: $project_id})
        RETURN assignment.item_kind AS item_kind, assignment.item_id AS item_id
        ''', space_id=space['id'], project_id=temporary_id, routing_='r')
    found = [*(('entity', item_id) for record in records for item_id in record['entity_ids']),
             *(('relationship', item_id) for record in records for item_id in record['edge_ids']),
             *((record['item_kind'], record['item_id']) for record in assigned)]
    return list(dict.fromkeys(found))


async def _target_project(store, actor, space, project_id):
    project = await authorize_personal_project(store, actor, space, project_id)
    if project.get('scope_type') == 'temporary':
        raise HTTPException(status_code=422, detail='migrate into a registered project, not a temporary one')
    return (await scope_projects(store, space, [project_id]))[0]


async def _linked_task_count(store, space, request, reader) -> int:
    """This session's tasks in the project that the reader's own work holds:
    an FLA counts its own, a plain session those under no FLA, the person all."""
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
              (:FuliTaskContextSession {id: $session_node})-[:HAS_CONTEXT]->
              (task:FuliTaskContext {personal_project_id: $project_id})
        WHERE ''' + fla_own_work_cypher('task.project_agent_id', 'task.personal_project_id') + '''
        RETURN count(task) AS linked
        ''', space_id=space['id'], project_id=request.target_project_id, reader=reader_parameter(reader),
        routing_='r',
        session_node=store._task_session_id(space['id'], request.source_application, request.session_id))
    return int(records[0]['linked']) if records else 0
