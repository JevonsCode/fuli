"""The compounding statement's graph part: counts only, five aggregate reads.

Synthetic spaces and items only. The live-graph scenario is in
test_knowledge_statement_neo4j.py.
"""
import json
import re
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_audit import _agent_confirmation_basis
from fuli_graph.knowledge_statement import BASIS_FRAGMENTS, _INSTANT
from fuli_graph.models import ConfirmationActor, ConfirmationBasis
from fuli_graph.tonborg_confirmation import basis_json, tonborg_confirmation_basis
from test_knowledge_hard_delete_http import application

PATH = '/v1/knowledge/statement'
SPACE = 'synthetic-statement-space'
HEADERS = {'authorization': 'Bearer synthetic-agent-access-token'}
UNTIL = datetime(2026, 11, 16, tzinfo=timezone.utc)
SINCE = UNTIL - timedelta(days=7)
POINTS = [UNTIL - timedelta(days=7), UNTIL]


def body(**overrides):
    return {'personal_space_id': SPACE, 'since': SINCE.isoformat(), 'until': UNTIL.isoformat(),
            'points': [point.isoformat() for point in POINTS], **overrides}


class StatementDriver:
    """Answers each of the five reads by what it asks for."""

    def __init__(self):
        self.queries = []

    async def execute_query(self, query, **parameters):
        self.queries.append((query, parameters))
        assert parameters['routing_'] == 'r'
        assert parameters['since'] == SINCE and parameters['until'] == UNTIL
        if 'MATCH (item:Entity' in query:
            return [{'series': [2, 3], 'captured': 1, 'retired': 1, 'confirmed_by_you': 1,
                     'confirmed_by_tonborg': 0, 'promoted_by_use': 1}], None, None
        if '[item:RELATES_TO' in query:
            return [{'series': [1, 1], 'captured': 2, 'retired': 0, 'confirmed_by_you': 0,
                     'confirmed_by_tonborg': 1, 'promoted_by_use': None}], None, None
        if "action: 'knowledge_used'" in query:
            assert parameters['space_id'] == SPACE
            return [{'times': 4, 'tasks': 2, 'cited': 1, 'applied': 3}], None, None
        if 'FuliProjectAgentTask' in query:
            return [{'finished': 5, 'failed': None}], None, None
        if 'FuliAgentAttention' in query:
            return [{'questions': 2}], None, None
        raise AssertionError(query)


def statement_app(driver, kind='personal'):
    app = application(driver)

    async def authorize(actor, space_id, role):
        assert actor['id'] == 'principal-1' and role == 'reader'
        if space_id != SPACE:
            raise HTTPException(status_code=403, detail='Synthetic foreign space denied')
        return {'id': SPACE, 'kind': kind, 'group_id': 'synthetic-statement-group'}

    app.state.store.authorize = authorize
    return app


async def post(app, payload, headers=HEADERS):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url='http://synthetic.test', headers=headers) as client:
        return await client.post(PATH, json=payload)


@pytest.mark.asyncio
async def test_statement_adds_entities_and_relationships_from_five_aggregate_reads():
    driver = StatementDriver()
    response = await post(statement_app(driver), body())
    assert response.status_code == 200, response.text
    assert response.json() == {
        'series': [3, 4],
        'used': {'times': 4, 'tasks': 2, 'cited': 1, 'applied': 3},
        'learned': {'captured': 3, 'confirmed_by_you': 1, 'confirmed_by_tonborg': 1, 'promoted_by_use': 1, 'retired': 1},
        'done': {'finished': 5, 'failed': 0},
        'answered': 2,
    }
    assert len(driver.queries) == 5
    item_reads = [parameters for query, parameters in driver.queries if 'MATCH (item:Entity' in query or '[item:RELATES_TO' in query]
    assert [parameters['group_id'] for parameters in item_reads] == ['synthetic-statement-group'] * 2
    assert all(parameters['points'] == POINTS for parameters in item_reads)


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [
    body(personal_space_id=''),
    body(since=UNTIL.isoformat()),
    body(since='2026-11-09T00:00:00'),
    body(points=[]),
    body(points=[UNTIL.isoformat(), (UNTIL - timedelta(days=7)).isoformat()]),
    body(points=[(UNTIL - timedelta(days=7)).isoformat()]),
    body(points=[(UNTIL - timedelta(days=7 * index)).isoformat() for index in range(27, -1, -1)]),
    body(item_ids=['must-not-be-accepted']),
])
async def test_statement_refuses_a_window_it_cannot_count_before_reading(payload):
    driver = StatementDriver()
    response = await post(statement_app(driver), payload)
    assert response.status_code == 422, response.text
    assert driver.queries == []


@pytest.mark.asyncio
@pytest.mark.parametrize('headers,space,kind,status', [
    ({}, SPACE, 'personal', 401),
    (HEADERS, 'foreign-space', 'personal', 403),
    (HEADERS, SPACE, 'workspace', 422),
])
async def test_statement_authorizes_the_personal_space_before_any_read(headers, space, kind, status):
    driver = StatementDriver()
    response = await post(statement_app(driver, kind), body(personal_space_id=space), headers)
    assert response.status_code == status, response.text
    assert driver.queries == []


def confirmed_at_of(basis: str):
    """What the Cypher extraction reads: the text after the key up to the next quote."""
    key = BASIS_FRAGMENTS['confirmed_at_key']
    if key not in basis:
        return None
    text = basis.split(key)[1].split('"')[0]
    return text if re.fullmatch(_INSTANT, text) else None


def test_basis_fragments_match_what_every_confirmation_writer_stores():
    confirmed_at = datetime(2026, 11, 10, 9, 30, 15, 123456, tzinfo=timezone.utc)
    pending = {'existence_reason': 'Synthetic reason with "quotes" and "confirmed_at": "1999-01-01T00:00:00Z"',
               'quadrant_reason': 'Synthetic quadrant', 'proposed_by': {'kind': 'agent', 'label': 'Fuli'}}
    tonborg = basis_json(tonborg_confirmation_basis(pending, confirmed_at))
    usage = json.dumps(_agent_confirmation_basis(pending, confirmed_at), ensure_ascii=False, sort_keys=True)
    person = json.dumps(ConfirmationBasis(
        **pending, confirmed_by=ConfirmationActor(kind='user', label='Synthetic person'),
        confirmed_at=confirmed_at).model_dump(mode='json'), ensure_ascii=False, sort_keys=True)
    unconfirmed = json.dumps(ConfirmationBasis(**pending).model_dump(mode='json'), ensure_ascii=False, sort_keys=True)

    fragments = BASIS_FRAGMENTS
    assert fragments['by_agent'] in tonborg and fragments['tonborg_policy'] in tonborg
    assert fragments['usage_policy'] not in tonborg
    assert fragments['by_agent'] in usage and fragments['usage_policy'] in usage
    assert fragments['by_user'] in person and fragments['any_policy'] not in person
    assert fragments['by_user'] not in unconfirmed and fragments['by_agent'] not in unconfirmed
    for stored in (tonborg, usage, person):
        assert datetime.fromisoformat(confirmed_at_of(stored).replace('Z', '+00:00')) == confirmed_at
    # A quoted key inside a reason is escaped, so it is never read as the confirmation time.
    assert confirmed_at_of(unconfirmed) is None
