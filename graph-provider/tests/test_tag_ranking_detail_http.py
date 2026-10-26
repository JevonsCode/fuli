"""On-demand ranking explanations over synthetic HTTP and storage ports."""
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Annotated
from unittest.mock import AsyncMock
import json

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException

from fuli_graph.knowledge_item_routes import register_knowledge_item_routes
from knowledge_tag_memory import MemoryVocabulary, SPACE


class DetailStore:
    def __init__(self):
        self.vocabulary = MemoryVocabulary()
        self.settings = SimpleNamespace(graph_limit=100, provider_mode='personal')
        self.runtime = SimpleNamespace(driver=self, graphiti=SimpleNamespace(search=AsyncMock(return_value=[])))
        self.denied = False
        self.missing = False
        self.rows = [self.item('ordinary'), self.item('tagged')]

    @staticmethod
    def item(item_id):
        return {'id': item_id, 'group_id': 'synthetic-group', 'name': 'Deployment',
                'summary': 'Synthetic deployment guidance', 'type': 'ProjectFact',
                'confirmation_status': 'confirmed', 'epistemic_status': 'confirmed',
                'has_global_episode': True,
                'confirmation_basis_json': json.dumps({
                    'existence_reason': 'Synthetic evidence', 'quadrant_reason': 'Synthetic test',
                    'proposed_by': {'kind': 'agent'}, 'confirmed_by': {'kind': 'user'},
                    'confirmed_at': '2026-10-18T00:00:00Z'}),
                'created_at': datetime(2026, 1, 1, tzinfo=timezone.utc)}

    def _require_personal(self):
        pass

    async def authorize(self, actor, space_id, role):
        assert actor['id'] == 'synthetic-owner'
        if self.denied or space_id != SPACE:
            raise HTTPException(status_code=403, detail='Synthetic space denied')
        return {'id': SPACE, 'kind': 'personal', 'group_id': 'synthetic-group'}

    def knowledge_tag_vocabulary(self):
        return self.vocabulary

    async def execute_query(self, query, **parameters):
        if 'RETURN item.name AS name' in query:
            return ([] if self.missing else [self.item(parameters['item_id'])]), None, None
        if 'MATCH (node:Entity {group_id:' in query:
            return self.rows, None, None
        return [], None, None

    def tag(self):
        tag_id = self.vocabulary.seed(['deployment'])[0]
        self.vocabulary.tags[tag_id]['status'] = 'active'
        self.vocabulary.links['synthetic-link'] = {
            'id': 'synthetic-link', 'space_id': SPACE, 'tag_id': tag_id,
            'item_kind': 'entity', 'item_id': 'tagged', 'status': 'attached',
            'attached_at': datetime(2026, 1, 1, tzinfo=timezone.utc)}
        return tag_id


def client_for(store):
    application = FastAPI()

    # A ranking explanation is the console's: it carries the human-review proof.
    async def actor():
        return {'id': 'synthetic-owner', '_human_review_verified': True}

    owner = Annotated[dict, Depends(actor)]
    register_knowledge_item_routes(application, store, owner, owner, owner)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://synthetic.test')


def detail_request(**changes):
    return {'personal_space_id': SPACE, 'item_kind': 'entity', 'item_id': 'tagged', **changes}


def search_context(**changes):
    return {'space_ids': [SPACE], 'query': 'deployment', 'include_personal_global': True, **changes}


@pytest.mark.asyncio
async def test_normal_detail_keeps_existing_fields_and_does_not_search():
    store = DetailStore()
    async with client_for(store) as client:
        response = await client.post('/v1/knowledge/item-views', json=detail_request())
    assert response.status_code == 200, response.text
    assert 'tag_ranking' not in response.json()
    assert response.json()['current_item_id'] is None
    assert response.json()['evidence'] == []
    store.runtime.graphiti.search.assert_not_awaited()


@pytest.mark.asyncio
async def test_detail_recomputes_one_item_ranking_from_current_tags():
    store = DetailStore()
    tag_id = store.tag()
    async with client_for(store) as client:
        payload = detail_request(query_tags=search_context())
        response = await client.post('/v1/knowledge/item-views', json=payload)
        assert response.status_code == 200, response.text
        ranking = response.json()['tag_ranking']
        assert ranking['original_rank'] == 2
        assert ranking['final_rank'] == 1
        assert ranking['final_score'] > ranking['original_score']
        assert ranking['matches'][0]['tag_id'] == tag_id
        assert ranking['matches'][0]['method'] == 'direct'
        assert ranking['no_signal_reason'] is None
        # A second read reflects current state rather than a saved search replay.
        store.vocabulary.tags[tag_id]['status'] = 'retired'
        second = await client.post('/v1/knowledge/item-views', json=payload)
        assert second.status_code == 200, second.text
        assert second.json()['tag_ranking']['matches'] == []
        assert second.json()['tag_ranking']['multiplier'] == 1
    assert store.runtime.graphiti.search.await_count == 2


@pytest.mark.asyncio
async def test_item_outside_visible_candidates_has_no_other_item_details():
    store = DetailStore()
    store.tag()
    async with client_for(store) as client:
        response = await client.post('/v1/knowledge/item-views', json=detail_request(
            item_id='outside', query_tags=search_context()))
    assert response.status_code == 200, response.text
    assert response.json()['tag_ranking'] == {
        'original_rank': None, 'final_rank': None, 'original_score': None, 'final_score': None,
        'multiplier': 1, 'matches': [], 'no_signal_reason': 'not_in_visible_candidates'}


@pytest.mark.asyncio
async def test_explanation_never_runs_before_item_authorization_or_for_a_missing_item():
    store = DetailStore()
    async with client_for(store) as client:
        for denied, missing, status in [(True, False, 403), (False, True, 404)]:
            store.denied, store.missing = denied, missing
            response = await client.post('/v1/knowledge/item-views', json=detail_request(query_tags=search_context()))
            assert response.status_code == status, response.text
    store.runtime.graphiti.search.assert_not_awaited()


@pytest.mark.asyncio
async def test_context_uses_search_validation_and_cannot_expand_the_space():
    store = DetailStore()
    async with client_for(store) as client:
        for invalid in [search_context(space_ids=['foreign']), search_context(space_ids=[SPACE, 'foreign']),
                        search_context(space_ids=[SPACE, SPACE]), search_context(query=''),
                        search_context(project_agent_id='agent-without-project'), search_context(unknown=True), []]:
            response = await client.post('/v1/knowledge/item-views', json=detail_request(query_tags=invalid))
            assert response.status_code == 422, response.text
    store.runtime.graphiti.search.assert_not_awaited()


@pytest.mark.asyncio
async def test_context_project_is_authorized_before_candidate_search():
    store = DetailStore()
    async with client_for(store) as client:
        response = await client.post('/v1/knowledge/item-views', json=detail_request(query_tags=search_context(
            personal_project_ids=['foreign-project'], active_personal_project_id='foreign-project')))
    assert response.status_code == 404, response.text
    assert response.json() == {'detail': 'personal project not found'}
    store.runtime.graphiti.search.assert_not_awaited()
