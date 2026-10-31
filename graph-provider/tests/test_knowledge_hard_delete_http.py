"""rec#5 C9 without a graph: the hard delete routes refuse every caller that
lacks the human-review channel before anything reads or writes the graph."""

import os
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings

REVIEW_TOKEN = 'synthetic-hard-delete-review-token-0123456789'


class UntouchedDriver:
    def __init__(self):
        self.queries = []

    async def execute_query(self, query, **_parameters):
        self.queries.append(query)
        raise AssertionError('the graph must not be read or written')


def application(driver, review_token=REVIEW_TOKEN):
    app = create_app(Settings(bootstrap_token='test-bootstrap-token-1234', human_review_token=review_token,
                              neo4j_password='test-password'))
    store = app.state.store
    store.runtime = SimpleNamespace(driver=driver)

    async def principal(_token):
        return {'id': 'principal-1', 'name': 'Synthetic owner'}

    store.authenticate = principal
    return app


async def call(app, path, body, headers):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://provider.test',
                                 headers={'authorization': 'Bearer synthetic-agent-access-token'}) as client:
        return await client.post(path, json=body, headers=headers)


PREVIEW = ('/v1/knowledge/items/item-1/hard-delete/preview', {'personal_space_id': 'space', 'item_kind': 'entity'})
EXPORT = ('/v1/knowledge/items/item-1/hard-delete/export', {
    'personal_space_id': 'space', 'item_kind': 'entity', 'preview_id': 'a' * 64})
DELETE = ('/v1/knowledge/items/item-1/hard-delete', {
    'personal_space_id': 'space', 'item_kind': 'entity', 'preview_id': 'a' * 64, 'confirmation': '删除'})


ASKS = [(path, {'personal_space_id': 'space'}) for path in (
    '/v1/knowledge/hard-delete-operations/00000000-0000-4000-8000-000000000000',
    '/v1/knowledge/hard-delete-operations/00000000-0000-4000-8000-000000000000/abort',
    '/v1/knowledge/hard-deletions', '/v1/knowledge/items/item-1/hard-delete/status')]


@pytest.mark.asyncio
@pytest.mark.parametrize('route', [PREVIEW, EXPORT, DELETE, *ASKS])
@pytest.mark.parametrize('headers', [{}, {'x-fuli-human-review-token': 'synthetic-wrong-token-000000000000000'}])
async def test_an_agent_access_token_alone_cannot_preview_or_delete(route, headers):
    driver = UntouchedDriver()
    response = await call(application(driver), *route, headers)
    assert response.status_code == 403
    assert response.json()['detail'] == 'independent human review proof required'
    assert driver.queries == []


@pytest.mark.asyncio
async def test_without_a_review_channel_nothing_can_delete():
    driver = UntouchedDriver()
    response = await call(application(driver, review_token=None), *DELETE,
                          {'x-fuli-human-review-token': REVIEW_TOKEN})
    assert response.status_code == 503 and driver.queries == []


@pytest.mark.asyncio
@pytest.mark.parametrize('change', [{'preview_id': 'not-a-digest'}, {'confirmation': ''}, {'operation_actor': 'agent'}])
async def test_a_delete_names_one_preview_and_the_persons_words_only(change):
    driver = UntouchedDriver()
    response = await call(application(driver), DELETE[0], {**DELETE[1], **change},
                          {'x-fuli-human-review-token': REVIEW_TOKEN})
    assert response.status_code == 422 and driver.queries == []
