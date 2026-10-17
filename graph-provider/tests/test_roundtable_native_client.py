"""Opt-in native client acceptance; only disposable synthetic graph data."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket

import pytest

from test_cross_project_roundtable_neo4j import cross_project
from test_agent_delegations_neo4j import setup_delegation
from test_project_agent_memory_neo4j import fixture_settings, provider_client


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv('FULI_TEST_NATIVE_ROUNDTABLE') != '1', reason='explicit native model opt-in required')
@pytest.mark.parametrize('missing_lead', [False, True], ids=['existing-lead', 'bole-staffed-lead'])
async def test_native_codex_returns_target_memory_to_the_unchanged_source_lead(tmp_path, missing_lead):
    import uvicorn
    assert shutil.which('codex'), 'The authorized Codex CLI must be available'
    model = os.environ['FULI_TEST_NATIVE_MODEL']
    async with provider_client(fixture_settings()) as (client, access_token):
        if missing_lead:
            source, request = await setup_delegation(client)
            target = {**source, 'personal_project_id': 'target-project'}
            project = await client.put('/v1/personal-projects', json={
                'personal_space_id': source['personal_space_id'], 'project_id': target['personal_project_id'],
                'profile': {'name': 'Synthetic target project', 'lifecycle': 'active',
                    'purpose': 'SYNTHETIC_TARGET_CODE=JADE-84. Verify the Bole staffing-to-native execution path.'}})
            assert project.status_code == 200, project.text
            policy = await client.get('/v1/project-agent-coordination-policy', params=target)
            assert policy.status_code == 200 and not policy.json().get('team_lead_agent_id'), policy.text
        else:
            source, target, request = await cross_project(client)
            saved = await client.put('/v1/project-agents/target-lead/memory', json={**target,
                'agent_id': 'target-lead', 'source_application': 'codex', 'expected_revision': 0,
                'idempotency_key': 'roundtable-native-memory', 'memory': {'summary': 'SYNTHETIC_TARGET_CODE=JADE-84'}})
            assert saved.status_code == 200, saved.text
        source_path = '/v1/task-contexts/' + request['task_context_token']
        params = {'personal_space_id': source['personal_space_id'], 'source_application': 'codex'}
        before = (await client.get(source_path, params=params)).json()
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        target_folder = tmp_path / 'target-project'
        target_folder.mkdir()
        config_path = tmp_path / 'graph-runtime.json'
        config_path.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
            'providerUrl': f'http://127.0.0.1:{port}', 'accessToken': access_token,
            'principalId': 'synthetic-native-roundtable', 'spaceId': source['personal_space_id']}}), encoding='utf-8')
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started
            fixture = {'configPath': str(config_path), 'targetFolder': str(target_folder), 'model': model,
                       'parentToken': request['task_context_token'], 'missingLead': missing_lead,
                       'eventsPath': str(tmp_path / 'native-events.jsonl')}
            script = r'''
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {FederatedGraphApplication} from './src/graphiti/federated-application.js';
import {createAgentRoundtable} from './src/agent-roundtable/service.js';
import {createRoundtableStore} from './src/agent-roundtable/store.js';
import {wakeAgent,runProcess} from './src/agent-roundtable/wake.js';
import {findFile} from './src/agents/session-log.js';
const f=JSON.parse(process.env.FULI_NATIVE_ROUNDTABLE_FIXTURE);
const config=JSON.parse(readFileSync(f.configPath,'utf8'));
const app=new FederatedGraphApplication(config,{projectPathResolver:path=>({status:'matched',
  personalProjectId:path===f.targetFolder?'target-project':'sample-project'})});
const store=createRoundtableStore();
let actualSession,requestedModel=f.model,usage=null,nativeModel=null,nativeEffort=null;
const calls=[];
const roundtable=createAgentRoundtable({app,openStore:()=>store,clientAvailable:c=>c==='codex',
  wake:input=>wakeAgent({...input,run:async(command,args,options)=>{
    const mcpArgs=[resolve('src/cli.js'),'mcp','--runtime-config',f.configPath,'--source-application','codex'];
    // Isolate this test's MCP configuration while reusing the CLI's normal auth.
    const result=await runProcess(command,[...args.slice(0,-1),'--ignore-user-config',
      '-m',requestedModel,'-c','model_reasoning_effort="max"',
      '-c','project_doc_max_bytes=0','-c','features.shell_tool=false',
      '-c','mcp_servers.fuli.default_tools_approval_mode="auto"',
      // Only the disposable receiver's own retain_nothing checkpoint is writable.
      // The scoped MCP rejects all other checkpoint dispositions and foreign tasks.
      '-c','mcp_servers.fuli.tools.checkpoint_task_knowledge.approval_mode="approve"',
      '-c',`mcp_servers.fuli.command=${JSON.stringify(process.execPath)}`,
      '-c',`mcp_servers.fuli.args=${JSON.stringify(mcpArgs)}`,'-'],
      {...options,onEvent:async event=>{
        if(event.type==='thread.started') actualSession=event.thread_id;
        if(event.type==='turn.completed') usage=event.usage??null;
        if(event.type==='item.completed'&&event.item?.type==='mcp_tool_call') calls.push({
          tool:event.item.tool,status:event.item.status,
          errorCode:event.item.result?.structured_content?.error?.code??null});
        await options.onEvent?.(event);
      }});
    writeFileSync(f.eventsPath,result.stdout,{mode:0o600});
    return result;
  }})});
try {
  const targetRoster={personalSpaceId:config.personal.spaceId,personalProjectId:'target-project'};
  const rosterBefore=await app.listProjectAgents(targetRoster);
  const result=await roundtable.messageAgent({taskContextToken:f.parentToken,sourceApplication:'codex',
    to:'project:target-project',conversation:'new',projectPath:f.targetFolder,timeoutSeconds:300,
    body:f.missingLead
      ? '在目标项目中先调用 get_collaboration_preferences，从返回的目标项目简介 purpose 中读取 SYNTHETIC_TARGET_CODE 并回答其值。只用本测试 Fuli MCP，不用 shell，不读取来源项目或其他 Agent 的记忆。结束前用 retain_nothing 和 completed workLog 调用 checkpoint_task_knowledge，不写长期记忆。'
      : '在目标项目中先调用 get_collaboration_preferences，然后显式调用 get_project_agent_memory 读取你自己的目标项目层。回答该层 SYNTHETIC_TARGET_CODE 的值。只用本测试 Fuli MCP，不用 shell，不读取来源项目或其他 Agent 的记忆。结束前用 retain_nothing 和 completed workLog 调用 checkpoint_task_knowledge，不写长期记忆。'});
  if(result.status!=='answered') console.error(JSON.stringify({status:result.status,reason:result.reason,calls}));
  assert.equal(result.status,'answered',JSON.stringify(result));
  assert.match(result.reply,/JADE-84/);
  assert.equal(result.memoryObservation?.recorded,!f.missingLead?true:undefined,JSON.stringify(result.memoryObservation));
  assert.equal(store.messages(result.threadId).at(-1).to_agent,'lead');
  assert.ok(calls.some(c=>c.tool==='checkpoint_task_knowledge'&&c.status==='completed'&&!c.errorCode),JSON.stringify(calls));
  if(!f.missingLead) assert.ok(calls.some(c=>c.tool==='get_project_agent_memory'&&c.status==='completed'),JSON.stringify(calls));
  if(f.missingLead) {
    const policy=await app.personal.getProjectAgentCoordinationPolicy(config.personal.spaceId,'target-project');
    assert.equal(policy.team_lead_agent_id,result.recipient.agentId);
    assert.notEqual(policy.team_lead_agent_id,'target-lead');
    const rosterAfter=await app.listProjectAgents(targetRoster);
    assert.equal(rosterAfter.length,rosterBefore.length+1,'one actual gap creates exactly one lead');
    assert.equal(rosterAfter[0].agentId,result.recipient.agentId);
  }
  const ownFile=findFile(resolve(homedir(),'.codex/sessions'),`${actualSession}.jsonl`,4);
  if(ownFile) for(const line of readFileSync(ownFile,'utf8').split('\n')) {
    let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.type==='turn_context') {nativeModel=value.payload?.model??nativeModel;nativeEffort=value.payload?.effort??nativeEffort;}
  }
  assert.equal(nativeModel,requestedModel,'verify the model from this native session record');
  assert.equal(nativeEffort,'max');
  console.log(JSON.stringify({native:true,client:'codex',requestedModel,nativeModel,nativeEffort,actualSession,usage,
    calls,returnedToOriginalLead:true,memoryRecorded:!f.missingLead,boleStaffed:f.missingLead}));
} finally {store.close();await app.close();}
'''
            process = await asyncio.create_subprocess_exec(shutil.which('node'), '--input-type=module', '-e', script,
                cwd=Path(__file__).resolve().parents[2], stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env={**os.environ, 'FULI_NATIVE_ROUNDTABLE_FIXTURE': json.dumps(fixture)})
            stdout, stderr = await asyncio.wait_for(process.communicate(), 340)
            assert process.returncode == 0, (stdout.decode(), stderr.decode()[-3000:])
            evidence = json.loads(stdout.decode())
            assert evidence['native'] is True
            assert evidence['actualSession']
            if missing_lead:
                hires = await client.get('/v1/project-agent-recruitments', params=target)
                assert hires.status_code == 200, hires.text
                assert len(hires.json()) == 1, hires.text
                assert hires.json()[0]['status'] == 'fulfilled', hires.text
                assert hires.json()[0]['hr_agent_id'], hires.text
                evidence['recruitmentAudit'] = {'count': 1, 'status': 'fulfilled', 'hrPresent': True}
            (tmp_path / 'native-evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
            assert (await client.get(source_path, params=params)).json() == before
        finally:
            server.should_exit = True
            await serving
