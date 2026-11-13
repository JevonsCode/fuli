"""Which knowledge items a visitor's search may return (max_sensitivity='normal').

Sensitivity is stored only on episodes. An item is normal-safe when at least
one of its source episodes is normal; an episode stored without a
sensitivity counts as the capture default, normal. An edit episode
(knowledge_versions._write_edit_episodes) says nothing about how sensitive
the knowledge is, so it counts neither way: when the item has no other
episode, the versions it replaced decide, nearest first, following
fuli_replaced_by_item_id back at most MAX_VERSION_DEPTH steps. An item whose
whole chain has no episode but edits, or no episode at all, is left out.
"""

MAX_VERSION_DEPTH = 20
EDIT_SOURCE_KINDS = ('human_knowledge_edit', 'agent_knowledge_edit')

_ITEM = {
    'entity': ('(item:Entity)', '''
        OPTIONAL MATCH (episode:Episodic {group_id: item.group_id})-[:MENTIONS]->(item)'''),
    'relationship': ('()-[item:RELATES_TO]->()', '''
        OPTIONAL MATCH (episode:Episodic {group_id: item.group_id})
        WHERE episode.uuid IN coalesce(item.episodes, [])'''),
}
_SOURCES = '''
        WITH origin, item, collect(DISTINCT episode) AS episodes
        RETURN origin, item.uuid AS id, item.group_id AS group_id,
               [episode IN episodes | {kind: episode.fuli_source_kind,
                                       sensitivity: episode.fuli_sensitivity}] AS sources
'''


async def normal_safe_ids(store, item_kind: str, item_ids: list[str]) -> set[str]:
    if not item_ids:
        return set()
    pattern, episodes = _ITEM[item_kind]
    current = await _read(store, f'''
        MATCH {pattern} WHERE item.uuid IN $item_ids
        WITH item.uuid AS origin, item{episodes}{_SOURCES}''', item_ids=list(item_ids))
    safe, undecided = _decide(current)
    for _ in range(MAX_VERSION_DEPTH):
        if not undecided:
            break
        replaced = await _read(store, f'''
            UNWIND $frontier AS row
            MATCH {pattern}
            WHERE item.group_id = row.group_id AND item.fuli_replaced_by_item_id = row.id
              AND coalesce(item.fuli_replaced_by_item_kind, $item_kind) = $item_kind
            WITH row.origin AS origin, item{episodes}{_SOURCES}''',
            frontier=undecided, item_kind=item_kind)
        found, undecided = _decide(replaced)
        safe |= found
    return safe


async def _read(store, query, **parameters) -> list[dict]:
    records, _, _ = await store.runtime.driver.execute_query(query, **parameters, routing_='r')
    return [dict(record) for record in records]


def _decide(rows) -> tuple[set[str], list[dict]]:
    """Per origin item, from one step of its chain: normal-safe, left out, or
    (no episode but edits at this step) the versions to look behind next."""
    by_origin = {}
    for row in rows:
        by_origin.setdefault(row['origin'], []).append(row)
    safe, undecided = set(), []
    for origin, versions in by_origin.items():
        sources = [source for version in versions for source in version['sources']
                   if source.get('kind') not in EDIT_SOURCE_KINDS]
        if sources:
            if any((source.get('sensitivity') or 'normal') == 'normal' for source in sources):
                safe.add(origin)
            continue
        undecided += [{'origin': origin, 'id': version['id'], 'group_id': version['group_id']}
                      for version in versions]
    return safe, undecided
