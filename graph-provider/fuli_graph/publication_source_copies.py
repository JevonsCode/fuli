"""Provenance and erasure of local publication bodies (D-31.B7).

Remote proposals are outside this store. A scrub preserves only submission
metadata and source identities, and makes an unsubmitted draft terminal.
"""
import json
from fastapi import HTTPException

from .provider_values import json_object, stable_uuid
from .publication_submission import expire_submission, submission_status

SOURCE_FIELDS = ('session_id', 'source_application', 'source_turn_id')
DRAFT_STATES = ('pending', 'submitted', 'kept_personal', 'ignored', 'unknown')


def publication_source_identity(group_id, episode):
    identity = {field: episode[field] for field in SOURCE_FIELDS if episode.get(field)}
    if episode.get('idempotency_key'):
        identity['idempotency_key'] = episode['idempotency_key']
        identity['episode_id'] = stable_uuid(group_id, 'episode', episode['idempotency_key'])
    return identity


async def project_agent_sources(store, space, identities) -> set[int]:
    """The positions among these draft source identities that an FLA's work
    wrote: the personal episode it names, or the session turn it came from.
    Such knowledge stays in the personal graph (0.20.1): no draft is made of
    it, and an older one is read only by the person."""
    sources = [{'index': index, 'episode_id': identity.get('episode_id'),
                'turn_id': identity.get('source_turn_id'),
                'session_node': store._task_session_id(space['id'], identity['source_application'],
                                                       identity['session_id'])
                if identity.get('source_application') and identity.get('session_id') else None}
               for index, identity in enumerate(identities)]
    if not sources:
        return set()
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        UNWIND $sources AS source
        WITH source WHERE EXISTS {
            MATCH (episode:Episodic {group_id: $group_id, uuid: source.episode_id})
            WHERE episode.fuli_project_agent_id IS NOT NULL }
          OR EXISTS {
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
                  (:FuliTaskContextSession {id: source.session_node})-[:HAS_CONTEXT]->
                  (task:FuliTaskContext {turn_id: source.turn_id})
            WHERE task.project_agent_id IS NOT NULL }
        RETURN source.index AS index
        ''', sources=sources, group_id=space['group_id'], space_id=space['id'], routing_='r')
    return {record['index'] for record in records}


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
        identity = {**publication_source_identity(space['group_id'], json_object(draft.get('payload'))),
                    **json_object(draft.get('source_identity'))}
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
    # A reservation refuses the entire transaction before any local body goes.
    if any(submission_status(match['draft'], deleted_at) == 'submitting' for match in matches):
        raise HTTPException(409, detail={'code': 'hard_delete_draft_submitting'})
    for match in matches:
        draft = await expire_submission(scoped, space, match['draft'], deleted_at)
        if draft.get('payload_scrubbed_by'):
            continue
        await scoped.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft {id: $draft_id})
            SET draft.payload = null, draft.source_identity = $source_identity,
                draft.payload_scrubbed_by = $deletion_id, draft.payload_scrubbed_at = $deleted_at,
                draft.submission_outcome = CASE WHEN draft.status = 'submission_unknown'
                    THEN 'unknown' ELSE draft.submission_outcome END,
                draft.status = CASE WHEN draft.status IN ['pending', 'submission_unknown']
                    THEN 'source_deleted' ELSE draft.status END
            ''', space_id=space['id'], draft_id=draft['id'],
            source_identity=json.dumps(match['source_identity'], sort_keys=True, separators=(',', ':')),
            deletion_id=deletion_id, deleted_at=deleted_at)
        counted = 'unknown' if draft['status'] == 'submission_unknown' else draft['status']
        if counted in counts:
            counts[counted] += 1
    return counts


def publication_draft_counts(matches, now):
    counts = dict.fromkeys(('pending', 'submitted', 'submitting', 'unknown'), 0)
    for match in matches:
        draft = match['draft']
        if draft.get('payload_scrubbed_by'):
            continue
        status = submission_status(draft, now)
        status = 'unknown' if status == 'submission_unknown' else status
        if status in counts:
            counts[status] += 1
    return counts
