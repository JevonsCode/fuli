"""Which knowledge items a visitor's search may return (max_sensitivity='normal').

Sensitivity is stored only on episodes (`fuli_sensitivity`). An item reaches
a visitor only when every source it has, and every source of every version
it replaced or absorbed (edits, supersedes and duplicate merges all point the
older item at the newer one with fuli_replaced_by_item_id), is explicitly
normal, and there is at least one. One private or restricted source anywhere
in that lineage keeps the item out: an entity a private capture created
keeps that capture's words even after a normal one mentions it.

An edit episode (knowledge_versions._write_edit_episodes) says nothing about
how sensitive the knowledge is, so it counts neither way. An episode without
a stored sensitivity is not normal: every FULI writer has set it since the
graph's first release, so a missing value is not FULI's capture and is not
trusted. A lineage longer than MAX_VERSION_DEPTH steps is not read to its
end, so it is left out too.
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


async def normal_only_ids(store, item_kind: str, item_ids: list[str]) -> set[str]:
    """The items among item_ids whose whole lineage has only normal sources."""
    if not item_ids:
        return set()
    pattern, episodes = _ITEM[item_kind]
    lineages = {}
    frontier = _merge(lineages, await _read(store, f'''
        MATCH {pattern} WHERE item.uuid IN $item_ids
        WITH item.uuid AS origin, item{episodes}{_SOURCES}''', item_ids=list(dict.fromkeys(item_ids))))
    for _ in range(MAX_VERSION_DEPTH):
        if not frontier:
            break
        frontier = _merge(lineages, await _read(store, f'''
            UNWIND $frontier AS row
            MATCH {pattern}
            WHERE item.group_id = row.group_id AND item.fuli_replaced_by_item_id = row.id
              AND coalesce(item.fuli_replaced_by_item_kind, $item_kind) = $item_kind
            WITH row.origin AS origin, item{episodes}{_SOURCES}''', frontier=frontier, item_kind=item_kind))
    unread = {row['origin'] for row in frontier}
    return {origin for origin, lineage in lineages.items()
            if origin not in unread and lineage['sources'] and not lineage['withheld']}


async def _read(store, query, **parameters) -> list[dict]:
    records, _, _ = await store.runtime.driver.execute_query(query, **parameters, routing_='r')
    return [dict(record) for record in records]


def _merge(lineages: dict, rows) -> list[dict]:
    """Adds each version's sources to its origin's lineage; answers the
    versions whose predecessors are still to read. A version already seen
    (a cycle) and a lineage already withheld are not followed further."""
    frontier = []
    for row in rows:
        lineage = lineages.setdefault(row['origin'], {'seen': set(), 'sources': 0, 'withheld': False})
        if row['id'] in lineage['seen']:
            continue
        lineage['seen'].add(row['id'])
        for source in row['sources']:
            if source.get('kind') in EDIT_SOURCE_KINDS:
                continue
            lineage['sources'] += 1
            lineage['withheld'] |= source.get('sensitivity') != 'normal'
        if not lineage['withheld']:
            frontier.append({'origin': row['origin'], 'id': row['id'], 'group_id': row['group_id']})
    return frontier
