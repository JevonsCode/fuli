"""rec#10 D-24 without a graph: undoing Tonborg's automatic review is the
person's decision, so its route refuses an Agent's access token alone before
anything reads or writes the graph."""

import os
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings

REVIEW_TOKEN = 'synthetic-ai-review-undo-token-0123456789'
WITHDRAW = '/v1/knowledge/reviews/ai-review/withdraw'
BODY = {'personal_space_id': 'space', 'review_id': 'review-1', 'candidate_key': 'entity:one',
        'ai_review_evidence_token': 'c' * 64}


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


async def call(app, headers):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://provider.test',
                                 headers={'authorization': 'Bearer synthetic-agent-access-token'}) as client:
        return await client.post(WITHDRAW, json=BODY, headers=headers)


@pytest.mark.asyncio
@pytest.mark.parametrize('headers', [{}, {'x-fuli-human-review-token': 'synthetic-wrong-token-000000000000000'}])
async def test_an_agent_access_token_alone_cannot_undo_an_ai_review(headers):
    driver = UntouchedDriver()
    response = await call(application(driver), headers)
    assert response.status_code == 403
    assert response.json()['detail'] == 'independent human review proof required'
    assert driver.queries == []


@pytest.mark.asyncio
async def test_without_a_review_channel_nothing_can_undo_an_ai_review():
    driver = UntouchedDriver()
    response = await call(application(driver, review_token=None), {'x-fuli-human-review-token': REVIEW_TOKEN})
    assert response.status_code == 503 and driver.queries == []
