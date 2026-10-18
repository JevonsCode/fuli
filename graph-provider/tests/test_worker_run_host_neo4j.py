"""Actual Provider/Neo4j host plumbing; the worker adapter/model are synthetic."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import socket

import pytest
import uvicorn

from test_agent_delegations_neo4j import worker_run_fixture
from test_project_agent_memory_neo4j import fixture_settings, provider_client


@pytest.mark.asyncio
@pytest.mark.parametrize('retry_plan', [False, True])
async def test_host_attempt_persists_own_checkpoint_terminal_activity_and_close(tmp_path, retry_plan):
    async with provider_client(fixture_settings()) as (client, access_token):
        scope, payload, headers = await worker_run_fixture(client)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        provider_url = f'http://127.0.0.1:{listener.getsockname()[1]}'
        config_path = tmp_path / 'graph-runtime.json'
        config_path.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
            'providerUrl': provider_url, 'accessToken': access_token,
            'principalId': 'synthetic-worker-host', 'spaceId': scope['personal_space_id']}}), encoding='utf-8')
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started
            fixture = {'providerUrl': provider_url, 'configPath': str(config_path), 'retryPlan': retry_plan,
                'accessToken': access_token, 'scope': scope, 'projectPath': str(tmp_path),
                'capability': headers['x-fuli-worker-capability'],
                'request': {key: value for key, value in payload.items() if key != 'runtime_capability_hash'}}
            process = await asyncio.create_subprocess_exec(shutil.which('node'), 'acceptance/worker-run-host-live.js',
                cwd=Path(__file__).resolve().parents[2],
                env={**os.environ, 'FULI_WORKER_HOST_FIXTURE': json.dumps(fixture)},
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 120)
            except BaseException:
                process.kill()
                await process.wait()
                raise
            assert fixture['capability'] not in stderr.decode()
            assert process.returncode == 0, stderr.decode()
            assert all(json.loads(stdout.decode()).values())
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 10)
            listener.close()
