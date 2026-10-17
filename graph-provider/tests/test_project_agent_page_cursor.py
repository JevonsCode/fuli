import pytest
from fastapi import HTTPException

from fuli_graph.store_project_agent_pages import decode_cursor, encode_cursor


def test_cursor_round_trips_unicode_names():
    cursor = encode_cursor(2, '张 三 / Ünïcode', 'agent-1')
    assert '=' not in cursor
    assert decode_cursor(cursor) == (2, '张 三 / Ünïcode', 'agent-1')


@pytest.mark.parametrize('cursor', ['not-a-cursor', encode_cursor(2, 'x', 'y')[:-3], 'W1sxXV0'])
def test_malformed_cursors_are_rejected_not_guessed(cursor):
    with pytest.raises(HTTPException) as raised:
        decode_cursor(cursor)
    assert raised.value.status_code == 422
