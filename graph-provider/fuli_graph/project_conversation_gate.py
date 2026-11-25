"""Hold the journal's project while checking its stored conversation binding."""
from contextlib import asynccontextmanager

from fastapi import HTTPException

from .conversation_scope import conversation_binding_id, started_conversation_id
from .knowledge_versions import lock_knowledge
from .project_write_gate import gate_space_directory, project_targets
from .replica_write_guard import refuse_global_write
from .store_transactions import query_store_transaction


@asynccontextmanager
async def journal_transaction(store, actor, request):
    directory = gate_space_directory(getattr(store, 'settings', None), request.personal_space_id)
    if directory is None or getattr(request, 'fallback_recovery', False):
        async with query_store_transaction(store) as scoped:
            yield scoped
        return
    project = request.personal_project_id
    if not project:
        refuse_global_write(store, 'a global conversation')
    with project_targets(request.personal_space_id, [project] if project else []):
        async with query_store_transaction(store) as scoped:
            space = await scoped.authorize(actor, request.personal_space_id, 'maintainer')
            await lock_knowledge(scoped, space)
            scope = await scoped._conversation_scope(actor, request, write=True)
            session = getattr(request, 'session_id', None)
            binding = conversation_binding_id(scope, request.source_application, session) if session else None
            rows, _, _ = await scoped.runtime.driver.execute_query('''
                OPTIONAL MATCH (b:FuliConversationBinding {id:$binding})
                WITH [b.conversation_id,$requested,$initial] AS ids
                OPTIONAL MATCH (c:FuliConversation) WHERE c.id IN ids AND
                    (c.scope IS NULL OR c.scope<>$scope OR c.fuli_replica_owner IS NOT NULL)
                WITH count(c) AS foreign_journals
                OPTIONAL MATCH (p:FuliConversationPolicy {id:$scope}) WHERE p.fuli_replica_owner IS NOT NULL
                RETURN foreign_journals + count(p) AS blocked
                ''', binding=binding, initial=started_conversation_id(binding) if binding else None, scope=scope,
                requested=getattr(request, 'conversation_id', None))
            if rows[0]['blocked']:
                raise HTTPException(409, detail={'code': 'project_write_blocked'})
            yield scoped
