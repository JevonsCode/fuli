"""Provenance and erasure of local publication bodies (D-31.B7).

Remote proposals are outside this store. A scrub preserves only submission
metadata and source identities, and makes an unsubmitted draft terminal.
"""
import json

from .provider_values import json_object, stable_uuid

SOURCE_FIELDS = ('session_id', 'source_application', 'source_turn_id')
DRAFT_STATES = ('pending', 'submitted', 'kept_personal', 'ignored')


def publication_source_identity(group_id, episode):
    identity = {field: episode[field] for field in SOURCE_FIELDS if episode.get(field)}
    if episode.get('idempotency_key'):
        identity['episode_id'] = stable_uuid(group_id, 'episode', episode['idempotency_key'])
    return identity


async def drafts_for_sources(store, space, sources, *, source_range=None):
    """Read copies by exact source identity; all statuses participate in erasure.
    Legacy drafts derive their identity from payload until first scrubbed.
    A public-only capture may have no local episode, hence explicit ranges."""
    if not sources and source_range is None:
        return []
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (personal:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PUBLICATION_DRAFT]->
              (draft:FuliPublicationDraft)
        OPTIONAL MATCH (personal)-[:SUBSCRIBES_TO]->(subscription:FuliSubscription)
        WHERE subscription.provider_url = draft.provider_url
          AND subscription.project_id = draft.target_project_id
        RETURN draft, head(collect(subscription.project_name)) AS project_name ORDER BY draft.id
        ''', space_id=space['id'], routing_='r')
    found = []
    for record in records:
        draft = dict(record['draft'])
        identity = json_object(draft.get('source_identity')) or publication_source_identity(
            space['group_id'], json_object(draft.get('payload')))
        matched = sorted({source['episode_id'] for source in sources
            if (identity.get('episode_id') and identity['episode_id'] == source['episode_id']) or
               all(identity.get(field) and identity[field] == source.get(field) for field in SOURCE_FIELDS)})
        in_range = source_range is not None and all(
            identity.get(field) and identity[field] == getattr(source_range, field)
            for field in ('session_id', 'source_application')) and (
                source_range.whole_session or
                (identity.get('source_turn_id') and identity['source_turn_id'] == source_range.turn_id))
        if matched or in_range:
            found.append({'draft': draft, 'source_identity': identity, 'source_episode_ids': matched,
                          'project_name': record.get('project_name') or None})
    return sorted(found, key=lambda row: row['draft']['id'])


async def scrub_publication_drafts(scoped, space, matches, deletion_id, deleted_at):
    """Caller holds the knowledge-space lock in the source deletion transaction.
    `matches` is recomputed in that transaction and bound to the preview digest."""
    counts = dict.fromkeys(DRAFT_STATES, 0)
    for match in matches:
        draft = match['draft']
        if draft.get('payload_scrubbed_by'):
            continue
        await scoped.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft {id: $draft_id})
            SET draft.payload = null, draft.source_identity = $source_identity,
                draft.payload_scrubbed_by = $deletion_id, draft.payload_scrubbed_at = $deleted_at,
                draft.status = CASE WHEN draft.status = 'pending' THEN 'source_deleted' ELSE draft.status END
            ''', space_id=space['id'], draft_id=draft['id'],
            source_identity=json.dumps(match['source_identity'], sort_keys=True, separators=(',', ':')),
            deletion_id=deletion_id, deleted_at=deleted_at)
        if draft['status'] in counts:
            counts[draft['status']] += 1
    return counts
