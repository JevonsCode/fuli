"""What this computer holds as its read-only copy of a scope, read only
(docs/runner-roles-design.md §12, "From the review of the copy of `global`").

The copy's records of the scope (those its import wrote and the owner still
has: an owner-deleted one is not the owner's any more), counted, the last time
an import wrote one of them, and the digest of their content as the owner
wrote it (scope_export.content_digest, without derived properties or the copy
marker). The import of the same scope answers the same digest for what it
wrote (scope_import.py `contentDigest`), so a sync can tell that the copy here
is still what it imported without importing it again.
"""
from typing import Annotated

from fastapi import Query

from .scope_classifier import SPACE_LABEL
from .scope_export import content_digest, node_id, read_space
from .scope_import import OWNER, OWNER_DELETED_AT, SCOPES, SYNCED_AT


def _copied(properties: dict, scope: str) -> bool:
    return (properties.get(OWNER) is not None and properties.get(OWNER_DELETED_AT) is None
            and scope in (properties.get(SCOPES) or ()))


async def replica_summary(store, actor, personal_space_id: str, scope: str) -> dict:
    store._require_personal()
    space = await store.authorize(actor, personal_space_id, 'maintainer')
    async with store.runtime.driver.read_transaction() as transaction:
        read = await read_space(transaction, space)
    classification = read.classification
    ids = {element: node_id(node) for element, node in classification.nodes.items()}
    ids[classification.space_element_id] = f'{SPACE_LABEL}:{space["id"]}'
    nodes = [node for node in classification.nodes.values() if _copied(node.properties, scope)]
    relationships = [item for item in classification.relationships if _copied(item.properties, scope)]
    records = [node.properties for node in nodes] + [item.properties for item in relationships]
    synced = [item[SYNCED_AT] for item in records if item.get(SYNCED_AT) is not None]
    return {
        'scope': scope,
        'copiedRecords': len(records),
        'owners': sorted({item[OWNER] for item in records}),
        'syncedAt': max(synced).iso_format() if synced else None,
        'contentDigest': content_digest(
            [(ids[node.element_id], node.labels, node.properties) for node in nodes],
            [(item.type, ids.get(item.start), ids.get(item.end), item.properties) for item in relationships]),
    }


def register_scope_replica_summary_route(application, store, Actor) -> None:
    # Read only, for this computer's own process (its sync); no Agent tool reaches it.
    @application.get('/v1/scopes/replica-summary')
    async def scope_replica_summary(
            actor: Actor, personal_space_id: str,
            scope: Annotated[str, Query(min_length=6, max_length=140, pattern=r'^(global|project:\S+)$')]) -> dict:
        return await replica_summary(store, actor, personal_space_id, scope)
