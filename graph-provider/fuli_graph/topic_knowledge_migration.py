"""A promoted topic's knowledge moves with its conversations (rec#11 D-86).

What a conversation of the topic saved while nobody chose where it applies
waits in its host session's temporary project (rec#20). When the topic forms
into a project, by the person's auto setting or their acceptance, every item
those sessions still hold there alone moves into it through the session
migration's Agent/system path, recorded as the Assistant.

The undo reads those scope_change revisions as the record of what moved: an
item returns to the session project its revision names, as it was there
(scope undetermined or set), only while that revision is still the item's
newest and its scope is still the one the move left. Anything a person or
Agent changed since stays where it is. Both run inside the caller's
transaction under the space's knowledge lock.
"""
import json

from fastapi import HTTPException

from .knowledge_item_version import edit_revision
from .knowledge_item_view import item_scope, scope_snapshot
from .knowledge_management import _read_item
from .knowledge_project_scope import refused_for_match
from .knowledge_scope_edit import place_scope_as
from .knowledge_session_migration import move_session_knowledge
from .system_agents import SYSTEM_ASSISTANT_AGENT_ID
from .temporary_project_scope import session_temporary_project_id


async def move_topic_knowledge(scoped, actor, space, topic, project_id, conversation_ids) -> dict:
    reason = f'Astro 将话题「{topic}」升级为项目：搬入这些会话暂存的知识'
    moved, kept = 0, 0
    for temporary_id in await _session_projects(scoped, space, conversation_ids):
        result = await move_session_knowledge(scoped, actor, space, temporary_id, project_id,
                                              author_id=SYSTEM_ASSISTANT_AGENT_ID, reason=reason)
        moved += len(result['moved'])
        kept += len(result['kept'])
    return {'moved': moved, 'kept': kept}


async def return_topic_knowledge(scoped, actor, space, topic, project_id, conversation_ids) -> dict:
    temporary_ids = set(await _session_projects(scoped, space, conversation_ids))
    reason = f'撤销话题「{topic}」的升级：知识回到原会话暂存'
    returned, kept = 0, 0
    for revision in await _latest_assistant_moves(scoped, space):
        previous = json.loads(revision['previous_json'])['scope']
        moved_to = json.loads(revision['current_json'])['scope']
        held_in = [project['id'] for project in previous.get('projects') or []]
        if previous.get('kind') != 'temporary' or len(held_in) != 1 or held_in[0] not in temporary_ids \
                or [project['id'] for project in moved_to.get('projects') or []] != [project_id]:
            continue
        item_kind, item_id = revision['item_kind'], revision['item_id']
        current = await _read_item(scoped, space, item_id, item_kind)
        if current is None or current.get('invalid_at') or scope_snapshot(
                await item_scope(scoped, space, item_kind, item_id, current)) != moved_to:
            kept += 1
            continue
        try:
            await place_scope_as(scoped, actor, space, SYSTEM_ASSISTANT_AGENT_ID, item_kind, item_id,
                                 expected_version=await edit_revision(scoped, space, item_kind, item_id),
                                 project_ids=held_in, reason=reason,
                                 scope_status='undetermined' if previous.get('status') == 'undetermined' else None)
        except HTTPException as error:
            if not refused_for_match(error):
                raise
            kept += 1
            continue
        returned += 1
    return {'returned': returned, 'kept': kept}


async def _session_projects(scoped, space, conversation_ids) -> list[str]:
    """The temporary project of every host session that wrote to these
    conversations: named by their journal events, or by the episodes their
    knowledge was saved from when no transcript was captured."""
    if not conversation_ids:
        return []
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (conversation:FuliConversation)-[:HAS_EVENT]->(event:FuliConversationEvent)
        WHERE conversation.id IN $conversation_ids AND event.session_id IS NOT NULL
        RETURN DISTINCT event.source_application AS source_application, event.session_id AS session_id
        UNION
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.fuli_conversation_id IN $conversation_ids AND episode.fuli_session_id IS NOT NULL
        RETURN DISTINCT episode.fuli_source_application AS source_application, episode.fuli_session_id AS session_id
        ''', conversation_ids=list(conversation_ids), group_id=space['group_id'])
    sessions = sorted({(record['source_application'] or 'other', record['session_id']) for record in records})
    return list(dict.fromkeys(session_temporary_project_id(space['id'], client, session)
                              for client, session in sessions))


async def _latest_assistant_moves(scoped, space) -> list[dict]:
    """The Assistant's scope changes that are still their item's newest revision."""
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_KNOWLEDGE_REVISION]->
              (revision:FuliKnowledgeRevision {action: 'scope_change', created_by: $author})
        WHERE NOT EXISTS {
          MATCH (space)-[:HAS_KNOWLEDGE_REVISION]->(later:FuliKnowledgeRevision
                {item_id: revision.item_id, item_kind: revision.item_kind})
          WHERE later.created_at > revision.created_at
        }
        RETURN revision.item_kind AS item_kind, revision.item_id AS item_id,
               revision.previous_json AS previous_json, revision.current_json AS current_json
        ORDER BY revision.created_at, revision.item_id
        ''', space_id=space['id'], author=SYSTEM_ASSISTANT_AGENT_ID)
    return [dict(record) for record in records]
