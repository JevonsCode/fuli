"""Local provenance of public submissions, for both delete-preview layers.

No remote request is made. Submitted does not mean a remote maintainer approved
it. The existing publication flow has no withdrawal route; never invent one.
"""
from .knowledge_hard_delete_models import KnowledgeHardDeletePublication
from .publication_source_copies import drafts_for_sources


async def publications_for_sources(store, space, items, episode_ids=(), *, source_range=None):
    """Resolve sources from item IDs and explicit deleted turns, then match the
    stored publication payload by identity. Text similarity is not provenance."""
    sources, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN $episode_ids
           OR EXISTS { MATCH (episode)-[:MENTIONS]->(item:Entity {group_id: $group_id})
                       WHERE item.uuid IN $entity_ids }
           OR EXISTS { MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
                       WHERE item.uuid IN $relationship_ids AND
                         (episode.uuid IN coalesce(item.episodes, [])
                          OR item.uuid IN coalesce(episode.entity_edges, [])) }
        RETURN episode.uuid AS episode_id, episode.fuli_session_id AS session_id,
               episode.fuli_source_application AS source_application, episode.fuli_source_turn_id AS source_turn_id
        ''', group_id=space['group_id'], episode_ids=list(episode_ids),
        entity_ids=[item.item_id for item in items if item.item_kind == 'entity'],
        relationship_ids=[item.item_id for item in items if item.item_kind == 'relationship'], routing_='r')
    # A submitted copy keeps its identity after the episode itself is gone.
    # Explicit source IDs therefore remain matchable without a live source node.
    known = {row['episode_id'] for row in sources}
    sources = [*sources, *({'episode_id': episode_id} for episode_id in episode_ids if episode_id not in known)]
    records = await drafts_for_sources(store, space, sources, source_range=source_range)
    found = []
    for record in records:
        draft = dict(record['draft'])
        if draft.get('status') != 'submitted' or not draft.get('shared_proposal_id'):
            continue
        found.append(KnowledgeHardDeletePublication(
            draft_id=draft['id'], project_id=draft['target_project_id'],
            project_name=record['project_name'], provider_url=draft['provider_url'],
            proposal_id=draft['shared_proposal_id'], source_episode_ids=record['source_episode_ids']))
    return sorted(found, key=lambda row: row.draft_id)
