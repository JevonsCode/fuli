"""The authorized session detail exposes its existing opaque deletion identity."""
import pytest

from test_knowledge_hard_delete_http import application, call


class EmptySessionDriver:
    async def execute_query(self, query, **params):
        return [], None, None


@pytest.mark.asyncio
@pytest.mark.parametrize('source_application', ['codex', None])
async def test_session_detail_only_names_a_delete_target_for_a_confirmed_client(source_application):
    app = application(EmptySessionDriver())
    authorized = []
    async def authorize(actor, space_id, role):
        authorized.append((space_id, role))
        return {'id': space_id, 'group_id': 'synthetic-group', 'kind': 'personal'}
    app.state.store.authorize = authorize
    body = {'personal_space_id': 'space', 'session_id': 'session'}
    if source_application:
        body['source_application'] = source_application
    response = await call(app, '/v1/session-records', body, {})
    assert response.status_code == 200, response.text
    assert authorized == [('space', 'reader')]
    expected = app.state.store._task_session_id('space', 'codex', 'session') if source_application else None
    assert response.json()['deletion_target_id'] == expected
