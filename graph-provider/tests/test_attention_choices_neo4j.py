"""Explicit choices survive real scoped storage; no human reply is fabricated."""
import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent


@pytest.mark.asyncio
async def test_attention_choices_round_trip_and_keep_cancellation_separate_from_a_human():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        response = await client.post('/v1/spaces', json={'name':'Synthetic native choices','kind':'personal'})
        assert response.status_code == 200, response.text
        space = response.json()['id']
        await seed_agent(client, space)
        payload = {'personal_space_id':space, 'personal_project_id':'sample-project', 'agent_id':'engineer',
                   'idempotency_key':'synthetic-native-choices', 'kind':'question', 'title':'Choose a target',
                   'detail':'Both synthetic targets are accessible.', 'requested_action':'Which target should this task use?',
                   'options':['Target A','Target B']}
        created = await client.post('/v1/agent-attention', json=payload)
        assert created.status_code == 200, created.text
        record = created.json()
        assert record['options'] == payload['options']
        assert record['responded_by'] is None
        retry = await client.post('/v1/agent-attention', json=payload)
        assert retry.status_code == 200 and retry.json()['request_id'] == record['request_id']
        invalid = await client.post('/v1/agent-attention', json={**payload,'options':['A','A']})
        assert invalid.status_code == 422
        listed = await client.get('/v1/agent-attention', params={'personal_space_id':space,
                                  'personal_project_id':'sample-project','agent_id':'engineer'})
        assert listed.status_code == 200
        assert listed.json()['items'][0]['options'] == payload['options']
        cancelled = await client.post('/v1/agent-attention/cancel', json={'personal_space_id':space,
            'personal_project_id':'sample-project', 'request_id':record['request_id'],
            'expected_revision':0, 'response':'Synthetic request obsolete'})
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()['status'] == 'cancelled'
        assert cancelled.json()['responded_by'] == 'agent'
