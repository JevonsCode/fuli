"""Actual Provider + Node host lease expiry with synthetic, zero-egress data."""
import asyncio
import json
import os
from datetime import timedelta
from pathlib import Path
import shutil
import socket
from uuid import uuid4

import pytest
import uvicorn

from fuli_graph.models import StructuredEpisode
from fuli_graph.provider_values import now_utc
from test_knowledge_hard_delete_neo4j import reviewed
from test_models import confirmed_episode
from test_negative_feedback_block_neo4j import query
from test_project_agent_memory_neo4j import provider_client
from test_turn_receipt_neo4j import ok, space_with_projects


async def new_draft(client, space_id):
    episode = StructuredEpisode.model_validate(confirmed_episode(idempotency_key=str(uuid4()))).model_dump(mode='json')
    return ok(await client.post('/v1/publication-drafts', json={'personal_space_id': space_id,
        'target_project_id': 'synthetic-public', 'provider_url': 'https://public.example', 'episode': episode}))


@pytest.mark.asyncio
async def test_host_paused_after_begin_releases_expired_reservation_without_delivery(monkeypatch):
    async with provider_client(reviewed()) as (client, access_token):
        space_id = await space_with_projects(client)
        draft = await new_draft(client, space_id)
        # Model a host pause after admission without sleeping for two minutes.
        # Only the admission clock is old; release uses the actual Provider clock.
        calls = 0
        def admission_clock():
            nonlocal calls
            calls += 1
            return now_utc() - timedelta(seconds=121) if calls == 1 else now_utc()
        monkeypatch.setattr('fuli_graph.store_publication.now_utc', admission_clock)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started
            fixture = {'providerUrl': f'http://127.0.0.1:{listener.getsockname()[1]}',
                       'accessToken': access_token, 'spaceId': space_id, 'draftId': draft['id']}
            process = await asyncio.create_subprocess_exec(shutil.which('node'), 'acceptance/public-submission-no-delivery-live.js',
                cwd=Path(__file__).resolve().parents[2], env={**os.environ, 'FULI_SUBMISSION_FIXTURE': json.dumps(fixture)},
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
            except BaseException:
                process.kill()
                await process.wait()
                raise
            assert process.returncode == 0, stderr.decode()
            assert json.loads(stdout) == {'pending': True, 'zeroRemoteCalls': True}
            assert calls == 2
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 10)
            listener.close()


@pytest.mark.asyncio
async def test_no_delivery_release_is_limited_to_same_attempt_without_remote_uncertainty():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client)
        for scenario in ('ttl', 'remote_error', 'late_remote_error', 'source_deleted', 'submitted', 'wrong_attempt'):
            draft = await new_draft(client, space_id)
            endpoint = f'/v1/publication-drafts/{draft["id"]}/decision'
            async def decide(body):
                return await client.post(endpoint, params={'personal_space_id': space_id}, json=body)
            begun = ok(await decide({'decision': 'begin_submit_public'}))
            attempt = begun['submission_id']
            if scenario == 'remote_error':
                unknown = ok(await decide({'decision': 'mark_submission_unknown', 'submission_id': attempt}))
                assert unknown['submission_unknown_reason'] == 'remote_error'
            elif scenario == 'submitted':
                ok(await decide({'decision': 'submit_public', 'submission_id': attempt, 'shared_proposal_id': 'synthetic-proposal'}))
            elif scenario == 'source_deleted':
                await query(settings, "MATCH (d:FuliPublicationDraft {id:$id}) SET d.status='source_deleted', d.payload=null", id=draft['id'])
            await query(settings, 'MATCH (d:FuliPublicationDraft {id:$id}) SET d.submission_started_at=$at',
                        id=draft['id'], at=now_utc() - timedelta(seconds=121))
            if scenario == 'late_remote_error':
                unknown = ok(await decide({'decision': 'mark_submission_unknown', 'submission_id': attempt}))
                assert unknown['submission_unknown_reason'] == 'remote_error'
            released = await decide({'decision': 'release_submit_public',
                'submission_id': 'wrong' if scenario == 'wrong_attempt' else attempt, 'delivery_not_started': True})
            assert released.status_code == (200 if scenario == 'ttl' else 409), (scenario, released.text)
            if scenario == 'ttl':
                assert released.json()['status'] == 'pending'
            else:
                raw = (await query(settings, 'MATCH (d:FuliPublicationDraft {id:$id}) RETURN properties(d) AS draft', id=draft['id']))[0]['draft']
                assert raw['status'] != 'pending'
                if scenario in ('remote_error', 'late_remote_error', 'wrong_attempt'):
                    assert raw['submission_unknown_reason'] == ('ttl' if scenario == 'wrong_attempt' else 'remote_error')
