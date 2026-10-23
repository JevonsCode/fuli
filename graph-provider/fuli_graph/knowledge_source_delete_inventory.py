"""Read the exact saved source range before planning a turn/session delete.

Never infer destructive membership from timestamps. A turn owns explicit source
turn IDs and checkpoint capture IDs; a session additionally owns episodes that
name the same client and host session. Reads are deliberately unpaginated.
"""
from .conversation_scope import conversation_scope_id
from .provider_values import json_object, sha256_text


async def source_delete_inventory(store, space, request):
    tasks, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
              (:FuliTaskContextSession {id: $session_node})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE $whole_session OR ($exact_turn AND task.turn_id = $turn_id)
        RETURN task.id AS id, task.token AS token, task.turn_id AS turn_id,
               task.personal_project_id AS project_id, task.project_agent_id AS agent_id,
               task.record_json AS record_json
        ORDER BY task.id
        ''', space_id=space['id'],
        session_node=store._task_session_id(space['id'], request.source_application, request.session_id)
            if request.source_application and request.session_id else None,
        turn_id=request.turn_id, whole_session=request.whole_session,
        exact_turn=request.exact_turn, routing_='r')
    captured = {
        result['episode_id'] for task in tasks
        for result in (json_object(task['record_json']).get('checkpoint') or {}).get('capture_results', [])
        if result.get('status') in ('committed', 'duplicate') and result.get('episode_id')
    } if request.whole_session or request.exact_turn else set()
    if not request.whole_session:
        captured.add(request.item_id)
    episodes, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids
           OR (episode.fuli_session_id = $session_id AND episode.fuli_source_application = $source_application
               AND ($whole_session OR ($exact_turn AND episode.fuli_source_turn_id = $turn_id)))
        RETURN episode ORDER BY episode.uuid
        ''', group_id=space['group_id'], episode_ids=sorted(captured), session_id=request.session_id,
        source_application=request.source_application,
        turn_id=request.turn_id, whole_session=request.whole_session,
        exact_turn=request.exact_turn, routing_='r')
    scopes = {conversation_scope_id(space['id'], task['project_id'], task['agent_id'])
              for task in tasks if task['agent_id']}
    events, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (conversation:FuliConversation)-[:HAS_EVENT]->(event:FuliConversationEvent)
        WHERE conversation.scope IN $scopes
          AND (event.task_context_token IN $tokens OR ($whole_session
               AND event.source_application = $source_application AND event.session_id = $session_id))
        RETURN event.id AS id, event.digest AS digest, conversation.id AS conversation_id,
               conversation.revision AS conversation_revision
        ORDER BY event.id
        ''', scopes=sorted(scopes), tokens=[task['token'] for task in tasks],
        whole_session=request.whole_session, source_application=request.source_application,
        session_id=request.session_id, routing_='r')
    # Keep the source tasks' words out of the plan/digest/local ledger.
    return {
        'task_ids': [task['id'] for task in tasks],
        'task_tokens': [task['token'] for task in tasks],
        'task_versions': [[task['id'], sha256_text(task['record_json'] or '')] for task in tasks],
        'episodes': [dict(row['episode']) for row in episodes],
        'event_ids': [row['id'] for row in events],
        'event_versions': [[row['id'], row['digest']] for row in events],
        'conversation_versions': sorted({(row['conversation_id'], row['conversation_revision']) for row in events}),
        'conversation_ids': sorted({row['conversation_id'] for row in events}),
    }
