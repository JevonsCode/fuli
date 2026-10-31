"""rec#5 C7/C8 contracts that need no graph: why a version is history, when an
edit writes a new version, what the new version starts with, and the request
shapes of the outdated mark and of a conclusion's bases."""

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from fuli_graph.knowledge_audit_models import KnowledgeRevisionRecord
from fuli_graph.knowledge_versions import creates_version, version_status, version_value
from fuli_graph.model_validation import require_public_eligible_episode
from fuli_graph.models import EntityInput, KnowledgeRevisionCreate, RelationshipInput, StructuredEpisode

NOW = datetime(2026, 10, 21, tzinfo=timezone.utc)


def revision(action, minutes=0):
    return KnowledgeRevisionRecord(id=f'{action}-{minutes}', item_id='item', item_kind='entity', action=action,
                                   reason='Synthetic.', created_at=NOW + timedelta(minutes=minutes))


def test_the_revision_that_ended_validity_says_why_a_version_is_history():
    assert version_status(None, None, [revision('mark_outdated')]) == 'current'
    assert version_status(NOW, 'newer', [revision('supersede')]) == 'superseded'
    assert version_status(NOW, None, [revision('mark_outdated')]) == 'outdated'
    assert version_status(NOW, None, [revision('basis_outdated')]) == 'basis_outdated'
    # Re-asserting later links a newer version and keeps why it ended.
    assert version_status(NOW, 'newer', [revision('mark_outdated'), revision('reassert', 5)]) == 'outdated'
    assert version_status(NOW, None, [revision('invalidate')]) == 'inactive'
    assert version_status(NOW, 'kept', [revision('invalidate')]) == 'superseded'
    # A capture's supersede writes no revision: its replacement link says it.
    assert version_status(NOW, 'newer', []) == 'superseded'
    # The latest end counts: deactivated, restored, then marked outdated.
    assert version_status(NOW, None, [revision('invalidate'), revision('restore', 1),
                                      revision('mark_outdated', 2)]) == 'outdated'


def test_a_content_edit_or_a_reassertion_writes_a_version_unless_a_newer_one_exists():
    assert creates_version({}, 'current', content_changed=True)
    assert not creates_version({}, 'current', content_changed=False)
    assert creates_version({}, 'outdated', content_changed=False)
    assert creates_version({}, 'basis_outdated', content_changed=True)
    assert not creates_version({'replaced_by_item_id': 'newer'}, 'outdated', content_changed=True)
    assert creates_version({}, 'inactive', content_changed=True), 'D-20.5: no in-place rewrite of history'
    assert not creates_version({}, 'inactive', content_changed=False), 'a deactivation keeps its own restore'
    assert not creates_version({'replaced_by_item_id': 'newer'}, 'superseded', content_changed=True)


PREVIOUS = {
    'name': 'Use many headings', 'summary': 'Use many headings', 'originQuadrant': 'known_known',
    'confirmationStatus': 'agent_confirmed', 'usageGeneration': 3, 'qualifiedUseCount': 7,
    'distinctTaskCount': 4, 'utilityScore': 0.8, 'negativeEvidenceCount': 1,
    'requiresAttention': True,
    'lastFeedbackKind': 'rejected', 'lastFeedbackAt': '2026-10-20T08:00:00+00:00',
    'confirmationBasis': {'existence_reason': 'Agent use.', 'quadrant_reason': 'Stated in a task.',
                          'proposed_by': {'kind': 'agent'}},
    'negativeFeedbackBlock': {'audit_id': 'rejection', 'reported_by_kind': 'user'},
}


def test_a_persons_new_version_is_their_own_confirmed_statement_and_starts_unused():
    value = version_value(PREVIOUS, {**PREVIOUS, 'summary': 'Headings for long answers'},
                          explicit_confirmation=False, changed_by='user', reason='Mine now.', created_at=NOW)
    assert value['confirmationStatus'] == 'confirmed'
    assert value['confirmationBasis']['confirmed_by'] == {'kind': 'user'}
    assert value['confirmationBasis']['proposed_by'] == {'kind': 'user'}
    assert value['confirmationBasis']['confirmed_at'] == NOW.isoformat()
    assert value['confirmationBasis']['quadrant_reason'] == 'Stated in a task.'
    assert value['negativeFeedbackBlock'] is None, 'the person states it, so the block does not carry'
    assert (value['usageGeneration'], value['qualifiedUseCount'], value['utilityScore'],
            value['negativeEvidenceCount']) == (1, 0, 0.0, 1)
    assert value['requiresAttention'] is False, 'the person answered the attention flag'
    assert (value['lastFeedbackKind'], value['lastFeedbackAt']) == (
        'rejected', '2026-10-20T08:00:00+00:00')
    assert value['invalidAt'] is None and value['replacedByItemId'] is None


