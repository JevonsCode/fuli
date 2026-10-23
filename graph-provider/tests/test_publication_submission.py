"""Submission reservation and source deletion share one draft state machine."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.publication_submission import submission_change, submission_status, SUBMISSION_TTL_SECONDS
from fuli_graph.publication_submission_models import PublicationSubmissionDecision


NOW = datetime(2026, 10, 23, tzinfo=timezone.utc)


def request(decision, **values):
    return SimpleNamespace(decision=decision, submission_id=None, shared_proposal_id=None,
                           last_submission_error=None, **values)


def test_begin_reserves_pending_and_refuses_duplicate_or_deleted():
    result = submission_change({'status': 'pending'}, request('begin_submit_public'), NOW)
    assert result['status'] == 'submitting' and result['submission_started_at'] == NOW
    assert result['submission_id']
    for status in ('submitting', 'source_deleted', 'submitted', 'submission_unknown'):
        with pytest.raises(HTTPException) as error:
            submission_change({'status': status}, request('begin_submit_public'), NOW)
        assert error.value.status_code == 409


def test_finish_requires_matching_attempt_and_accepts_unknown_or_deleted_unknown():
    decision = SimpleNamespace(decision='submit_public', submission_id='attempt', shared_proposal_id='proposal')
    for status in ('submitting', 'submission_unknown', 'source_deleted'):
        draft = {'status': status, 'submission_id': 'attempt', 'submission_outcome': 'unknown'}
        result = submission_change(draft, decision, NOW)
        assert result['status'] == ('source_deleted' if status == 'source_deleted' else 'submitted')
        assert result['shared_proposal_id'] == 'proposal'
        draft['submission_id'] = 'other'
        with pytest.raises(HTTPException):
            submission_change(draft, decision, NOW)


def test_release_preserves_body_and_records_content_free_error():
    decision = SimpleNamespace(decision='release_submit_public', submission_id='attempt',
                               last_submission_error=SimpleNamespace(code='remote_403'))
    result = submission_change({'status': 'submitting', 'submission_id': 'attempt'}, decision, NOW)
    assert result['status'] == 'pending'
    assert result['last_submission_error'] == {'code': 'remote_403', 'at': NOW.isoformat()}
    assert 'payload' not in result


def test_expired_reservation_is_unknown_for_display_without_changing_storage():
    draft = {'status': 'submitting', 'submission_started_at': NOW}
    assert SUBMISSION_TTL_SECONDS == 120
    assert submission_status(draft, NOW + timedelta(seconds=119)) == 'submitting'
    assert submission_status(draft, NOW + timedelta(seconds=121)) == 'submission_unknown'
    assert draft['status'] == 'submitting'


def test_mark_unknown_matches_attempt_and_does_not_touch_payload():
    decision = PublicationSubmissionDecision(decision='mark_submission_unknown', submission_id='attempt')
    result = submission_change({'status': 'submitting', 'submission_id': 'attempt'}, decision, NOW)
    assert result == {'status': 'submission_unknown', 'submission_unknown_at': NOW,
                      'submission_unknown_reason': 'remote_error'}
    for status, attempt in [('pending', 'attempt'), ('submitted', 'attempt'), ('submitting', 'other')]:
        with pytest.raises(HTTPException):
            submission_change({'status': status, 'submission_id': attempt}, decision, NOW)


def test_reconciliation_uses_provider_time_and_never_restores_deleted_payload():
    draft = {'status': 'submission_unknown', 'submission_id': 'attempt', 'submission_started_at': NOW}
    missing = PublicationSubmissionDecision(decision='reconcile_submit_public', submission_id='attempt', lookup_result=None)
    with pytest.raises(HTTPException):
        submission_change(draft, missing, NOW + timedelta(seconds=119))
    assert submission_change(draft, missing, NOW + timedelta(seconds=121)) == {'status': 'pending'}
    found = PublicationSubmissionDecision(decision='reconcile_submit_public', submission_id='attempt',
                                         lookup_result={'id': 'proposal', 'status': 'pending'})
    assert submission_change(draft, found, NOW)['status'] == 'submitted'
    draft['status'] = 'submitting'
    with pytest.raises(HTTPException):
        submission_change(draft, found, NOW)
    assert submission_change(draft, found, NOW + timedelta(seconds=121))['status'] == 'submitted'
    draft.update(status='source_deleted', payload=None)
    reconciled = submission_change(draft, found, NOW)
    assert reconciled['status'] == 'source_deleted' and 'payload' not in reconciled
    with pytest.raises(HTTPException):
        submission_change(draft, missing, NOW + timedelta(seconds=121))


def test_no_delivery_assertion_releases_only_ttl_unknown_same_attempt():
    release = PublicationSubmissionDecision(decision='release_submit_public', submission_id='attempt',
                                           delivery_not_started=True)
    draft = {'status': 'submission_unknown', 'submission_id': 'attempt', 'submission_unknown_reason': 'ttl'}
    assert submission_change(draft, release, NOW)['status'] == 'pending'
    for changes in ({'submission_unknown_reason': 'remote_error'}, {'submission_unknown_reason': None},
                    {'submission_id': 'other'}, {'status': 'source_deleted'}, {'status': 'submitted'},
                    {'shared_proposal_id': 'proposal'}, {'status': 'submitting', 'shared_proposal_id': 'proposal'}):
        with pytest.raises(HTTPException):
            submission_change({**draft, **changes}, release, NOW)
    ordinary_release = PublicationSubmissionDecision(decision='release_submit_public', submission_id='attempt')
    with pytest.raises(HTTPException):
        submission_change(draft, ordinary_release, NOW)


def test_late_remote_error_upgrades_ttl_uncertainty_and_cannot_be_released():
    draft = {'status': 'submission_unknown', 'submission_id': 'attempt', 'submission_unknown_reason': 'ttl'}
    mark = PublicationSubmissionDecision(decision='mark_submission_unknown', submission_id='attempt')
    updates = submission_change(draft, mark, NOW)
    assert updates['submission_unknown_reason'] == 'remote_error'
    release = PublicationSubmissionDecision(decision='release_submit_public', submission_id='attempt', delivery_not_started=True)
    with pytest.raises(HTTPException):
        submission_change({**draft, **updates}, release, NOW)
    with pytest.raises(HTTPException):
        submission_change({**draft, 'submission_id': 'other'}, mark, NOW)


@pytest.mark.parametrize('value', ['true', 1, None])
def test_delivery_assertion_requires_a_boolean(value):
    with pytest.raises(ValueError):
        PublicationSubmissionDecision(decision='release_submit_public', submission_id='attempt', delivery_not_started=value)


def test_delivery_assertion_is_internal_and_only_valid_for_release():
    from fuli_graph.models import PublicationDraftDecision
    with pytest.raises(ValueError):
        PublicationSubmissionDecision(decision='mark_submission_unknown', submission_id='attempt', delivery_not_started=False)
    with pytest.raises(ValueError):
        PublicationDraftDecision(decision='release_submit_public', submission_id='attempt', delivery_not_started=True)
