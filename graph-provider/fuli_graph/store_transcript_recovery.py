"""Atomic omission marker and cursor transfer after a native-session fallback."""

from fastapi import HTTPException
from .agent_conversation_models import ConversationEvent
from .provider_values import stable_uuid
from .store_transactions import query_store_transaction
from .knowledge_versions import lock_knowledge
from .knowledge_source_fence import require_source_available


async def recover_fallback_boundary(store, actor, request):
    if request.events or request.initialize_cursor or request.cursor is None:
        raise HTTPException(422, 'Fallback recovery records only an omitted native interval')
    async with query_store_transaction(store) as scoped:
        space = await scoped.authorize(actor, request.personal_space_id, 'maintainer')
        await lock_knowledge(scoped, space)
        await require_source_available(scoped, space, source_application=request.source_application,
            session_id=request.session_id, task_token=request.task_context_token)
        scope = await scoped._conversation_scope(actor, request, write=True)
        task = await scoped._conversation_task(actor, request)
        if task.get('entry_via') not in {'tool', 'hook'}:
            raise HTTPException(409, 'Omission boundary requires a current native task entry')
        policy = await scoped._conversation_policy(scope)
        if not policy.enabled:
            return {'status': 'capture_disabled'}
        stream = stable_uuid(request.personal_space_id, request.source_application, request.session_id)
        rows, _, _ = await scoped.runtime.driver.execute_query(
            '''MERGE (s:FuliTranscriptCursor {id: $id})
            ON CREATE SET s.cursor=0, s.initialized=false
            SET s.serial=coalesce(s.serial,0)+1
            RETURN s.cursor AS cursor, s.owner_scope AS owner_scope,
                   coalesce(s.initialized,false) AS initialized,
                   s.fallback_token AS fallback_token,
                   s.fallback_from AS fallback_from, s.fallback_to AS fallback_to''', id=stream)
        current = rows[0]['cursor']
        retry = (current == request.cursor and rows[0]['owner_scope'] == scope
                 and rows[0]['initialized']
                 and rows[0]['fallback_token'] == request.task_context_token
                 and rows[0]['fallback_from'] == request.expected_cursor
                 and rows[0]['fallback_to'] == request.cursor)
        if current != request.expected_cursor and not retry:
            raise HTTPException(409, 'Transcript cursor changed before fallback recovery')
        # Transfer at the existing cursor, then append only our omission marker.
        # Both writes share this transaction; failure leaves the old owner/cursor.
        await scoped.runtime.driver.execute_query(
            'MATCH (s:FuliTranscriptCursor {id: $id}) SET s.owner_scope=$scope, s.initialized=true, '
            's.fallback_token=$token, s.fallback_from=$start, s.fallback_to=$end',
            id=stream, scope=scope, token=request.task_context_token,
            start=request.expected_cursor, end=request.cursor)
        event = ConversationEvent(
            event_id=f'jsonl-v1:{request.expected_cursor}:{request.cursor}:fallback',
            role='tool', kind='tool_result',
            # These canonical bytes predate Hook omission recovery. Keep them
            # stable so an old committed request can replay after an upgrade.
            content=f'[Visible transcript content omitted: unverified task ownership after fallback; '
                    f'bytes {request.expected_cursor} to {request.cursor} remain in native history.]')
        result = await scoped.append_conversation(actor, request.model_copy(update={
            'fallback_recovery': False, 'expected_cursor': current, 'events': [event]}))
        return {**result, 'cursor': request.cursor, 'omitted': True,
                'coverage': 'fallback_boundary_only'}
