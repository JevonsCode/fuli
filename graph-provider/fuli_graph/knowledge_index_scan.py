"""The items a derived index covers (rec#88, rec#92): those default search
could return, read one chunk at a time with their own text and the derived
values stored beside it, and the write lock that pins an item's text while a
derived value is written.

Only current items of the space count, resting on no unresolved basis,
confirmed by a person or an Agent, and reachable through a scope (a
preference, an assignment, a source episode or a project reference). Derived
values (a meaning vector, retrieval terms) are an index: storing one writes no
history and changes no version, lock_version or timestamp.
"""
from .search_projection import is_default_retrievable

# Items read per query while looking through them.
SCAN_CHUNK = 500
ITEM_KINDS = ('entity', 'relationship')

_ELIGIBLE = {
    'entity': '''
        MATCH (item:Entity {group_id: $group_id})
        WHERE item.uuid > $after AND item.fuli_invalid_at IS NULL''',
    'relationship': '''
        MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
        WHERE item.uuid > $after AND item.invalid_at IS NULL''',
}
_REACHABLE = {
    'entity': 'EXISTS { MATCH (:Episodic {group_id: $group_id})-[:MENTIONS]->(item) }',
    'relationship': 'size(coalesce(item.episodes, [])) > 0',
}
_SOURCE_EPISODES = {
    'entity': 'OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)',
    'relationship': '''OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN coalesce(item.episodes, [])''',
}
_TEXT = {
    'entity': 'item.name AS name, item.summary AS summary',
    'relationship': 'item.name AS name, item.fact AS fact',
}
_DERIVED = '''item.fuli_retrieval_terms AS retrieval_terms, item.fuli_retrieval_context AS retrieval_context,
               item.fuli_retrieval_hash AS retrieval_hash,
               item.fuli_semantic_model AS semantic_model, item.fuli_semantic_hash AS semantic_hash'''


def scan_query(item_kind: str) -> str:
    return _ELIGIBLE[item_kind] + '''
          AND size(coalesce(item.fuli_unresolved_bases, [])) = 0
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id, item_kind: $item_kind, item_id: item.uuid
        })
        WITH item, assignment
        WHERE item.fuli_profile_aspect IS NOT NULL OR assignment IS NOT NULL
           OR ''' + _REACHABLE[item_kind] + '''
           OR EXISTS { MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
                             (:FuliKnowledgeProjectReference {item_kind: $item_kind, item_id: item.uuid,
                                                              status: 'active'}) }
        ''' + _SOURCE_EPISODES[item_kind] + '''
        WITH item, assignment, min(episode.fuli_personal_project_id) AS episode_project_id
        RETURN item.uuid AS id, ''' + _TEXT[item_kind] + ''',
               coalesce(item.fuli_confirmation_status, 'pending') AS confirmation_status,
               item.fuli_confirmation_basis_json AS confirmation_basis_json,
               coalesce(assignment.project_id, item.fuli_preference_project_id, episode_project_id)
                 AS personal_project_id,
               ''' + _DERIVED + '''
        ORDER BY item.uuid
        LIMIT $chunk
        '''


async def indexable_items(store, space, item_kind: str, after: str = ''):
    """The indexable items of one kind after `after`, in id order."""
    while True:
        records, _, _ = await store.runtime.driver.execute_query(
            scan_query(item_kind), group_id=space['group_id'], space_id=space['id'], item_kind=item_kind,
            after=after, chunk=SCAN_CHUNK, routing_='r')
        for record in records:
            if is_default_retrievable(record):
                yield record
        if len(records) < SCAN_CHUNK:
            return
        after = records[-1]['id']


async def indexable_from(store, space, after: str | None):
    """Every indexable item of every kind from a page cursor on, as (kind, record)."""
    start, item_id = page_cursor(after)
    for kind_index in range(start, len(ITEM_KINDS)):
        item_kind = ITEM_KINDS[kind_index]
        async for record in indexable_items(store, space, item_kind, item_id if kind_index == start else ''):
            yield item_kind, record


def page_cursor(after: str | None) -> tuple[int, str]:
    if not after:
        return 0, ''
    kind, _, item_id = after.partition(':')
    return (ITEM_KINDS.index(kind), item_id) if kind in ITEM_KINDS else (len(ITEM_KINDS), '')


# The item's write lock, held to the commit, then its text: an edit waits, so
# the text checked is the text a derived value is stored beside. The lock
# property is removed in the same statement and the item is left as it was.
_LOCKED_TEXT = {
    'entity': '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        SET item._index_lock = true REMOVE item._index_lock
        RETURN item.name AS name, item.summary AS summary,
               item.fuli_retrieval_terms AS retrieval_terms, item.fuli_retrieval_context AS retrieval_context''',
    'relationship': '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        SET item._index_lock = true REMOVE item._index_lock
        RETURN item.fact AS fact,
               item.fuli_retrieval_terms AS retrieval_terms, item.fuli_retrieval_context AS retrieval_context''',
}


async def locked_item(scoped, space, item_kind: str, item_id: str) -> dict | None:
    """Inside a store transaction: lock the item and read its text, or None when it is gone."""
    records, _, _ = await scoped.runtime.driver.execute_query(
        _LOCKED_TEXT[item_kind], item_id=item_id, group_id=space['group_id'])
    return records[0] if records else None
