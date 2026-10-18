"""Catalog/recruitment races against the disposable acceptance graph only."""

import asyncio
import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_recruitment_guards_neo4j import recruitment_setup, recruitments


async def custom_occupation(client, scope):
    response = await client.post('/v1/occupations', json={
        'personal_space_id': scope['personal_space_id'], 'name_en': 'Catalog verifier',
        'description_en': 'Verify the sample catalog and preserve its history.'})
    assert response.status_code == 200, response.text
    return response.json()['key']


@pytest.mark.asyncio
@pytest.mark.parametrize('occupation', [
    {'role': 'not_in_catalog'}, {'role': 'engineering', 'tags': ['not_in_catalog']},
])
async def test_pending_recruitment_rejects_non_catalog_keys_without_writes(occupation):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=True)
        rejected = await client.post('/v1/project-agent-tasks', json={
            **payload, 'recruitment_occupation': occupation})
        assert rejected.status_code == 422, rejected.text
        assert rejected.json()['detail']['code'] == 'occupation_inactive'
        assert await recruitments(client, scope) == []
        assert (await client.get('/v1/project-agent-tasks', params=scope)).json() == []


@pytest.mark.asyncio
@pytest.mark.parametrize('repair', ['approve', 'cancel'])
async def test_inactive_approval_keeps_pending_decision_recoverable(repair):
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=True)
        key = await custom_occupation(client, scope)
        submitted = await client.post('/v1/project-agent-tasks', json={
            **payload, 'recruitment_occupation': {'role': key}})
        assert submitted.status_code == 200, submitted.text
        pending = submitted.json()['recruitment']
        archive = await client.post(f'/v1/occupations/{key}/archive', json={
            'personal_space_id': scope['personal_space_id'], 'revision': 0})
        assert archive.status_code == 200, archive.text
        decision = {**scope, 'recruitment_id': pending['recruitment_id'],
            'expected_revision': pending['revision'], 'decision': 'approve',
            'reason': 'Synthetic catalog approval.'}
        url = f"/v1/project-agent-recruitments/{pending['recruitment_id']}/decision"
        rejected = await client.post(url, json=decision)
        assert rejected.status_code == 422, rejected.text
        assert rejected.json()['detail']['code'] == 'occupation_inactive'
        assert (await recruitments(client, scope))[0] == pending
        retry = await client.post(url, json={**decision, 'decision': repair,
            **({'occupation': {'role': 'engineering'}} if repair == 'approve' else {})})
        assert retry.status_code == 200, retry.text
        assert retry.json()['status'] == ('fulfilled' if repair == 'approve' else 'cancelled')


@pytest.mark.asyncio
async def test_archive_and_approval_cannot_commit_an_unrecoverable_decision():
    async with provider_client(fixture_settings(), raise_app_exceptions=False) as (client, _):
        scope, payload = await recruitment_setup(client, confirmation=True)
        key = await custom_occupation(client, scope)
        submitted = await client.post('/v1/project-agent-tasks', json={
            **payload, 'recruitment_occupation': {'role': key}})
        assert submitted.status_code == 200, submitted.text
        pending = submitted.json()['recruitment']
        approved, archived = await asyncio.gather(
            client.post(f"/v1/project-agent-recruitments/{pending['recruitment_id']}/decision",
                json={**scope, 'recruitment_id': pending['recruitment_id'],
                    'decision': 'approve', 'expected_revision': pending['revision'],
                    'reason': 'Synthetic concurrent catalog approval.'}),
            client.post(f'/v1/occupations/{key}/archive', json={
                'personal_space_id': scope['personal_space_id'], 'revision': 0}))
        assert archived.status_code == 200, archived.text
        assert approved.status_code in {200, 422}, approved.text
        current = (await recruitments(client, scope))[0]
        assert current['status'] == ('fulfilled' if approved.status_code == 200 else 'awaiting_confirmation')
        if approved.status_code == 422:
            assert current == pending
