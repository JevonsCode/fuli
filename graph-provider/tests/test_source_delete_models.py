"""Source targets distinguish an episode UUID from a complete session identity."""
import pytest
from pydantic import ValidationError

from fuli_graph.knowledge_source_delete_models import SourceDeleteRef


@pytest.mark.parametrize('fields', [
    {'item_kind': 'session', 'source_application': 'codex'},
    {'item_kind': 'session', 'fuli_session_id': 'session'},
    {'item_kind': 'session', 'source_application': 'codex', 'fuli_session_id': ''},
    {'item_kind': 'episode', 'source_application': 'codex', 'fuli_session_id': 'session'},
    {'item_kind': 'source_turn'},
])
def test_source_range_rejects_ambiguous_identity(fields):
    with pytest.raises(ValidationError):
        SourceDeleteRef(personal_space_id='space', **fields)


def test_source_range_rejects_contradictory_selection():
    with pytest.raises(ValidationError):
        SourceDeleteRef(personal_space_id='space', item_kind='session', source_application='codex',
                        fuli_session_id='session', include=['entity:one'], exclude=['entity:one'])


def test_episode_identity_does_not_accept_a_caller_supplied_turn():
    value = SourceDeleteRef(personal_space_id='space', item_kind='episode')
    assert value.source_application is value.fuli_session_id is None


@pytest.mark.parametrize('keys', [['episode:one'], ['entity:'], ['entity:two words'],
                                 ['entity:one', 'entity:one'], ['entity:' + 'x' * 506]])
@pytest.mark.parametrize('field', ['include', 'exclude'])
def test_selection_keys_are_bounded_canonical_unique_knowledge_identities(keys, field):
    with pytest.raises(ValidationError):
        SourceDeleteRef(personal_space_id='space', item_kind='episode', **{field: keys})
