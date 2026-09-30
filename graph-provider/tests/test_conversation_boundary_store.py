"""Store transaction tests; real Cypher/CAS is also covered by the opt-in Neo4j suite."""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.agent_conversation_models import ConversationWrite
from fuli_graph.store_agent_conversations import StoreAgentConversations


class EmptyCursorDriver:
    def __init__(self):
        self.cursor = None
        self.calls = []

    @asynccontextmanager
    async def transaction(self):
        original = self.cursor
        try:
            yield self
        except Exception:
            self.cursor = original
            raise

    async def run(self, query, **parameters):
        self.calls.append(query)
        if query.startswith('MERGE (s:FuliTranscriptCursor') and self.cursor is None:
            self.cursor = {'cursor': 0, 'initialized': False}
        rows = []
        if 'RETURN s.cursor AS cursor' in query and self.cursor is not None:
            if self.cursor['cursor'] == parameters['expected'] and (
                not parameters['initialize'] or (self.cursor['cursor'] == 0 and not self.cursor['initialized'])
            ):
                self.cursor = {'cursor': parameters['cursor'], 'initialized': True}
                rows = [{'cursor': parameters['cursor']}]
        async def result():
            for row in rows:
                yield row
        return result()


class BoundaryStore(StoreAgentConversations):
    def __init__(self, denied=None):
        self.runtime = SimpleNamespace(driver=EmptyCursorDriver())
        self.authorizations = []
        self.denied = denied

    async def _conversation_scope(self, actor, request, *, write=False):
        self.authorizations.append(('scope', write))
        if self.denied == 'scope':
            raise HTTPException(403, 'Denied')
        return 'synthetic-scope'

    async def _conversation_task(self, actor, request):
        self.authorizations.append(('task', request.task_context_token))
        if self.denied == 'task':
            raise HTTPException(409, 'Stale task')


def request(**changes):
    return ConversationWrite(**{
        'personal_space_id': 'synthetic-space', 'personal_project_id': 'synthetic-project',
        'agent_id': 'engineer', 'source_application': 'codex', 'session_id': 'fresh-session',
        'task_context_token': 'fuli-task-synthetic', 'expected_cursor': 0, 'cursor': 10,
        'initialize_cursor': True, **changes,
    })


@pytest.mark.asyncio
async def test_first_verified_boundary_creates_cursor_without_append():
    store = BoundaryStore()
    assert await store.claim_conversation_boundary(None, request()) == {'status': 'bound', 'cursor': 10}
    assert store.authorizations == [('scope', True), ('task', 'fuli-task-synthetic')]
    assert store.runtime.driver.cursor == {'cursor': 10, 'initialized': True}


@pytest.mark.asyncio
@pytest.mark.parametrize('denied', ['scope', 'task'])
async def test_boundary_checks_permissions_before_any_cursor_write(denied):
    store = BoundaryStore(denied)
    with pytest.raises(HTTPException):
        await store.claim_conversation_boundary(None, request())
    assert store.runtime.driver.calls == []
    assert store.runtime.driver.cursor is None


@pytest.mark.asyncio
async def test_failed_initial_cas_rolls_back_creation_and_normal_boundary_never_creates():
    store = BoundaryStore()
    for invalid in [request(expected_cursor=1), request(initialize_cursor=False, cursor=0)]:
        with pytest.raises(HTTPException) as error:
            await store.claim_conversation_boundary(None, invalid)
        assert error.value.status_code == 409
        assert store.runtime.driver.cursor is None
    await store.claim_conversation_boundary(None, request(cursor=0))
    with pytest.raises(HTTPException) as error:
        await store.claim_conversation_boundary(None, request(cursor=0))
    assert error.value.status_code == 409
    assert store.runtime.driver.cursor == {'cursor': 0, 'initialized': True}
