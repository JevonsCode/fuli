"""Check the effects of infrequent, multi-project edits within their own transaction."""
from contextlib import ExitStack, asynccontextmanager, closing
import sqlite3

from fastapi import HTTPException

from .knowledge_versions import lock_knowledge
from .project_installation import installation
from .project_write_gate import gate_space_directory, hold_writes, project_targets
from .scope_classifier import GLOBAL, PROJECT_PREFIX, RELATIONSHIP_RULES
from .scope_export import _left_out, is_copy, read_space
from .store_transactions import query_store_transaction


async def _protected_records(transaction, space, scopes):
    read = await read_space(transaction, space)
    unknown, _ = _left_out(read)
    if unknown or read.relationship_types.difference(RELATIONSHIP_RULES):
        raise HTTPException(409, detail={'code': 'project_maintenance_scope_unknown'})
    graph = read.classification
    def protected(properties, assigned):
        return is_copy(properties) or bool(properties.get('fuli_replica_scopes')) or not scopes.isdisjoint(assigned)

    nodes = {key: (node.labels, node.properties) for key, node in graph.nodes.items()
             if protected(node.properties, graph.node_scopes(key))}
    links = {edge.element_id: (edge.type, edge.start, edge.end, edge.properties) for edge in graph.relationships
             if protected(edge.properties, graph.relationship_scopes(edge))}
    return nodes, links


@asynccontextmanager
async def maintenance_transaction(store, space):
    """Used by edits whose cascades can touch records beyond the requested item."""
    with ExitStack() as held:
        settings, _ = held.enter_context(installation(getattr(store, 'settings', None), writing=True))
        directory = gate_space_directory(settings, space['id'])
        if directory is not None:
            try:
                held.enter_context(hold_writes(directory, None))
            except HTTPException as exc:
                if exc.detail != {'code': 'project_write_requires_owner_scope'}:
                    raise
            else:
                directory = None
        if directory is None or getattr(store, '_checking_maintenance', False):
            async with query_store_transaction(store) as scoped:
                yield scoped
            return
        # Keep the full gate index stable through commit. A frozen project
        # must wait. Replica imports and transfers cannot change the baseline.
        held.enter_context(hold_writes(directory, None, maintenance=True))
        with closing(sqlite3.connect((directory / 'index.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
            scopes = {PROJECT_PREFIX + row[0] for row in db.execute("SELECT project FROM gates WHERE role<>'owner'")}
        if getattr(store.settings, 'global_replica', False):
            scopes.add(GLOBAL)
        held.enter_context(project_targets(space['id'], []))
        async with store.runtime.driver.replica_guard.classifying_copies(), query_store_transaction(store) as scoped:
            scoped._checking_maintenance = True
            await lock_knowledge(scoped, space)
            if 'group_id' not in space:
                rows, _, _ = await scoped.runtime.driver.execute_query(
                    'MATCH (s:FuliSpace {id:$id}) RETURN s.group_id AS group_id', id=space['id'])
                if not rows:
                    raise HTTPException(409, detail={'code': 'project_maintenance_scope_unknown'})
                space = {**space, 'group_id': rows[0]['group_id']}
            async with scoped.runtime.driver.transaction() as transaction:
                before = await _protected_records(transaction, space, scopes)
                yield scoped
                if before != await _protected_records(transaction, space, scopes):
                    raise HTTPException(409, detail={'code': 'replica_read_only'})
