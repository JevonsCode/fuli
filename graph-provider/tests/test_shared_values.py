import json
from datetime import UTC, datetime

import pytest

from fuli_graph.auth import token_hash
from fuli_graph.model_validation import unique_text_list
from fuli_graph.models import stored_confirmation_basis
from fuli_graph.provider_values import sha256_text, stored_epoch
from fuli_graph.store_project_agents import _recent_task_title


def test_stored_confirmation_basis_reads_json_and_tolerates_bad_data():
    basis = {
        'existence_reason': 'The user said so.',
        'quadrant_reason': 'Stated directly.',
        'proposed_by': {'kind': 'user'},
    }

    assert stored_confirmation_basis(json.dumps(basis)).proposed_by.kind == 'user'
    assert stored_confirmation_basis(basis).existence_reason == 'The user said so.'
    assert stored_confirmation_basis(None) is None
    assert stored_confirmation_basis('not json') is None
    assert stored_confirmation_basis({'existence_reason': ''}) is None


def test_unique_text_list_trims_and_rejects_case_insensitive_duplicates():
    assert unique_text_list([' a ', 'B'], 'tools') == ['a', 'B']
    with pytest.raises(ValueError, match='tools must be unique'):
        unique_text_list(['a', 'A'], 'tools')
    with pytest.raises(ValueError, match='tools must contain 1 to 3 characters'):
        unique_text_list(['abcd'], 'tools', maximum=3)


def test_text_digests_share_one_encoding():
    expected = 'b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c'
    assert sha256_text('foo\n') == expected
    assert token_hash('foo\n') == expected


def test_a_stored_time_reads_as_seconds_whether_the_graph_or_an_early_fuli_wrote_it():
    moment = datetime(2026, 11, 1, tzinfo=UTC)
    assert stored_epoch(moment) == stored_epoch('2026-11-01T00:00:00Z') == moment.timestamp()
    assert stored_epoch('not a time') == stored_epoch(None) == 0.0
    # A task an early FULI stored with a text time still ranks by it.
    worked = [{'title': 'Older task', 'updated_at': '2026-10-01T00:00:00Z'},
              {'title': 'Newer task', 'updated_at': moment}]
    assert _recent_task_title([], worked) == 'Newer task'
