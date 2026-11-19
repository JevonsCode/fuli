"""Which recorded session made each session temporary project. Synthetic driver
double; the Cypher itself runs in test_temporary_project_sources_neo4j.py."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph import temporary_project_sources as sources
from fuli_graph.temporary_project_scope import conversation_fallback_project_id, session_temporary_project_id

SPACE = {'id': 'picker-qa', 'group_id': 'synthetic-group'}


class Driver:
    def __init__(self, project_ids, sessions):
        self.project_ids, self.sessions, self.queries = project_ids, sessions, []

    async def execute_query(self, query, **parameters):
        self.queries.append(query)
        if 'CONTAINS_PROJECT' in query and 'scope_type' in query:
            return [{'project_id': project_id} for project_id in self.project_ids], None, None
        assert 'FuliConversationSession' in query and 'Episodic' in query
        return [{'client': client, 'session_id': session} for client, session in self.sessions], None, None


def store_with(project_ids, sessions, *, allowed=True):
    async def authorize(_actor, space_id, role):
        assert (space_id, role) == (SPACE['id'], 'reader')
        if not allowed:
            raise HTTPException(403, 'not allowed')
        return SPACE
    return SimpleNamespace(_require_personal=lambda: None, authorize=authorize,
                           runtime=SimpleNamespace(driver=Driver(project_ids, sessions)))


@pytest.fixture(autouse=True)
def no_scopes(monkeypatch):
    async def scopes(_store, _space_id):
        return {'synthetic-scope'}
    monkeypatch.setattr(sources, 'conversation_scopes_for_space', scopes)


@pytest.mark.asyncio
async def test_a_recorded_session_proves_the_project_it_derives_in_either_format_dates_or_not():
    new = session_temporary_project_id(SPACE['id'], 'claude_code', 'synthetic-s1')
    old = conversation_fallback_project_id(SPACE['id'], 'codex', 'qa-native-17')
    task = 'temporary-' + 'b' * 64
    store = store_with([new, old, task], [('claude_code', 'synthetic-s1'), ('codex', 'qa-native-17'), ('codex', 'unrelated')])
    found = await sources.temporary_project_sources(store, {'id': 'actor'}, SPACE['id'])
    assert found == sorted([
        {'personal_project_id': new, 'source_application': 'claude_code', 'session_id': 'synthetic-s1'},
        {'personal_project_id': old, 'source_application': 'codex', 'session_id': 'qa-native-17'},
    ], key=lambda row: row['personal_project_id'])
    # A task temporary project derives from no session: it has no source, never a guessed one.
    assert task not in {row['personal_project_id'] for row in found}


@pytest.mark.asyncio
async def test_a_session_of_another_space_or_a_missing_client_proves_nothing_else():
    other_space = session_temporary_project_id('other-space', 'codex', 'synthetic-s2')
    no_client = session_temporary_project_id(SPACE['id'], 'other', 'synthetic-s3')
    store = store_with([other_space, no_client], [('codex', 'synthetic-s2'), (None, 'synthetic-s3')])
    found = await sources.temporary_project_sources(store, {'id': 'actor'}, SPACE['id'])
    # A journal event without a client was derived as 'other', exactly as the code that made the ID.
    assert found == [{'personal_project_id': no_client, 'source_application': 'other', 'session_id': 'synthetic-s3'}]


@pytest.mark.asyncio
async def test_two_sessions_deriving_one_id_name_no_source(monkeypatch):
    monkeypatch.setattr(sources, 'session_temporary_project_id', lambda *_: 'temporary-' + 'c' * 64)
    store = store_with(['temporary-' + 'c' * 64], [('codex', 'synthetic-a'), ('claude_code', 'synthetic-b')])
    assert await sources.temporary_project_sources(store, {'id': 'actor'}, SPACE['id']) == []


@pytest.mark.asyncio
async def test_no_temporary_project_reads_no_session_and_a_reader_must_be_allowed():
    store = store_with([], [('codex', 'synthetic-s1')])
    assert await sources.temporary_project_sources(store, {'id': 'actor'}, SPACE['id']) == []
    assert len(store.runtime.driver.queries) == 1
    with pytest.raises(HTTPException):
        await sources.temporary_project_sources(store_with(['x'], [], allowed=False), {'id': 'actor'}, SPACE['id'])
