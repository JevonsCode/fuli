"""rec#5 C7/C8 contracts that need no graph: why a version is history, when an
edit writes a new version, what the new version starts with, and the request
shapes of the outdated mark and of a conclusion's bases."""

import json
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from fuli_graph.knowledge_audit_models import KnowledgeRevisionRecord
from fuli_graph.knowledge_records import revision_record
from fuli_graph.provider_values import stable_uuid
from fuli_graph.knowledge_versions import (
    creates_version,
    keyed_relation,
    keyed_replacement,
    restated_relationships,
    terminal,
    version_status,
    version_value,
)
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
            value['negativeEvidenceCount']) == (1, 0, 0.0, 0)
    assert value['requiresAttention'] is False, 'the person answered the attention flag'
    assert (value['lastFeedbackKind'], value['lastFeedbackAt']) == (None, None)
    assert value['invalidAt'] is None and value['replacedByItemId'] is None


def test_an_agents_new_version_waits_for_a_person_and_keeps_the_block_and_attention():
    value = version_value(PREVIOUS, PREVIOUS, explicit_confirmation=False, changed_by='agent',
                          reason='Rephrased.', created_at=NOW)
    assert value['confirmationStatus'] == 'pending'
    assert value['confirmationBasis'] == {'existence_reason': 'Rephrased.', 'quadrant_reason': 'Stated in a task.',
                                          'proposed_by': {'kind': 'agent'}}
    assert value['negativeFeedbackBlock'] == PREVIOUS['negativeFeedbackBlock']
    assert value['qualifiedUseCount'] == 0
    assert value['negativeEvidenceCount'] == 0, 'feedback judged the old content'
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


def stored_revision(action, current_json, minutes=0):
    """A revision as it comes back from storage: a record dict, not the model."""
    return revision_record({
        'id': f'{action}-{minutes}',
        'item_id': 'item',
        'item_kind': 'relationship',
        'action': action,
        'reason': 'Synthetic.',
        'previous_json': json.dumps({}),
        'current_json': json.dumps(current_json),
        'created_at': NOW + timedelta(minutes=minutes),
    })


@pytest.mark.parametrize('relation', ['HAS_URL', 'BASE_URL', 'RUNS_ON_PORT', 'LISTENS_ON_PORT',
                                      'START_COMMAND', 'BUILD_COMMAND', 'OWNED_BY', 'HAS_OWNER',
                                      'API_ENDPOINT', 'DB_HOST', 'DOCS_URI'])
def test_a_relation_type_that_names_one_value_per_subject_is_keyed(relation):
    assert keyed_relation(relation, {}) is True


@pytest.mark.parametrize('relation', ['USES', 'DEPENDS_ON', 'IMPLEMENTED_IN', 'OWNS',
                                      'HOSTED_ON', 'PORTED_FROM', 'COMMANDS_LIST'])
def test_a_relation_type_that_names_many_values_is_not_keyed(relation):
    assert keyed_relation(relation, {}) is False


def test_a_capture_saying_single_valued_decides_keyed_and_a_non_boolean_is_ignored():
    assert keyed_relation('USES', {'singleValued': True}) is True
    assert keyed_relation('HAS_URL', {'singleValued': False}) is False
    # A non-boolean value is ignored: the relation type's words decide.
    assert keyed_relation('USES', {'singleValued': 'yes'}) is False
    assert keyed_relation('HAS_URL', {'singleValued': 'no'}) is True


def test_a_keyed_supersede_whose_link_still_points_at_its_replacement_is_keyed():
    current = {'replaced_by_item_id': 'new-version'}
    revisions = [stored_revision('supersede', {
        'keyedReplacement': {'relation': 'RUNS_ON_PORT'},
        'replacedByItemId': 'new-version',
    })]
    assert keyed_replacement(current, revisions) is True


def test_a_plain_supersede_is_not_keyed():
    current = {'replaced_by_item_id': 'new-version'}
    revisions = [stored_revision('supersede', {'replacedByItemId': 'new-version'})]
    assert keyed_replacement(current, revisions) is False


def test_a_later_ordinary_supersede_makes_the_keyed_one_history():
    current = {'replaced_by_item_id': 'new-version'}
    revisions = [
        stored_revision('supersede', {'keyedReplacement': {'relation': 'RUNS_ON_PORT'},
                                      'replacedByItemId': 'new-version'}, minutes=0),
        stored_revision('supersede', {'replacedByItemId': 'latest-version'}, minutes=5),
    ]
    assert keyed_replacement(current, revisions) is False


def test_a_keyed_supersede_whose_link_points_elsewhere_is_not_keyed():
    current = {'replaced_by_item_id': 'somewhere-else'}
    revisions = [stored_revision('supersede', {
        'keyedReplacement': {'relation': 'RUNS_ON_PORT'},
        'replacedByItemId': 'new-version',
    })]
    assert keyed_replacement(current, revisions) is False


def test_a_supersede_before_a_restore_is_not_terminal():
    revisions = [
        stored_revision('supersede', {'replacedByItemId': 'new-version'}, minutes=0),
        stored_revision('restore', {}, minutes=5),
    ]
    assert terminal({}, revisions) is False


def test_a_supersede_after_the_restore_is_terminal():
    revisions = [
        stored_revision('restore', {}, minutes=0),
        stored_revision('supersede', {'replacedByItemId': 'new-version'}, minutes=5),
    ]
    assert terminal({}, revisions) is True


def test_any_replaced_by_item_id_is_terminal():
    assert terminal({'replaced_by_item_id': 'newer'}, []) is True


class _EndedGraph:
    """A driver whose relationships ended at the given times."""

    def __init__(self, ended):
        self.runtime = self
        self.driver = self
        self.ended = ended

    async def execute_query(self, _query, *, item_ids, **_):
        return [{'item_id': item_id, 'ended_at': self.ended[item_id]}
                for item_id in item_ids if item_id in self.ended], None, None


@pytest.mark.asyncio
async def test_the_same_words_after_their_relationship_ended_take_the_id_that_ending_names():
    first = stable_uuid('old', 'restated', 't1')
    space = {'group_id': 'synthetic'}
    assert await restated_relationships(_EndedGraph({}), space, ['old']) == {}
    assert await restated_relationships(_EndedGraph({'old': 't1'}), space, ['old', 'live']) == {'old': first}
    # The new item ended in turn: the next statement takes the one after it.
    chained = await restated_relationships(_EndedGraph({'old': 't1', first: 't2'}), space, ['old'])
    assert chained == {'old': stable_uuid(first, 'restated', 't2')}