def test_an_agents_new_version_waits_for_a_person_and_keeps_the_block_and_attention():
    value = version_value(PREVIOUS, PREVIOUS, explicit_confirmation=False, changed_by='agent',
                          reason='Rephrased.', created_at=NOW)
    assert value['confirmationStatus'] == 'pending'
    assert value['confirmationBasis'] == {'existence_reason': 'Rephrased.', 'quadrant_reason': 'Stated in a task.',
                                          'proposed_by': {'kind': 'agent'}}
    assert value['negativeFeedbackBlock'] == PREVIOUS['negativeFeedbackBlock']
    assert value['qualifiedUseCount'] == 0
    assert value['negativeEvidenceCount'] == 1
    assert (value['lastFeedbackKind'], value['lastFeedbackAt']) == (
        'rejected', '2026-10-20T08:00:00+00:00')
    assert value['requiresAttention'] is True, 'only a person clears what negative feedback raised'


def test_a_caller_that_names_the_confirmation_keeps_it():
    named = {**PREVIOUS, 'confirmationStatus': 'confirmed', 'confirmationBasis': {'confirmed_by': {'kind': 'user'}}}
    value = version_value(PREVIOUS, named, explicit_confirmation=True, changed_by='agent', reason='Merge.',
                          created_at=NOW)
    assert value['confirmationStatus'] == 'confirmed' and value['confirmationBasis'] == named['confirmationBasis']
    assert value['requiresAttention'] is True, 'an Agent-side confirmation does not clear the flag'


def test_marking_outdated_keeps_the_content_and_names_only_a_reason():
    base = {'personal_space_id': 'space', 'item_kind': 'entity', 'action': 'mark_outdated',
            'reason': 'No longer true.'}
    assert KnowledgeRevisionCreate(**base).action == 'mark_outdated'
    for content in [{'name': 'New words'}, {'summary': 'x'}, {'fact': 'x'}, {'current_quadrant': 'known_known'}]:
        with pytest.raises(ValidationError, match='re-assert it as a new version'):
            KnowledgeRevisionCreate(**base, **content)
    with pytest.raises(ValidationError):
        KnowledgeRevisionCreate(**base, replacement_item_id='other', replacement_item_kind='entity')


def test_a_conclusion_names_at_most_eight_distinct_bases():
    entity = {'key': 'fact', 'name': 'Fact', 'type': 'ProjectFact'}
    assert EntityInput(**entity, derived_from=['a', 'b']).derived_from == ['a', 'b']
    assert EntityInput(**entity).derived_from == []
    for invalid in [['a', 'a'], [' '], [str(index) for index in range(9)], ['x' * 257]]:
        with pytest.raises(ValidationError):
            EntityInput(**entity, derived_from=invalid)
    relation = {'key': 'r', 'source': 's', 'target': 't', 'type': 'USES', 'fact': 'Uses.'}
    assert RelationshipInput(**relation, derived_from=['a']).derived_from == ['a']


def test_a_conclusion_that_names_personal_bases_cannot_enter_public_review():
    basis = {'existence_reason': 'r', 'quadrant_reason': 'q', 'proposed_by': {'kind': 'user'},
             'confirmed_by': {'kind': 'user'}, 'confirmed_at': NOW.isoformat()}
    episode = StructuredEpisode.model_validate({
        'idempotency_key': 'synthetic-public', 'session_id': 's', 'name': 'n', 'source_kind': 'k',
        'source_description': 'd', 'reference_time': NOW.isoformat(),
        'entities': [{'key': 'fact', 'name': 'Fact', 'type': 'ProjectFact', 'confirmation_status': 'confirmed',
                      'confirmation_basis': basis, 'derived_from': ['personal-item']}]})
    with pytest.raises(ValueError, match='cannot enter public review'):
        require_public_eligible_episode(episode)
