"""Opt-in native Codex acceptance against disposable, synthetic preferences."""
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import socket

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv('FULI_TEST_NATIVE_PREFERENCES') != '1', reason='explicit native model opt-in required')
async def test_native_full_delta_changes_removals_and_resume_full(tmp_path):
    import uvicorn
    from neo4j import AsyncGraphDatabase
    settings = fixture_settings()
    model = os.environ['FULI_TEST_NATIVE_MODEL']
    binary = os.getenv('FULI_CODEX_BIN') or shutil.which('codex')
    assert binary and shutil.which('node')
    root = Path(__file__).resolve().parents[2]
    marker = tmp_path / 'source-updated'
    async with provider_client(settings) as (client, access_token):
        space = await _create_space(client, 'Synthetic native preference delivery')
        await seed_agent(client, space)
        agent = await client.get('/v1/project-agents/engineer', params={
            'personal_space_id': space, 'personal_project_id': 'sample-project'})
        assert agent.status_code == 200, agent.text
        agent_id = agent.json()['agent_id']
        basis = json.dumps({'existence_reason': 'Synthetic native acceptance fixture.',
            'quadrant_reason': 'Synthetic user-confirmed fixture rule.',
            'proposed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
            'confirmed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
            'confirmed_at': '2026-08-03T00:00:00Z'})
        items = [{'id': f'{space}-pref-{i}', 'key': f'native-rule-{i:02}',
            'instruction': f'Synthetic acceptance rule {i}: NATIVE_VALUE=V1. ' + 'Preserve fixture boundaries. ' * 8,
            'attributes': json.dumps({'preferenceKey': f'native-rule-{i:02}'})} for i in range(12)]
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (space:FuliSpace {id:$space}) UNWIND $items AS item
                CREATE (:Entity {uuid:item.id,group_id:space.group_id,name:item.key,summary:item.instruction,
                  created_at:$stamp,fuli_type:'PersonalPreference',fuli_profile_aspect:'judgment_preference',
                  fuli_preference_scope:'global',fuli_confirmation_status:'confirmed',
                  fuli_confirmation_basis_json:$basis,fuli_attributes_json:item.attributes})
                ''', space=space, items=items, basis=basis, stamp=datetime(2026, 8, 3, tzinfo=timezone.utc))
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            runtime = tmp_path / 'graph-runtime.json'
            runtime.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
                'providerUrl': f'http://127.0.0.1:{port}', 'accessToken': access_token,
                'principalId': 'synthetic-native-preferences', 'spaceId': space}}), encoding='utf-8')
            runtime.chmod(0o600)
            mcp = tmp_path / 'native-mcp.mjs'
            mcp.write_text(f'''
