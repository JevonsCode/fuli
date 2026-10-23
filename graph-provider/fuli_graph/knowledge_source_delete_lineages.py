"""Collect complete version lineages and dependencies for source selection."""
from .knowledge_dependencies import dependents_of
from .knowledge_item_view import item_evidence
from .knowledge_versions import version_chain


async def source_delete_lineages(store, space, episode_ids):
    touched, _, _ = await store.runtime.driver.execute_query(
        '''
        CALL {
          MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item:Entity {group_id: $group_id})
          WHERE episode.uuid IN $episode_ids
          RETURN 'entity' AS item_kind, item.uuid AS item_id
          UNION
          MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
          WHERE any(id IN coalesce(item.episodes, []) WHERE id IN $episode_ids)
             OR EXISTS { MATCH (episode:Episodic {group_id: $group_id})
                         WHERE episode.uuid IN $episode_ids AND item.uuid IN coalesce(episode.entity_edges, []) }
          RETURN 'relationship' AS item_kind, item.uuid AS item_id
        }
        RETURN DISTINCT item_kind, item_id ORDER BY item_kind, item_id
        ''', group_id=space['group_id'], episode_ids=list(episode_ids), routing_='r')
    frontier = [(row['item_kind'], row['item_id']) for row in touched]
    aliases, lineages = {}, {}
    while frontier:
        kind, item_id = frontier.pop()
        if f'{kind}:{item_id}' in aliases:
            continue
        versions = await version_chain(store, space, kind, item_id)
        if not versions:
            # An item disappearing during preview must lead to a new preview,
            # not a plan that silently drops its scope.
            raise ValueError('knowledge changed while reading the source deletion preview')
        head = versions[0]['item_id']
        key = f'{kind}:{head}'
        version_keys = [f'{kind}:{row["item_id"]}' for row in versions]
        aliases.update({version: key for version in version_keys})
        sources = set()
        for version in versions:
            _, ids = await item_evidence(store, space, kind, version['item_id'], limit=0)
            sources.update(ids)
        dependents = await dependents_of(store, space, kind, head)
        attached = []
        if kind == 'entity':
            edges, _, _ = await store.runtime.driver.execute_query(
                '''
                MATCH (entity:Entity {group_id: $group_id})-[edge:RELATES_TO {group_id: $group_id}]-()
                WHERE entity.uuid IN $entity_ids
                RETURN DISTINCT edge.uuid AS item_id ORDER BY item_id
                ''', group_id=space['group_id'], entity_ids=[row['item_id'] for row in versions], routing_='r')
            attached = [('relationship', row['item_id']) for row in edges]
        frontier.extend([*dependents, *attached])
        lineages[key] = {
            'key': key, 'version_keys': version_keys, 'source_episode_ids': sorted(sources),
            'dependent_keys': [f'{k}:{i}' for k, i in dependents],
            'attached_keys': [f'{k}:{i}' for k, i in attached],
            'versions': versions,
        }
    # The dependency may have named an earlier version of an already-read
    # lineage. Every layer uses the same canonical head identity.
    for row in lineages.values():
        for field in ('dependent_keys', 'attached_keys'):
            row[field] = sorted({aliases[key] for key in row[field]})
    return [lineages[key] for key in sorted(lineages)]
