"""A change recorded as the person's own needs the console's human-review
proof: the access token alone, which every Agent holds, cannot claim it.
Synthetic bodies only; the graph is never reached without the proof."""

import os
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph import app as provider_app
from fuli_graph.app import create_app
from fuli_graph.config import Settings

REVIEW_TOKEN = 'synthetic-person-change-review-token-0123456789'
PROOF = {'x-fuli-human-review-token': REVIEW_TOKEN}
WRONG = {'x-fuli-human-review-token': 'synthetic-wrong-review-token-0123456789abcd'}
SPACE = {'personal_space_id': 'personal-space'}
ACTOR = {'kind': 'user'}
# route -> (method, path, body without operation_actor, the function it calls)
ROUTES = {
    'revise': ('PATCH', '/v1/knowledge/items/item-1',
               {**SPACE, 'item_kind': 'entity', 'action': 'invalidate', 'reason': 'Synthetic.'},
               'revise_knowledge_item'),
    'batch': ('POST', '/v1/knowledge/batch-confirmations',
              {**SPACE, 'group_kind': 'session', 'group_value': 'synthetic-session', 'reason': 'Synthetic.',
               'confirmer': ACTOR, 'items': [{'item_id': 'item-1', 'item_kind': 'entity',
                                              'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.',
                                              'proposed_by': {'kind': 'agent'}}]},
              'confirm_knowledge_batch'),
    'assignment': ('POST', '/v1/knowledge/items/item-1/assignment',
                   {**SPACE, 'item_kind': 'entity', 'target_project_id': 'project-b', 'reason': 'Synthetic.'},
                   'reassign_knowledge_item'),
    'common': ('POST', '/v1/knowledge/common-promotions',
               {**SPACE, 'parent_project_id': 'parent', 'item_kind': 'entity', 'canonical_item_id': 'item-1',
                'duplicate_item_ids': ['item-2'], 'reason': 'Synthetic.', 'human_confirmation_reason': 'Synthetic.'},
               'apply_common_knowledge_promotion'),
    'resolve': ('POST', '/v1/preference-conflicts/conflict-1/resolve',
                {**SPACE, 'resolution': 'keep_left', 'reason': 'Synthetic.'}, 'resolve_preference_conflict'),
    'complete': ('POST', '/v1/preference-conflicts/conflict-1/complete',
                 {**SPACE, 'resolution': 'keep_left', 'reason': 'Synthetic.'}, 'complete_preference_conflict'),
}


class Reached(HTTPException):
    """The route passed its checks and called the domain function."""

    def __init__(self):
        super().__init__(status_code=418, detail='reached')


@pytest.fixture
def provider(monkeypatch):
    application = create_app(Settings(bootstrap_token='test-bootstrap-token-1234', human_review_token=REVIEW_TOKEN,
                                      neo4j_password='test-password'))

    async def refuse_graph(*_args, **_parameters):
        raise AssertionError('the graph must not be read or written')

    async def principal(_token):
        return {'id': 'principal-1', 'name': 'Synthetic owner'}

    application.state.store.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=refuse_graph))
    application.state.store.authenticate = principal
    actors = []

    async def reached(_store, actor, *_rest):
        actors.append(actor)
        raise Reached()

    for _method, _path, _body, function in ROUTES.values():
        monkeypatch.setattr(provider_app, function, reached)
    return application, actors


async def send(application, route, operation_actor, headers):
    method, path, body, _function = ROUTES[route]
    payload = body if operation_actor is None else {**body, 'operation_actor': operation_actor}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://provider.test',
                                 headers={'authorization': 'Bearer synthetic-agent-access-token'}) as client:
        return await client.request(method, path, json=payload, headers=headers)


@pytest.mark.asyncio
@pytest.mark.parametrize('route', sorted(ROUTES))
async def test_the_access_token_alone_cannot_record_a_change_as_the_persons(provider, route):
    application, actors = provider
    for headers in ({}, WRONG):
        refused = await send(application, route, 'human', headers)
        assert refused.status_code == 403, refused.text
        assert refused.json()['detail'] == 'independent human review proof required'
    assert actors == []

    as_person = await send(application, route, 'human', PROOF)
    assert as_person.status_code == 418, as_person.text
    assert actors[-1]['_human_review_verified'] is True

    as_agent = await send(application, route, 'agent', {})
    assert as_agent.status_code == 418, as_agent.text
    assert '_human_review_verified' not in actors[-1]


@pytest.mark.asyncio
async def test_completing_a_conflict_defaults_to_the_person_and_needs_the_proof(provider):
    application, actors = provider
    assert (await send(application, 'complete', None, {})).status_code == 403
    assert actors == []
    assert (await send(application, 'complete', None, PROOF)).status_code == 418