import {{openFederatedGraphApplication}} from {json.dumps((root / 'src/graphiti/federated-application.js').as_uri())};
import {{createMcpServer}} from {json.dumps((root / 'src/mcp/create-mcp-server.js').as_uri())};
import {{nativeMcpRequestContextResolver}} from {json.dumps((root / 'src/agents/native-mcp-context.js').as_uri())};
import {{StdioServerTransport}} from {json.dumps((root / 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js').as_uri())};
import {{existsSync,appendFileSync}} from 'node:fs';
import {{setTimeout as delay}} from 'node:timers/promises';
const app=openFederatedGraphApplication({{runtimeConfigPath:{json.dumps(str(runtime))}}});
const original=app.getCollaborationPreferences.bind(app);
let reads=0;
// Test-only source-update barrier. Every response still uses the real Provider,
// task entry, compact view, MCP formatter, native file observer and cache.
app.getCollaborationPreferences=async input=>{{
  if(++reads===2) {{
    for(let i=0;i<700&&!existsSync({json.dumps(str(marker))});i++) await delay(10);
    if(!existsSync({json.dumps(str(marker))})) throw new Error('Source update did not finish');
  }}
  return original(input);
}};
const server=createMcpServer(app,{{sourceApplication:'codex',
  nativeRequestContext:meta=>{{
    appendFileSync({json.dumps(str(tmp_path / 'native-request-metadata.jsonl'))},JSON.stringify({{
      threadId:meta?.threadId,sessionId:meta?.sessionId,windowId:meta?.windowId}})+'\\n',{{mode:0o600}});
    return nativeMcpRequestContextResolver('codex')(meta);
  }},
  toolNames:['get_collaboration_preferences','read_task_preferences','checkpoint_task_knowledge']}});
server.server.onclose=()=>app.close();
await server.connect(new StdioServerTransport());
''', encoding='utf-8')
            server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
            serving = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                for _ in range(100):
                    if server.started:
                        break
                    await asyncio.sleep(0.01)
                assert server.started
                common = ['--ignore-user-config', '--json', '--skip-git-repo-check',
                    '-m', model, '-c', 'model_reasoning_effort="max"',
                    '-c', 'project_doc_max_bytes=0', '-c', 'features.shell_tool=false',
                    '-c', 'mcp_servers.fuli.tools.checkpoint_task_knowledge.approval_mode="approve"',
                    '-c', 'mcp_servers.fuli.command=' + json.dumps(shutil.which('node')),
                    '-c', 'mcp_servers.fuli.args=' + json.dumps([str(mcp)])]
                parameters = {'personalProjectId': 'sample-project', 'projectAgentId': agent_id,
                    'projectPath': str(tmp_path), 'workKind': 'implementation', 'workflow': 'native-acceptance'}
                prompt = ('这是一次隔离合成数据验收。仅使用本测试 Fuli MCP，不使用shell或其他工具。'
                    '按顺序完成两项小任务，每项都调用一次 get_collaboration_preferences，参数除taskPrompt外固定为'
                    + json.dumps(parameters, ensure_ascii=False) + '。taskPrompt分别为 Synthetic native preference phase 1 和 phase 2。'
                    '每次读取后用返回的自身 taskContextToken、retain_nothing、completed workLog 调用 checkpoint_task_knowledge；'
                    '完成第一项checkpoint后再开始第二项，不并行，不写长期记忆。第二项收到增量时应用新增/修改/撤销，'
                    '回答native-rule-00当前NATIVE_VALUE以及native-rule-01是否仍适用。')
                evidence = []

                async def run(arguments, text, filename, change_source=False):
                    process = await asyncio.create_subprocess_exec(binary, *arguments, '-',
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE, start_new_session=True)
                    stderr_task = asyncio.create_task(process.stderr.read())
                    process.stdin.write(text.encode())
                    await process.stdin.drain()
                    process.stdin.close()
                    events = []
                    changed = False
                    async def consume():
                        nonlocal changed
                        while line := await process.stdout.readline():
                            event = json.loads(line)
                            events.append(event)
                            item = event.get('item', {})
                            if (change_source and not changed and event.get('type') == 'item.completed'
                                    and item.get('type') == 'mcp_tool_call' and item.get('tool') == 'get_collaboration_preferences'):
                                result = item.get('result', {}).get('structured_content', {})
                                assert not result.get('error'), result
                                await driver.execute_query('''
                                    MATCH (e:Entity {uuid:$id}) SET e.summary=$instruction
                                    ''', id=items[0]['id'], instruction=items[0]['instruction'].replace('=V1', '=V2'))
                                await driver.execute_query('MATCH (e:Entity {uuid:$id}) DETACH DELETE e', id=items[1]['id'])
                                marker.write_text('synthetic source updated', encoding='utf-8')
                                changed = True
                        await process.wait()
                    try:
                        await asyncio.wait_for(consume(), 330)
                        errors = (await stderr_task).decode()
                        assert process.returncode == 0, errors[-2000:]
                        (tmp_path / filename).write_text('\n'.join(json.dumps(e, ensure_ascii=False) for e in events) + '\n', encoding='utf-8')
                        (tmp_path / filename).chmod(0o600)
                        return events
                    finally:
                        if process.returncode is None:
                            os.killpg(process.pid, signal.SIGTERM)
                            try:
                                await asyncio.wait_for(process.wait(), 3)
                            except TimeoutError:
                                os.killpg(process.pid, signal.SIGKILL)
                                await process.wait()
                        await stderr_task

                first = await run(['exec', '--sandbox', 'read-only', '-C', str(tmp_path), *common],
                    prompt, 'native-first.jsonl', change_source=True)
                session = next(e['thread_id'] for e in first if e.get('type') == 'thread.started')
                def results(events):
                    return [e['item']['result']['structured_content'] for e in events if e.get('type') == 'item.completed'
                        and e.get('item', {}).get('type') == 'mcp_tool_call' and e['item'].get('tool') == 'get_collaboration_preferences']
                values = results(first)
                assert len(values) == 2, values
                assert len(values[0]['effective_preferences']) == 12, values[0]
                delta = values[1]
                assert delta['preference_delivery']['status'] == 'delta', delta
                assert len(delta['preference_updates']) == 1, delta
                assert '=V2' in delta['preference_updates'][0]['instruction']
                assert delta['preference_delivery']['removed'][0]['preference_key'] == 'native-rule-01'
                assert values[0]['taskContextToken'] != values[1]['taskContextToken']
                lead = await client.get('/v1/project-agent-coordination-policy', params={
                    'personal_space_id': space, 'personal_project_id': 'sample-project'})
                assert lead.status_code == 200, lead.text
                owner_id = lead.json()['team_lead_agent_id']
                for value in values:
                    assert value['context']['project_agent_id'] == owner_id
                    assert value['context']['personal_project_id'] == 'sample-project'
                resumed = await run(['exec', 'resume', '-c', 'sandbox_mode="read-only"', *common, session],
                    '继续同一个隔离验收会话。再完成一项任务：用相同固定参数调用一次 get_collaboration_preferences，'
                    'taskPrompt为 Synthetic native preference resume。本次应收到当前全文；然后retain_nothing和completed workLog checkpoint，回答V2和撤销状态。',
                    'native-resume.jsonl')
                restored = results(resumed)
                assert len(restored) == 1 and len(restored[0]['effective_preferences']) == 11, restored
                assert restored[0].get('preference_delivery', {}).get('status') != 'delta', restored
                assert all(p['preference_key'] != 'native-rule-01' for p in restored[0]['effective_preferences'])
                assert '=V2' in next(p['instruction'] for p in restored[0]['effective_preferences'] if p['preference_key'] == 'native-rule-00')
                for label, events in [('initial', first), ('resume', resumed)]:
                    calls = [e['item'] for e in events if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'mcp_tool_call']
                    checkpoints = [c for c in calls if c['tool'] == 'checkpoint_task_knowledge']
                    assert len(checkpoints) == (2 if label == 'initial' else 1), checkpoints
                    assert all(c['status'] == 'completed' and not c.get('result', {}).get('structured_content', {}).get('error') for c in checkpoints)
                    evidence.append({'phase': label, 'nativeSession': session, 'requestedModel': model,
                        'usage': next(e.get('usage') for e in reversed(events) if e.get('type') == 'turn.completed'),
                        'preferenceResults': len(results(events)), 'checkpointCount': len(checkpoints)})
                verification = r'''
import {readFileSync} from 'node:fs';
import {locatePreferenceTranscript} from './src/agents/preference-evidence.js';
import {readPreferenceEvidence} from './src/conversations/preference-evidence.js';
const id=process.argv[1];
const target=await locatePreferenceTranscript('codex',id,{env:process.env});
if(!target) throw new Error('Native session file unavailable');
const proof=await readPreferenceEvidence(target.path,id,target.adapter);
let nativeModel,nativeEffort;
for(const line of readFileSync(target.path,'utf8').split('\n')) {
  let e;try{e=JSON.parse(line);}catch{continue;}
  if(e.type==='turn_context'){nativeModel=e.payload?.model;nativeEffort=e.payload?.effort;}
}
console.log(JSON.stringify({known:proof.known,nativeModel,nativeEffort,
  frames:proof.frames.map(f=>({callId:f.callId,status:f.value.preference_delivery?.status??'full',
    bytes:Buffer.byteLength(JSON.stringify(f.value))}))}));
'''
                check = await asyncio.create_subprocess_exec(shutil.which('node'), '--input-type=module', '-e',
                    verification, session, cwd=root, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                output, errors = await check.communicate()
                assert check.returncode == 0, errors.decode()
                native = json.loads(output.decode())
                assert native['known'] is True and native['nativeModel'] == model and native['nativeEffort'] == 'max', native
                assert [f['status'] for f in native['frames']] == ['full', 'delta', 'full'], native
                metadata = [json.loads(line) for line in (tmp_path / 'native-request-metadata.jsonl').read_text().splitlines()]
                assert all(m['threadId'] == session and m.get('sessionId') for m in metadata), metadata
                evidence.append(native)
                (tmp_path / 'native-evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
            finally:
                server.should_exit = True
                await serving
