"""Local provenance of public submissions, for both delete-preview layers.

No remote request is made. Submitted does not mean a remote maintainer approved
it. The existing publication flow has no withdrawal route; never invent one.
"""
from .knowledge_hard_delete_models import KnowledgeHardDeletePublication
from .provider_values import json_object, stable_uuid


async def publications_for_sources(store, space, items, episode_ids=()):
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
    if not sources:
        return []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (personal:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PUBLICATION_DRAFT]->
              (draft:FuliPublicationDraft {status: 'submitted'})
        OPTIONAL MATCH (personal)-[:SUBSCRIBES_TO]->(subscription:FuliSubscription)
        WHERE subscription.provider_url = draft.provider_url
          AND subscription.project_id = draft.target_project_id
        RETURN draft, head(collect(subscription.project_name)) AS project_name ORDER BY draft.id
        ''', space_id=space['id'], routing_='r')
    found = []
    for record in records:
        draft = dict(record['draft'])
        if draft.get('status') != 'submitted' or not draft.get('shared_proposal_id'):
            continue
        episode = json_object(draft.get('payload'))
        key = episode.get('idempotency_key')
        exact_id = stable_uuid(space['group_id'], 'episode', key) if key else None
        matched = []
        for source in sources:
            same_turn = all(episode.get(field) and episode[field] == source.get(field)
                            for field in ('session_id', 'source_application', 'source_turn_id'))
            if source['episode_id'] == exact_id or same_turn:
                matched.append(source['episode_id'])
        if matched:
            found.append(KnowledgeHardDeletePublication(
                draft_id=draft['id'], project_id=draft['target_project_id'],
                project_name=record.get('project_name') or None, provider_url=draft['provider_url'],
                proposal_id=draft['shared_proposal_id'], source_episode_ids=sorted(set(matched))))
    return sorted(found, key=lambda row: row.draft_id)
