"""D-31.B5 exposes an authorized aggregate, never a deletion inventory."""
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.knowledge_deletion_watermark import KnowledgeDeletionWatermark
from test_knowledge_hard_delete_http import application

PATH = '/v1/knowledge/hard-deletions/watermark'
SPACE = 'synthetic-watermark-space'
HEADERS = {'authorization': 'Bearer synthetic-agent-access-token'}


class AggregateDriver:
    def __init__(self, count=0, latest=None):
        self.count, self.latest = count, latest
        self.queries = []

    async def execute_query(self, query, **parameters):
        self.queries.append((query, parameters))
        assert "action: 'hard_delete'" in query
        assert 'RETURN count(trace) AS count, max(trace.created_at) AS latest_deleted_at' in query
        assert parameters == {'space_id': SPACE, 'routing_': 'r'}
        return [{'count': self.count, 'latest_deleted_at': self.latest}], None, None


def watermark_app(driver, kind='personal'):
    app = application(driver)

    async def authorize(actor, space_id, role):
        assert actor['id'] == 'principal-1' and role == 'reader'
        if space_id != SPACE:
            raise HTTPException(status_code=403, detail='Synthetic foreign space denied')
        return {'id': SPACE, 'kind': kind, 'group_id': 'synthetic-watermark-group'}

    app.state.store.authorize = authorize
    return app


@pytest.mark.asyncio
@pytest.mark.parametrize('count,latest', [(0, None), (3, datetime(2026, 10, 23, tzinfo=timezone.utc))])
async def test_ordinary_agent_reads_exactly_the_two_aggregate_fields(count, latest):
    driver = AggregateDriver(count, latest)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=watermark_app(driver)),
                                 base_url='http://synthetic.test', headers=HEADERS) as client:
        response = await client.post(PATH, json={'personal_space_id': SPACE})
    assert response.status_code == 200, response.text
    assert set(response.json()) == {'count', 'latest_deleted_at'}
    assert response.json()['count'] == count
    assert KnowledgeDeletionWatermark.model_validate(response.json()).latest_deleted_at == latest
    assert len(driver.queries) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [{}, {'personal_space_id': ''},
    {'personal_space_id': SPACE, 'item_id': 'must-not-be-accepted'},
    {'personal_space_id': SPACE, 'include_records': True}])
async def test_watermark_request_rejects_missing_invalid_and_unknown_fields(body):
    driver = AggregateDriver()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=watermark_app(driver)),
                                 base_url='http://synthetic.test', headers=HEADERS) as client:
        response = await client.post(PATH, json=body)
    assert response.status_code == 422, response.text
    assert driver.queries == []


@pytest.mark.asyncio
@pytest.mark.parametrize('headers,space,kind,status', [
    ({}, SPACE, 'personal', 401),
    ({'authorization': 'Basic synthetic'}, SPACE, 'personal', 401),
    (HEADERS, 'foreign-space', 'personal', 403),
    (HEADERS, SPACE, 'workspace', 422),
])
async def test_watermark_authentication_and_personal_space_authorization_precede_graph_read(headers, space, kind, status):
    driver = AggregateDriver()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=watermark_app(driver, kind)),
                                 base_url='http://synthetic.test', headers=headers) as client:
        response = await client.post(PATH, json={'personal_space_id': space})
    assert response.status_code == status, response.text
    assert driver.queries == []


def test_response_contract_forbids_deletion_ids_and_content():
    for field in ['deletion_ids', 'records', 'name', 'content']:
        with pytest.raises(ValidationError):
            KnowledgeDeletionWatermark.model_validate({'count': 1, 'latest_deleted_at': None, field: []})


@pytest.mark.asyncio
async def test_rejected_bearer_token_cannot_read_watermark():
    driver = AggregateDriver()
    app = watermark_app(driver)

    async def reject(_token):
        raise HTTPException(status_code=401, detail='Synthetic invalid token')

    app.state.store.authenticate = reject
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://synthetic.test',
                                 headers=HEADERS) as client:
        response = await client.post(PATH, json={'personal_space_id': SPACE})
    assert response.status_code == 401
    assert driver.queries == []
