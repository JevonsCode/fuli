"""Resolve a feedback batch from the graph before allowing its first write."""
from contextlib import asynccontextmanager, ExitStack

from fastapi import HTTPException

from .project_write_gate import gate_space_directory, hold_writes, project_targets
from .scope_classifier import GLOBAL, PROJECT_PREFIX
from .scope_export import is_copy, read_space
from .store_transactions import joins_transaction, query_store_transaction

# The whole-space refusals an unresolved write gets while a project is frozen
# or a copy is kept here (project_write_gate.hold_writes).
_UNRESOLVED = ('project_scope_unknown', 'project_write_requires_owner_scope')


async def knowledge_item_projects(transaction, space, items, *, held_by_owner=False):
    """The projects a batch about these items writes. held_by_owner: the use of
    a copy writes nothing (knowledge_audit._record_one_knowledge_use), so a
    copied item adds no project."""
    classification = (await read_space(transaction, space)).classification
    projects = set()
    for item in items:
        if held_by_owner and is_copy(classification.item_properties(item.item_kind, item.item_id) or {}):
            continue
        scopes = classification.item_scopes(item.item_kind, item.item_id, referrer='feedback')
        if not scopes or any(scope != GLOBAL and not scope.startswith(PROJECT_PREFIX) for scope in scopes):
            raise HTTPException(409, detail={'code': 'project_scope_unknown'})
        projects.update(scope[len(PROJECT_PREFIX):] for scope in scopes if scope != GLOBAL)
    return projects


@asynccontextmanager
async def feedback_transaction(store, space, items, *, held_by_owner=False):
    directory = gate_space_directory(getattr(store, 'settings', None), space['id'])
    if directory is None:
        async with query_store_transaction(store) as scoped:
            yield scoped
        return
    if joins_transaction(store):
        # A checkpoint records its usage in its own open transaction, admitted
        # for the projects it resolved: the items must be within them.
        async with store.runtime.driver.transaction() as transaction:
            projects = await knowledge_item_projects(transaction, space, items, held_by_owner=held_by_owner)
        with project_targets(space['id'], projects):
            yield store
        return
    # The common case needs no graph scan. Hold the whole-space read lock so
    # a freeze cannot start between this check and the Neo4j commit.
    with ExitStack() as held:
        try:
            held.enter_context(hold_writes(directory, None))
        except HTTPException as exc:
            if not isinstance(exc.detail, dict) or exc.detail.get('code') not in _UNRESOLVED:
                raise
        else:
            async with query_store_transaction(store) as scoped:
                yield scoped
            return
    async with store.runtime.driver.read_transaction() as transaction:
        projects = await knowledge_item_projects(transaction, space, items, held_by_owner=held_by_owner)
    from .knowledge_versions import lock_knowledge
    with project_targets(space['id'], projects):
        async with query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            async with scoped.runtime.driver.transaction() as transaction:
                if projects != await knowledge_item_projects(transaction, space, items, held_by_owner=held_by_owner):
                    raise HTTPException(409, detail={'code': 'project_scope_changed'})
            yield scoped
