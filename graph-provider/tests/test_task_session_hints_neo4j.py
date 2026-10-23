"""rec#10 D-26.4 against an explicitly disposable Neo4j: a task-entry hint is
claimed once per host session, never per task token, and concurrent claims
cannot both win. Synthetic data only; public HTTP routes drive every write."""

import asyncio
from uuid import uuid4

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import ok, space_with_projects


async def begin(client, space_id, token, session, turn):
    return ok(await client.put('/v1/task-contexts', json={
        'personal_space_id': space_id, 'personal_project_id': None, 'session_id': session,
        'source_application': 'codex', 'token': token, 'turn_id': turn}))


async def claim(client, space_id, token, operation='project_candidate'):
    return await client.post(f'/v1/task-contexts/{token}/session-hints/claim', json={
        'personal_space_id': space_id, 'source_application': 'codex', 'operation': operation})


async def claimed(client, space_id, token):
    return ok(await claim(client, space_id, token))['claimed']


@pytest.mark.asyncio
async def test_a_session_hint_is_claimed_once_by_the_session_not_the_token():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        first, second, other = (f'fuli-task-{uuid4()}' for _ in range(3))
        await begin(client, space_id, first, 'hint-session-a', 'turn-1')
        assert await claimed(client, space_id, first) is True
        assert await claimed(client, space_id, first) is False

        # Only the operation and the time are kept, in the claiming task's record.
        record = ok(await client.get(f'/v1/task-contexts/{first}', params={
            'personal_space_id': space_id, 'source_application': 'codex'}))
        assert [sorted(hint) for hint in record['session_hints']] == [['at', 'operation']]
        assert record['session_hints'][0]['operation'] == 'project_candidate'

        # A completed checkpoint rewrites the record and keeps the claim.
        ok(await client.put(f'/v1/task-contexts/{first}/checkpoint', json={
            'personal_space_id': space_id, 'source_application': 'codex', 'phase': 'complete',
            'disposition': 'retain_nothing', 'reason': 'Synthetic routine finish.', 'fingerprint': 'b' * 64}))
        await begin(client, space_id, second, 'hint-session-a', 'turn-2')
        assert await claimed(client, space_id, second) is False

        await begin(client, space_id, other, 'hint-session-b', 'turn-1')
        assert await claimed(client, space_id, other) is True


@pytest.mark.asyncio
async def test_a_superseded_entry_cannot_claim_and_concurrent_claims_have_one_winner():
    async with provider_client(fixture_settings()) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        older, newer, raced = (f'fuli-task-{uuid4()}' for _ in range(3))
        await begin(client, space_id, older, 'hint-session-c', 'turn-1')
        await begin(client, space_id, newer, 'hint-session-c', 'turn-2')
        assert (await claim(client, space_id, older)).status_code == 404
        assert await claimed(client, space_id, newer) is True

        await begin(client, space_id, raced, 'hint-session-d', 'turn-1')
        results = await asyncio.gather(*(claimed(client, space_id, raced) for _ in range(6)))
        assert sorted(results) == [False] * 5 + [True]

        # Only a known hint operation can be claimed.
        assert (await claim(client, space_id, raced, 'bind_project')).status_code == 422
