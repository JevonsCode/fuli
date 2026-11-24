"""This computer stops keeping another computer's copies (docs/runner-roles-design.md
§11 3b/3c, H: a follower that owns projects of its own leaves its host).

Every record the given owner's copies left here, in one write transaction with
the import's own exemption from the replica guard and its lock
(replica_import_transaction), so a release and an import never interleave: a
copied node one of this computer's own relationships reaches (an FLA its project
is staffed with, a habit its project builds on) loses the copy marker and stays,
this computer's own from now on, with the copied relationships between records
that stay; everything else of that owner's copies goes, as the import releases
what an owner no longer has. Nothing of this computer's own is touched.

Not undoable, and so not an Agent's: the route is for this computer's own
process, which keeps a copy of the whole graph first (Node, `fuli runner leave`).
"""
from typing import Annotated

from fastapi import HTTPException, Query

from .provider_values import stable_uuid
from .scope_export import read_space
from .scope_import import BATCH, OWNER, OWNER_PATTERN, held_here

_MARKER = 'item.fuli_replica_owner, item.fuli_replica_scopes, item.fuli_replica_synced_at, ' \
          'item.fuli_replica_owner_deleted_at'


async def release_copies(store, actor, personal_space_id: str, owner: str) -> dict:
    store._require_personal()
    space = await store.authorize(actor, personal_space_id, 'maintainer')
    session_id = stable_uuid('fuli-replica-task-session', space['id'], owner)
    async with store.runtime.driver.replica_import_transaction() as transaction:
        read = await read_space(transaction, space)
        classification = read.classification
        nodes = {element for element, node in classification.nodes.items() if node.properties.get(OWNER) == owner}
        links = [item for item in classification.relationships if item.properties.get(OWNER) == owner]
        if not nodes and not links:
            raise HTTPException(409, {
                'code': 'replica_not_held',
                'message': f'This computer keeps no copy of computer {owner[:16]}; nothing to release. '
                           '这台电脑没有那台电脑的副本，没有可释放的。'})
        kept = await held_here(transaction, nodes)
        gone = nodes - kept
        kept_links = [item.element_id for item in links if item.start not in gone and item.end not in gone]
        await _each(transaction, f'MATCH (item) WHERE elementId(item) = element REMOVE {_MARKER}', kept)
        await _each(transaction, f'MATCH ()-[item]->() WHERE elementId(item) = element REMOVE {_MARKER}',
                    kept_links)
        await _each(transaction, 'MATCH (item) WHERE elementId(item) = element DETACH DELETE item', gone)
        await _release_task_session(transaction, session_id, owner)
    return {'owner': owner,
            'kept': {'nodes': len(kept), 'relationships': len(kept_links)},
            'deleted': {'nodes': len(gone), 'relationships': len(links) - len(kept_links)}}


async def _each(transaction, statement: str, elements) -> None:
    elements = sorted(elements)
    for start in range(0, len(elements), BATCH):
        await transaction.run(f'UNWIND $elements AS element {statement}', elements=elements[start:start + BATCH])


async def _release_task_session(transaction, session_id: str, owner: str) -> None:
    """The session the import hung the owner's task contexts under goes with
    them; one still holding a kept context stays, this computer's own."""
    await transaction.run('''
        MATCH (session:FuliTaskContextSession {id: $id})
        WHERE NOT EXISTS { MATCH (session)-[:HAS_CONTEXT]->() } DETACH DELETE session''', id=session_id)
    await transaction.run(f'''
        MATCH (item:FuliTaskContextSession {{id: $id}}) REMOVE {_MARKER}
        WITH item AS session
        MATCH (session)-[item]-() WHERE item.fuli_replica_owner = $owner REMOVE {_MARKER}''',
        id=session_id, owner=owner)


def register_scope_release_route(application, store, Actor) -> None:
    # For this computer's own process only, after it kept a copy of the graph;
    # not undoable, so no Agent tool and no interface catalog entry reaches it.
    @application.post('/v1/scopes/release')
    async def scope_release(actor: Actor, personal_space_id: str,
                            owner: Annotated[str, Query(pattern=OWNER_PATTERN)]) -> dict:
        return await release_copies(store, actor, personal_space_id, owner)
