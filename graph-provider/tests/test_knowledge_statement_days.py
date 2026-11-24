"""The compounding statement day by day: three aggregate reads grouped by local day.

Synthetic spaces and counts only. The live-graph scenario, with items on both
sides of a local midnight, is in test_knowledge_statement_days_neo4j.py.
"""
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest

from fuli_graph.knowledge_statement import USES_MATCH
from test_knowledge_statement import HEADERS, SPACE, statement_app

PATH = '/v1/knowledge/statement/days'
LOCAL = timezone(timedelta(hours=8))
SINCE = datetime(2026, 11, 9, tzinfo=LOCAL)
UNTIL = datetime(2026, 11, 16, tzinfo=LOCAL)
# Whole days since 1970-01-01, as the Cypher cuts them.
NOV_10 = (date(2026, 11, 10) - date(1970, 1, 1)).days


def body(**overrides):
    return {'personal_space_id': SPACE, 'since': SINCE.isoformat(), 'until': UNTIL.isoformat(), **overrides}


class DaysDriver:
    """Answers each of the three reads with rows grouped by day."""

    def __init__(self):
        self.queries = []

    async def execute_query(self, query, **parameters):
        self.queries.append((query, parameters))
        assert parameters['routing_'] == 'r' and parameters['offset_ms'] == 8 * 60 * 60 * 1000
        if 'MATCH (item:Entity' in query:
            return [{'measure': 'learned', 'day': NOV_10, 'count': 2},
                    {'measure': 'confirmed', 'day': NOV_10 + 2, 'count': 1}], None, None
        if '[item:RELATES_TO' in query:
            return [{'measure': 'learned', 'day': NOV_10, 'count': 1}], None, None
        if USES_MATCH in query:
            assert parameters['space_id'] == SPACE
            return [{'measure': 'used', 'day': NOV_10 + 2, 'count': 4},
                    {'measure': 'used', 'day': NOV_10 + 3, 'count': 0}], None, None
        raise AssertionError(query)


async def post(app, payload, headers=HEADERS):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url='http://synthetic.test', headers=headers) as client:
        return await client.post(PATH, json=payload)


@pytest.mark.asyncio
async def test_days_add_entities_relationships_and_uses_per_local_day_and_drop_empty_days():
    driver = DaysDriver()
    response = await post(statement_app(driver), body())
    assert response.status_code == 200, response.text
    assert response.json() == {'days': [
        {'day': '2026-11-10', 'learned': 3, 'confirmed': 0, 'used': 0},
        {'day': '2026-11-12', 'learned': 0, 'confirmed': 1, 'used': 4},
    ]}
    assert len(driver.queries) == 3
    assert all(parameters['since'] == SINCE and parameters['until'] == UNTIL for _, parameters in driver.queries)
    # The weekly statement's definitions, cut into local days in Cypher; no vector is read.
    for query, _ in driver.queries:
        assert 'epochMillis + $offset_ms' in query and 'embedding' not in query


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [
    body(personal_space_id=''),
    body(since=UNTIL.isoformat()),
    body(since='2026-11-09T00:00:00'),
    body(since=SINCE.astimezone(timezone.utc).isoformat()),
    body(since=(UNTIL - timedelta(days=372)).isoformat()),
    body(points=[UNTIL.isoformat()]),
])
async def test_days_refuse_a_range_they_cannot_count_before_reading(payload):
    driver = DaysDriver()
    response = await post(statement_app(driver), payload)
    assert response.status_code == 422, response.text
    assert driver.queries == []


@pytest.mark.asyncio
async def test_days_read_up_to_371_days_and_authorize_the_space_first():
    driver = DaysDriver()
    year = await post(statement_app(driver), body(since=(UNTIL - timedelta(days=371)).isoformat()))
    assert year.status_code == 200, year.text
    assert len(driver.queries) == 3
    foreign = DaysDriver()
    refused = await post(statement_app(foreign), body(personal_space_id='foreign-space'))
    assert refused.status_code == 403 and foreign.queries == []
