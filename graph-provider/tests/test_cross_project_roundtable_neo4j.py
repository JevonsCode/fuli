"""Cross-project answers restore only the receiving lead's granted project."""

import pytest

from test_agent_delegations_neo4j import setup_delegation
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _query


async def cross_project(client):
    source, request = await setup_delegation(client)
    for agent in ['target-lead', 'target-member']:
        await seed_agent(client, source['personal_space_id'], project='target-project', agent=agent)
    target = {**source, 'personal_project_id': 'target-project'}
    response = await client.put('/v1/project-agent-coordination-policy', json={
        **target, 'team_lead_agent_id': 'target-lead', 'team_member_agent_ids': ['target-member']})
    assert response.status_code == 200, response.text
    return source, target, {**request, 'agent_id': 'target-lead',
                            'target_personal_project_id': 'target-project'}


async def restore(client, scope, token, agent='target-lead'):
    response = await client.post('/v1/project-agent-context/resolve', json={
        **scope, 'source_application': 'codex', 'agent_id': agent,
        'work_kind': 'project_context', 'delegation_token': token,
        'delegation_session_id': 'synthetic-receiver',
    })
    if response.status_code == 404:
        return {'status': 'agent_unavailable'}
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_cross_project_grant_targets_only_its_current_lead_and_keeps_source_owner():
    async with provider_client(fixture_settings()) as (client, _):
        source, target, request = await cross_project(client)
        path = '/v1/task-contexts/' + request['task_context_token']
        params = {'personal_space_id': source['personal_space_id'], 'source_application': 'codex'}
        before = (await client.get(path, params=params)).json()
        issued = await client.post('/v1/project-agent-context/delegations', json=request)
        assert issued.status_code == 200, issued.text
        token = issued.json()['token']
        capability = {'personal_space_id': source['personal_space_id'], 'token': token}
        unsealed = await client.post('/v1/project-agent-context/delegations/admit', json=capability)
        assert unsealed.status_code == 409, unsealed.text
        sealed = await client.post('/v1/project-agent-context/delegations/seal', json={
            **capability, 'session_id': 'synthetic-receiver'})
        assert sealed.status_code == 200, sealed.text
        admitted = await client.post('/v1/project-agent-context/delegations/admit', json=capability)
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()['personal_project_id'] == 'target-project'
        assert admitted.json()['project_agent_id'] == 'target-lead'
        assert admitted.json()['session_id'] == 'synthetic-receiver'
        assert 'sender_token' not in admitted.json()
        changed_session = await client.post('/v1/project-agent-context/delegations/seal', json={
            **capability, 'session_id': 'another-receiver'})
        assert changed_session.status_code == 409
        wrong_receipt = await client.post('/v1/project-agent-context/delegations/memory-result', json={
            **capability, 'session_id': 'another-receiver', 'result_count': 2})
        assert wrong_receipt.status_code == 403, wrong_receipt.text
        receipt = await client.post('/v1/project-agent-context/delegations/memory-result', json={
            **capability, 'session_id': 'synthetic-receiver', 'result_count': 2})
        assert receipt.status_code == 200, receipt.text
        verified = await client.post('/v1/project-agent-context/delegations/verify', json={
            **capability, 'session_id': 'synthetic-receiver'})
        assert verified.json() == {'redeemed': True, 'memory_result_count': 2}
        wrong_project = await restore(client, source, token)
        assert wrong_project['status'] == 'agent_unavailable'
        restored = await restore(client, target, token)
        assert restored['status'] == 'ready'
        assert restored['agent']['agent_id'] == 'target-lead'
        assert (await client.get(path, params=params)).json() == before
        assert before['project_agent_id'] == 'lead'
        assert before['personal_project_id'] == 'sample-project'
        await client.post('/v1/project-agent-context/delegations/revoke', json={
            'personal_space_id': source['personal_space_id'], 'token': token})
        assert (await restore(client, target, token))['status'] == 'agent_unavailable'


@pytest.mark.asyncio
async def test_cross_project_member_bypass_is_rejected_and_source_handoff_revokes_authority():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        source, target, request = await cross_project(client)
        rejected = await client.post('/v1/project-agent-context/delegations',
            json={**request, 'agent_id': 'target-member'})
        assert rejected.status_code == 403, rejected.text
        issued = await client.post('/v1/project-agent-context/delegations', json=request)
        assert issued.status_code == 200, issued.text
        capability = {'personal_space_id': source['personal_space_id'], 'token': issued.json()['token'],
                      'session_id': 'synthetic-receiver'}
        assert (await client.post('/v1/project-agent-context/delegations/seal', json=capability)).status_code == 200
        assert (await client.post('/v1/project-agent-context/delegations/admit', json=capability)).status_code == 200
        await _query(settings, '''
            MATCH (:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: 'sample-project'})-
                  [:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
            SET policy.team_lead_agent_id = 'other'
            ''', space=source['personal_space_id'])
        assert (await restore(client, target, issued.json()['token']))['status'] == 'agent_unavailable'
        assert (await client.post('/v1/project-agent-context/delegations/verify', json=capability)).json() == {'redeemed': False}


