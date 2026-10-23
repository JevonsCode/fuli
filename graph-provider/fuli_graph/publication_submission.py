"""Draft-owned submission reservations; callers hold the space knowledge lock."""
import json
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException

from .provider_values import json_object, native_datetime
from .graph_field_contract import stored_fields
from .knowledge_source_fence import require_source_available

SUBMISSION_TTL_SECONDS = 120


def submission_status(draft, now):
    """Effective preview state only: time never changes the digest's stored state."""
    started = native_datetime(draft.get('submission_started_at'))
    if draft['status'] == 'submitting' and started and now - started > timedelta(seconds=SUBMISSION_TTL_SECONDS):
        return 'submission_unknown'
    return draft['status']


def submission_change(draft, decision, now):
    """Return content-free updates for one validated transition, or a conflict."""
    action, status = decision.decision, draft['status']
    if action == 'begin_submit_public' and status == 'pending':
        return {'status': 'submitting', 'submission_id': str(uuid4()),
                'submission_started_at': now, 'submission_unknown_at': None,
                'last_submission_error': None, 'submission_outcome': None}
    same_attempt = bool(decision.submission_id) and decision.submission_id == draft.get('submission_id')
    if (same_attempt and action == 'submit_public' and status in ('submitted', 'source_deleted')
            and decision.shared_proposal_id and decision.shared_proposal_id == draft.get('shared_proposal_id')):
        return {}
    if same_attempt and action == 'submit_public' and decision.shared_proposal_id and (
            status in ('submitting', 'submission_unknown') or
            status == 'source_deleted' and draft.get('submission_outcome') == 'unknown'):
        return {'status': 'source_deleted' if status == 'source_deleted' else 'submitted',
                'shared_proposal_id': decision.shared_proposal_id, 'decided_at': now, 'submission_outcome': None}
    if same_attempt and action == 'release_submit_public' and status == 'submitting':
        error = ({'code': decision.last_submission_error.code, 'at': now.isoformat()}
                 if decision.last_submission_error else None)
        return {'status': 'pending', 'last_submission_error': error}
    if same_attempt and action == 'mark_submission_unknown' and status == 'submitting':
        return {'status': 'submission_unknown', 'submission_unknown_at': now}
    if same_attempt and action == 'reconcile_submit_public':
        eligible = status == 'submission_unknown' or (
            status == 'submitting' and submission_status(draft, now) == 'submission_unknown')
        found = decision.lookup_result
        if found and (eligible or status == 'source_deleted'):
            return {'status': 'source_deleted' if status == 'source_deleted' else 'submitted',
                    'shared_proposal_id': found.id, 'decided_at': now, 'submission_outcome': None}
        started = native_datetime(draft.get('submission_started_at'))
        if eligible and found is None and started and now - started > timedelta(seconds=SUBMISSION_TTL_SECONDS):
            return {'status': 'pending'}
    raise HTTPException(status_code=409, detail={'code': 'publication_draft_not_pending',
                                                'message': 'publication draft cannot make this submission transition'})


async def expire_submission(scoped, space, draft, now):
    """Lazily persist expiry only while the caller owns the same deletion lock."""
    if submission_status(draft, now) == draft['status']:
        return draft
    await scoped.runtime.driver.execute_query(
        '''MATCH (draft:FuliPublicationDraft {id: $draft_id, personal_space_id: $space_id})
           WHERE draft.status = 'submitting' AND draft.submission_id = $submission_id
           SET draft.status = 'submission_unknown', draft.submission_unknown_at = $now ''',
        draft_id=draft['id'], space_id=space['id'], submission_id=draft.get('submission_id'), now=now)
    return {**draft, 'status': 'submission_unknown', 'submission_unknown_at': now}


async def decide_submission(scoped, space, draft_id, decision, now):
    """Read and update under the caller's transaction and deletion lock."""
    from .publication_source_copies import publication_source_identity
    rows, _, _ = await scoped.runtime.driver.execute_query(
        '''MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PUBLICATION_DRAFT]->
                 (draft:FuliPublicationDraft {id: $draft_id}) RETURN draft''',
        space_id=space['id'], draft_id=draft_id)
    if not rows:
        raise HTTPException(409, detail={'code': 'publication_draft_not_pending'})
    draft = await expire_submission(scoped, space, dict(rows[0]['draft']), now)
    updates = submission_change(draft, decision, now)
    identity = {**publication_source_identity(space['group_id'], json_object(draft.get('payload'))),
                **json_object(draft.get('source_identity'))}
    if decision.decision == 'begin_submit_public':
        await require_source_available(scoped, space, episode_id=identity.get('episode_id'),
            source_application=identity.get('source_application'), session_id=identity.get('session_id'),
            source_turn_id=identity.get('source_turn_id'))
    updates['source_identity'] = json.dumps(identity, sort_keys=True, separators=(',', ':'))
    if isinstance(updates.get('last_submission_error'), dict):
        updates['last_submission_error'] = json.dumps(updates['last_submission_error'], separators=(',', ':'))
    rows, _, _ = await scoped.runtime.driver.execute_query(
        '''MATCH (draft:FuliPublicationDraft {id: $draft_id, personal_space_id: $space_id})
           SET draft += $updates RETURN draft''', draft_id=draft_id, space_id=space['id'],
        updates=stored_fields('FuliPublicationDraft', updates))
    return dict(rows[0]['draft'])
