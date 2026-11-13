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
trusted.

The walk reads MAX_VERSION_DEPTH levels of predecessors; a lineage with a
predecessor still unread after that is left out.

Deleted sources. A relationship lists its episodes by id (`episodes`); one
whose list names an episode that no longer exists is left out, since that
episode's sensitivity cannot be read. FULI's own source delete
(knowledge_source_delete_copies) marks every item that outlives the deletion
of a non-normal, non-edit source with fuli_had_restricted_source = true
(graph format 20); a lineage with that marker on any version is left out.
Known limits, not checked here:
- A source deleted before graph format 20 left no marker, and none is
  backfilled.
- A deletion outside FULI's source delete leaves nothing on an entity (it
  records no list of its sources) or on a successor (the version link is
  stored only on the older item).
"""

MAX_VERSION_DEPTH = 20
EDIT_SOURCE_KINDS = ('human_knowledge_edit', 'agent_knowledge_edit')

_ITEM = {
    'entity': ('(item:Entity)', '''
        OPTIONAL MATCH (episode:Episodic {group_id: item.group_id})-[:MENTIONS]->(item)
        WITH origin, item, collect(DISTINCT episode) AS episodes, 0 AS missing'''),
    'relationship': ('()-[item:RELATES_TO]->()', '''
        OPTIONAL MATCH (episode:Episodic {group_id: item.group_id})
        WHERE episode.uuid IN coalesce(item.episodes, [])
        WITH origin, item, collect(DISTINCT episode) AS episodes
        WITH origin, item, episodes,
             size([id IN coalesce(item.episodes, []) WHERE NOT id IN [found IN episodes | found.uuid]]) AS missing'''),
}
_SOURCES = '''
        RETURN origin, item.uuid AS id, item.group_id AS group_id, missing,
               coalesce(item.fuli_had_restricted_source, false) AS had_restricted_source,
               [episode IN episodes | {kind: episode.fuli_source_kind,
                                       sensitivity: episode.fuli_sensitivity}] AS sources
'''


async def normal_only_ids(store, item_kind: str, item_ids: list[str]) -> set[str]:
    """The items among item_ids whose whole lineage has only normal sources."""
    if not item_ids:
        return set()
    pattern, episodes = _ITEM[item_kind]
    predecessors = f'''
        UNWIND $frontier AS row
        MATCH {pattern}
        WHERE item.group_id = row.group_id AND item.fuli_replaced_by_item_id = row.id
          AND coalesce(item.fuli_replaced_by_item_kind, $item_kind) = $item_kind
        WITH row.origin AS origin, item{episodes}{_SOURCES}'''
    lineages = {}
    frontier = _merge(lineages, await _read(store, f'''
        MATCH {pattern} WHERE item.uuid IN $item_ids
        WITH item.uuid AS origin, item{episodes}{_SOURCES}''', item_ids=list(dict.fromkeys(item_ids))))
    for _ in range(MAX_VERSION_DEPTH):
        if not frontier:
            break
        frontier = _merge(lineages, await _read(store, predecessors, frontier=frontier, item_kind=item_kind))
    if frontier:
        # Read, not merged: only whether anything is left past the last level.
        for row in await _read(store, predecessors, frontier=frontier, item_kind=item_kind):
            lineages[row['origin']]['withheld'] = True
    return {origin for origin, lineage in lineages.items() if lineage['sources'] and not lineage['withheld']}


async def _read(store, query, **parameters) -> list[dict]:
    records, _, _ = await store.runtime.driver.execute_query(query, **parameters, routing_='r')
    return [dict(record) for record in records]


def _merge(lineages: dict, rows) -> list[dict]:
    """Adds each version's sources to its origin's lineage; answers the
    versions whose predecessors are still to read. A version already seen
    (a cycle) is not read again, and a lineage withheld at this level is not
    followed further, whichever of its versions withheld it."""
    found = []
    for row in rows:
        lineage = lineages.setdefault(row['origin'], {'seen': set(), 'sources': 0, 'withheld': False})
        if row['id'] in lineage['seen']:
            continue
        lineage['seen'].add(row['id'])
        lineage['withheld'] |= bool(row.get('missing')) or bool(row.get('had_restricted_source'))
        for source in row['sources']:
            if source.get('kind') in EDIT_SOURCE_KINDS:
                continue
            lineage['sources'] += 1
            lineage['withheld'] |= source.get('sensitivity') != 'normal'
        found.append({'origin': row['origin'], 'id': row['id'], 'group_id': row['group_id']})
    return [version for version in found if not lineages[version['origin']]['withheld']]