@pytest.mark.asyncio
async def test_cross_project_requires_the_source_lead_without_replacing_it():
    async with provider_client(fixture_settings()) as (client, _):
        source, _, request = await cross_project(client)
        token = request['task_context_token'] + '-member'
        response = await client.put('/v1/task-contexts', json={
            **source, 'token': token, 'project_agent_id': 'member', 'source_application': 'codex',
            'session_id': 'synthetic-member-session', 'turn_id': 'synthetic-member-turn'})
        assert response.status_code == 200, response.text
        rejected = await client.post('/v1/project-agent-context/delegations', json={
            **request, 'task_context_token': token})
        assert rejected.status_code == 403, rejected.text


@pytest.mark.asyncio
async def test_roundtable_mcp_stdio_binds_own_task_and_denies_foreign_memory(tmp_path):
    """Actual MCP stdio, HTTP and Neo4j; no model or daily installation."""
    import asyncio
    import json
    import os
    from pathlib import Path
    import shutil
    import socket
    import uvicorn

    async with provider_client(fixture_settings()) as (client, access_token):
        source, target, request = await cross_project(client)
        issued = await client.post('/v1/project-agent-context/delegations', json=request)
        assert issued.status_code == 200, issued.text
        capability = {'personal_space_id': source['personal_space_id'], 'token': issued.json()['token'],
                      'session_id': 'synthetic-sealed-roundtable'}
        assert (await client.post('/v1/project-agent-context/delegations/seal', json=capability)).status_code == 200
        saved = await client.put('/v1/project-agents/target-lead/memory', json={**target,
            'agent_id': 'target-lead', 'source_application': 'codex', 'expected_revision': 0,
            'idempotency_key': 'roundtable-stdio-memory', 'memory': {'summary': 'SYNTHETIC_TARGET_CODE=JADE-84'}})
        assert saved.status_code == 200, saved.text
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        config_path = tmp_path / 'graph-runtime.json'
        base_url = f'http://127.0.0.1:{port}'
        config_path.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
            'providerUrl': base_url, 'accessToken': access_token,
            'principalId': 'synthetic-roundtable-host', 'spaceId': source['personal_space_id']}}), encoding='utf-8')
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started
            fixture = {'configPath': str(config_path), 'baseUrl': base_url, 'accessToken': access_token,
                       'capability': capability, 'parentToken': request['task_context_token']}
            script = r'''
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const f=JSON.parse(process.env.FULI_ROUNDTABLE_FIXTURE);
const client=new Client({name:'synthetic-roundtable',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,
  args:[resolve('src/cli.js'),'mcp','--runtime-config',f.configPath,'--source-application','codex'],
  cwd:process.cwd(),stderr:'pipe',env:{...process.env,FULI_ROUNDTABLE_DELEGATION:f.capability.token,
    CODEX_THREAD_ID:'forged-source-thread'}});
let stderr=''; transport.stderr?.on('data',c=>{stderr+=c;});
const call=(name,args={})=>client.callTool({name,arguments:args});
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools.map(t=>t.name);
  assert.equal(tools.includes('capture_session_knowledge'),false);
  assert.equal(tools.includes('checkpoint_project_agent_memory'),false);
  assert.equal((await call('search_knowledge_graph',{personalSpaceId:f.capability.personal_space_id,query:'before entry'})).isError,true);
  const entry=await call('get_collaboration_preferences',{projectPath:'/forged-source',taskPrompt:'Synthetic bounded code lookup'});
  assert.notEqual(entry.isError,true,JSON.stringify(entry));
  const data=entry.structuredContent;
  assert.equal(data.context.project_agent_id,'target-lead');
  assert.equal(data.context.personal_project_id,'target-project');
  assert.notEqual(data.taskContextToken,f.parentToken);
  const own={personalSpaceId:f.capability.personal_space_id,personalProjectId:'target-project',agentId:'target-lead'};
  const memory=await call('get_project_agent_memory',own);
  assert.notEqual(memory.isError,true,JSON.stringify(memory));
  assert.equal(memory.structuredContent.current.memory.summary,'SYNTHETIC_TARGET_CODE=JADE-84');
  for(const args of [{...own,personalProjectId:'sample-project'},{...own,agentId:'lead'}]) {
    assert.equal((await call('get_project_agent_memory',args)).isError,true);
  }
  const get=path=>fetch(f.baseUrl+path,{method:'POST',headers:{authorization:`Bearer ${f.accessToken}`,
    'content-type':'application/json'},body:JSON.stringify(f.capability)});
  const verified=await get('/v1/project-agent-context/delegations/verify');
  assert.equal((await verified.json()).memory_result_count,1);
  await get('/v1/project-agent-context/delegations/revoke');
  assert.equal((await call('get_project_agent_memory',own)).isError,true);
  assert.equal(stderr.includes(f.capability.token),false);
  console.log(JSON.stringify({stdio:true,ownTask:true,foreignDenied:true,revokedDenied:true,memoryReceipt:true}));
} finally {await client.close();}
'''
            process = await asyncio.create_subprocess_exec(shutil.which('node'), '--input-type=module', '-e', script,
                cwd=Path(__file__).resolve().parents[2], stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env={**os.environ, 'FULI_ROUNDTABLE_FIXTURE': json.dumps(fixture)})
            stdout, stderr = await asyncio.wait_for(process.communicate(), 60)
            assert process.returncode == 0, (stdout.decode(), stderr.decode())
            assert json.loads(stdout.decode())['memoryReceipt'] is True
        finally:
            server.should_exit = True
            await serving
