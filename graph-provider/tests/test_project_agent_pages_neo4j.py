"""Roster pages: same Agents and order as the full list, no skips or repeats."""

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


@pytest.mark.asyncio
async def test_pages_walk_the_full_roster_in_one_global_order():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        space = await client.post('/v1/spaces', json={'name': 'Synthetic roster pages', 'kind': 'personal'})
        assert space.status_code == 200, space.text
        space_id = space.json()['id']
        for agent in ['delta', 'alpha', 'charlie', 'echo', 'bravo']:
            await seed_agent(client, space_id, agent=agent)
        full = await client.get('/v1/project-agents', params={'personal_space_id': space_id})
        assert full.status_code == 200, full.text
        expected = [item['agent_id'] for item in full.json()]
        assert len(expected) >= 5

        seen, cursor, pages = [], None, 0
        while True:
            params = {'personal_space_id': space_id, 'limit': 2, **({'cursor': cursor} if cursor else {})}
            page = await client.get('/v1/project-agent-pages', params=params)
            assert page.status_code == 200, page.text
            body = page.json()
            pages += 1
            seen += [item['agent_id'] for item in body['items']]
            assert body['complete'] is (body['next_cursor'] is None)
            if body['complete']:
                break
            cursor = body['next_cursor']
        assert seen == expected
        # The extra-row probe means no empty trailing page.
        assert pages == -(-len(expected) // 2)

        invalid = await client.get('/v1/project-agent-pages', params={'personal_space_id': space_id, 'cursor': 'not-a-cursor'})
        assert invalid.status_code == 422

        # No open work yet: the "open work first" page is empty and complete.
        open_page = await client.get('/v1/project-agent-pages', params={'personal_space_id': space_id, 'work': 'open'})
        assert open_page.status_code == 200, open_page.text
        assert open_page.json() == {'items': [], 'next_cursor': None, 'complete': True}

        created = await client.post('/v1/project-agent-tasks', json={
            'personal_space_id': space_id, 'personal_project_id': 'sample-project',
            'idempotency_key': 'synthetic-roster-page-task', 'title': 'Synthetic open work',
            'objective': 'Give one Agent open work.', 'work_kind': 'implementation',
            'lead_agent_id': 'charlie', 'source_application': 'codex',
            'routing_reason': 'Use the synthetic Agent.',
        })
        assert created.status_code == 200, created.text
        open_page = await client.get('/v1/project-agent-pages', params={'personal_space_id': space_id, 'work': 'open'})
        assert [item['agent_id'] for item in open_page.json()['items']] == ['charlie']
        assert open_page.json()['complete'] is True
