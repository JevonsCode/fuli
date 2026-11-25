"""Resolve a feedback batch from the graph before allowing its first write."""
from contextlib import asynccontextmanager, ExitStack

from fastapi import HTTPException

from .project_write_gate import gate_space_directory, hold_writes, project_targets
from .scope_classifier import GLOBAL, PROJECT_PREFIX
from .scope_export import read_space
from .store_transactions import query_store_transaction


async def knowledge_item_projects(transaction, space, items):
    classification = (await read_space(transaction, space)).classification
    projects = set()
    for item in items:
        scopes = classification.item_scopes(item.item_kind, item.item_id, referrer='feedback')
        if not scopes or any(scope != GLOBAL and not scope.startswith(PROJECT_PREFIX) for scope in scopes):
            raise HTTPException(409, detail={'code': 'project_scope_unknown'})
        projects.update(scope[len(PROJECT_PREFIX):] for scope in scopes if scope != GLOBAL)
    return projects


@asynccontextmanager
async def feedback_transaction(store, space, items):
    directory = gate_space_directory(getattr(store, 'settings', None), space['id'])
    if directory is None:
        async with query_store_transaction(store) as scoped:
            yield scoped
        return
    # The common case needs no graph scan. Hold the whole-space read lock so
    # a freeze cannot start between this check and the Neo4j commit.
    with ExitStack() as held:
        try:
            held.enter_context(hold_writes(directory, None))
        except HTTPException as exc:
            if exc.detail != {'code': 'project_scope_unknown'}:
                raise
        else:
            async with query_store_transaction(store) as scoped:
                yield scoped
            return
    async with store.runtime.driver.read_transaction() as transaction:
        projects = await knowledge_item_projects(transaction, space, items)
    from .knowledge_versions import lock_knowledge
    with project_targets(space['id'], projects):
        async with query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            async with scoped.runtime.driver.transaction() as transaction:
                if projects != await knowledge_item_projects(transaction, space, items):
                    raise HTTPException(409, detail={'code': 'project_scope_changed'})
            yield scoped
