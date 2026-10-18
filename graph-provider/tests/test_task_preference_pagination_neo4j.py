"""Real HTTP Provider, disposable Neo4j and MCP stdio; synthetic identities, no model."""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import socket
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space


@pytest.mark.asyncio
async def test_long_preference_pages_over_real_stdio_revalidate_snapshot_and_permission(tmp_path):
    import uvicorn
    settings = fixture_settings()
    root = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    assert node
    async with provider_client(settings) as (client, access_token):
        space = await _create_space(client, 'Synthetic preference pagination')
        await seed_agent(client, space, allowed_clients=['codex'])
        response = await client.get('/v1/project-agents/engineer', params={
            'personal_space_id': space, 'personal_project_id': 'sample-project'})
        assert response.status_code == 200, response.text
        agent = response.json()
        basis = json.dumps({'existence_reason': 'Synthetic pagination fixture.',
                            'quadrant_reason': 'Synthetic user-confirmed fixture rule.',
                            'proposed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
                            'confirmed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
                            'confirmed_at': '2026-10-19T00:00:00Z'})
        items = [{'id': f'{space}-{i}', 'key': f'page-rule-{i:02}',
                  'instruction': f'Synthetic rule {i}: ' + '完整规则𝒜\\"\n' * 160 + f' END_ACC_PREF_{i:02}',
                  'attributes': json.dumps({'preferenceKey': f'page-rule-{i:02}'})} for i in range(100)]
        async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
            await driver.execute_query('''
                MATCH (space:FuliSpace {id:$space}) UNWIND $items AS item
                CREATE (:Entity {uuid:item.id,group_id:space.group_id,name:item.key,summary:item.instruction,
                  created_at:$stamp,fuli_type:'PersonalPreference',fuli_profile_aspect:'judgment_preference',
                  fuli_preference_scope:'global',fuli_confirmation_status:'confirmed',
                  fuli_confirmation_basis_json:$basis,fuli_attributes_json:item.attributes})
                ''', space=space, items=items, basis=basis, stamp=datetime(2026, 10, 19, tzinfo=timezone.utc))
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        runtime = tmp_path / 'runtime.json'
        runtime.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
            'providerUrl': f'http://127.0.0.1:{port}', 'accessToken': access_token,
            'principalId': 'synthetic-pagination', 'spaceId': space}}))
        runtime.chmod(0o600)
        metadata = tmp_path / 'fixture.json'
        metadata.write_text(json.dumps({'space': space, 'agent': agent,
            'items': {item['key']: item['instruction'] for item in items}, 'session': str(uuid4())}))
        mcp = tmp_path / 'mcp.mjs'
        mcp.write_text(f'''
import {{openFederatedGraphApplication}} from {json.dumps((root / 'src/graphiti/federated-application.js').as_uri())};
import {{createMcpServer}} from {json.dumps((root / 'src/mcp/create-mcp-server.js').as_uri())};
import {{StdioServerTransport}} from {json.dumps((root / 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js').as_uri())};
const app=openFederatedGraphApplication({{runtimeConfigPath:{json.dumps(str(runtime))}}});
const server=createMcpServer(app,{{sourceApplication:'codex',registerResources:false,
  toolNames:['get_collaboration_preferences','read_task_preferences']}});
server.server.onclose=()=>app.close();await server.connect(new StdioServerTransport());
''')
        script = f'''
import assert from 'node:assert/strict';
import {{readFileSync}} from 'node:fs';
import {{Client}} from {json.dumps((root / 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js').as_uri())};
import {{StdioClientTransport}} from {json.dumps((root / 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js').as_uri())};
const fixture=JSON.parse(readFileSync({json.dumps(str(metadata))}));
const runtime=JSON.parse(readFileSync({json.dumps(str(runtime))}));
const transport=new StdioClientTransport({{command:process.execPath,args:[{json.dumps(str(mcp))}],
  env:{{PATH:process.env.PATH,CODEX_THREAD_ID:fixture.session}},stderr:'ignore'}});
const client=new Client({{name:'synthetic-pagination-stdio',version:'1'}});
try {{
 await client.connect(transport);
 const entry=await client.callTool({{name:'get_collaboration_preferences',arguments:{{
  projectPath:{json.dumps(str(tmp_path))},personalProjectId:'sample-project',projectAgentId:fixture.agent.agent_id,
  workKind:'implementation',workflow:'pagination',taskPrompt:'Synthetic reader pagination acceptance'}}}});
 assert.notEqual(entry.isError,true,JSON.stringify(entry));
 const token=entry.structuredContent.taskContextToken;
 const read=cursor=>client.callTool({{name:'read_task_preferences',arguments:{{taskContextToken:token,...(cursor?{{cursor}}:{{}})}}}});
 const first=await read();assert.notEqual(first.isError,true,JSON.stringify(first));
 assert.equal(first.structuredContent.preference_delivery.status,'paginated',JSON.stringify(first));
 assert.deepEqual(await read(),first);
 const originalCursor=first.structuredContent.preference_delivery.next_cursor;
 assert.equal((await read(originalCursor+'forged')).isError,true);
 const collected=[];const sizes=[];const revisions=new Set();let result=first;let index=0;
 do {{
  assert.notEqual(result.isError,true,JSON.stringify(result));const page=result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text),page);
  const size=Buffer.byteLength(JSON.stringify(result));assert.ok(size<=32*1024);sizes.push(size);
  assert.equal(page.preference_delivery.page_index,index++);assert.ok(index<=100);
  revisions.add(page.preference_delivery.revision);collected.push(...page.effective_preferences);
  assert.equal(page.preferences_complete,page.preference_delivery.next_cursor===null);
  if(!page.preference_delivery.next_cursor)break;
  result=await read(page.preference_delivery.next_cursor);
 }} while(true);
 assert.equal(revisions.size,1);assert.equal(collected.length,100);
 assert.deepEqual(Object.fromEntries(collected.map(p=>[p.preference_key,p.instruction])),fixture.items);
 const owner=first.structuredContent.context.project_agent_id;
 const ownerResponse=await fetch(runtime.personal.providerUrl+'/v1/project-agents/'+encodeURIComponent(owner)
  +'?'+new URLSearchParams({{personal_space_id:fixture.space,personal_project_id:'sample-project'}}),
  {{headers:{{authorization:'Bearer '+runtime.personal.accessToken}}}});
 assert.equal(ownerResponse.status,200);const ownerProfile=(await ownerResponse.json()).profile;
 const writeAgent=async profile=>{{const response=await fetch(runtime.personal.providerUrl+'/v1/project-agents',{{method:'PUT',
  headers:{{authorization:'Bearer '+runtime.personal.accessToken,'content-type':'application/json'}},
  body:JSON.stringify({{personal_space_id:fixture.space,personal_project_id:'sample-project',agent_id:owner,profile}})}});
  assert.equal(response.status,200,await response.text());}};
 const changed={{...ownerProfile,expectations:'Changed synthetic role, invalidate old page cursor'}};
 await writeAgent(changed);
 const stale=await read(originalCursor);assert.equal(stale.isError,true);assert.equal(stale.structuredContent.effective_preferences,undefined);
 const fresh=await read();assert.notEqual(fresh.isError,true);assert.notEqual(fresh.structuredContent.preference_delivery.revision,
  first.structuredContent.preference_delivery.revision);
 await writeAgent({{...changed,allowed_clients:['cursor']}});
 const revoked=await read(fresh.structuredContent.preference_delivery.next_cursor);
 assert.equal(revoked.isError,true);assert.equal(revoked.structuredContent.effective_preferences,undefined);
 console.log(JSON.stringify({{transport:'real MCP stdio',source:'real HTTP and isolated Neo4j',synthetic:true,
  pages:index,preferences:collected.length,maxPageBytes:Math.max(...sizes),snapshotChangeRejected:true,permissionRevoked:true}}));
}} finally {{await client.close();await transport.close();}}
'''
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.05)
            assert server.started
            process = await asyncio.create_subprocess_exec(node, '--input-type=module', '-e', script,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=180)
            assert process.returncode == 0, stderr.decode()
            print(stdout.decode().strip())
        finally:
            server.should_exit = True
            await serving
