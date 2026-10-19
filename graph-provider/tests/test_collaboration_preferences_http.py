import json
import os
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


@pytest.mark.asyncio
async def test_child_receives_two_parent_preferences_with_provenance_over_http():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [
            {
                'project_id': 'platform-a',
                'scope_path': ['travel-d', 'platform-a'],
                'scope_distance': 1,
            },
            {
                'project_id': 'platform-b',
                'scope_path': ['travel-d', 'platform-b'],
                'scope_distance': 1,
            },
        ],
        [
            preference_node(
                'parent-a-preference',
                'alignment.network.parent-a.explain-boundary',
                '提出实现建议前先解释功能边界。',
                'platform-a',
                weight=0.85,
                reason='A 的项目约定明确要求解释功能边界。',
            ),
            preference_node(
                'parent-b-preference',
                'alignment.network.parent-b.rollback-path',
                '提出方案时同时说明回退路径。',
                'platform-b',
                weight=0.7,
                reason='B 的项目约定明确要求说明回退路径。',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)

    async def authenticate(token):
        assert token == 'test-access-token'
        return {'id': 'principal-1'}

    async def authorize(actor, space_id, role):
        assert actor == {'id': 'principal-1'}
        assert (space_id, role) == ('personal-space', 'reader')
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }

    store.authenticate = authenticate
    store.authorize = authorize

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    inherited = {
        item['preference_key']: item
        for item in body['effective_preferences']
    }
    assert set(inherited) == {
        'alignment.network.parent-a.explain-boundary',
        'alignment.network.parent-b.rollback-path',
    }
    assert inherited['alignment.network.parent-a.explain-boundary'] == {
        **inherited['alignment.network.parent-a.explain-boundary'],
        'preference_project_id': 'platform-a',
        'inherited_from_project_id': 'platform-a',
        'scope_distance': 1,
        'scope_path': ['travel-d', 'platform-a'],
        'weight': 0.85,
        'reason': 'A 的项目约定明确要求解释功能边界。',
    }
    assert inherited['alignment.network.parent-b.rollback-path']['scope_path'] == [
        'travel-d',
        'platform-b',
    ]
    scope_query = driver.calls[1][0]
    assert "['PART_OF', 'USES_KNOWLEDGE_FROM']" in scope_query
    assert 'PERSONAL_PROJECT_RELATION*1..2' in scope_query
    assert 'RELATED_TO' not in scope_query


@pytest.mark.asyncio
async def test_child_same_key_preference_overrides_parent_without_losing_audit_item():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [{
            'project_id': 'platform-a',
            'scope_path': ['travel-d', 'platform-a'],
            'scope_distance': 1,
        }],
        [
            preference_node(
                'child-comment-language',
                'alignment.comments.explain-function',
                '注释要用中文写清楚功能。',
                'travel-d',
                weight=0.4,
                reason='D 的局部约束由用户明确确认。',
            ),
            preference_node(
                'parent-comment-style',
                'alignment.comments.explain-function',
                '注释要写清楚功能。',
                'platform-a',
                weight=0.99,
                reason='A 的共享偏好权重更高但作用域更远。',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'child-comment-language',
    ]
    assert {item['id'] for item in body['project_preferences']} == {
        'child-comment-language',
        'parent-comment-style',
    }
    assert body['overridden_inherited_ids'] == ['parent-comment-style']
    assert body['conflicts'] == []


@pytest.mark.asyncio
async def test_parent_preference_requires_explicit_inheritance_authorization():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [{
            'project_id': 'platform-a',
            'scope_path': ['travel-d', 'platform-a'],
            'scope_distance': 1,
        }],
        [
            preference_node(
                'parent-local-only',
                'parent.local-only',
                '只在 A 使用。',
                'platform-a',
                weight=1,
                reason='用户明确限制为 A 本地。',
                inheritance_mode='local_only',
            ),
            preference_node(
                'parent-descendants',
                'parent.descendants',
                '所有后代项目使用。',
                'platform-a',
                weight=0.5,
                reason='用户明确允许后代继承。',
                inheritance_mode='descendants',
            ),
            preference_node(
                'parent-selected-travel',
                'parent.selected.travel',
                '只授权 D 使用。',
                'platform-a',
                weight=0.5,
                reason='用户明确选择 D。',
                inheritance_mode='selected_projects',
                inherited_project_ids=['travel-d'],
            ),
            preference_node(
                'parent-selected-other',
                'parent.selected.other',
                '只授权其他项目使用。',
                'platform-a',
                weight=0.5,
                reason='用户没有授权 D。',
                inheritance_mode='selected_projects',
                inherited_project_ids=['other-project'],
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert {item['id'] for item in body['effective_preferences']} == {
        'parent-descendants',
        'parent-selected-travel',
    }
    assert {item['id'] for item in body['project_preferences']} == {
        'parent-descendants',
        'parent-selected-travel',
    }


@pytest.mark.asyncio
async def test_human_confirmed_parent_outranks_agent_confirmed_child():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [{
            'project_id': 'platform-a',
            'scope_path': ['travel-d', 'platform-a'],
            'scope_distance': 1,
        }],
        [
            preference_node(
                'child-agent-tone',
                'shared.tone',
                '使用轻松语气。',
                'travel-d',
                weight=1,
                reason='Agent 根据用量保留。',
                inheritance_mode='local_only',
                confirmation_status='agent_confirmed',
            ),
            preference_node(
                'parent-human-tone',
                'shared.tone',
                '使用正式语气。',
                'platform-a',
                weight=0.1,
                reason='用户明确确认父项目偏好。',
                inheritance_mode='descendants',
                confirmation_status='confirmed',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'parent-human-tone',
    ]
    assert body['overridden_inherited_ids'] == []
    assert body['overridden_lower_authority_ids'] == ['child-agent-tone']


@pytest.mark.asyncio
async def test_human_confirmed_global_outranks_agent_confirmed_local_project():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [],
        [
            preference_node(
                'global-human-tone',
                'shared.tone',
                '使用正式语气。',
                None,
                weight=0.1,
                reason='用户明确确认个人全局偏好。',
                confirmation_status='confirmed',
            ),
            preference_node(
                'child-agent-tone',
                'shared.tone',
                '使用轻松语气。',
                'travel-d',
                weight=1,
                reason='Agent 根据用量保留。',
                inheritance_mode='local_only',
                confirmation_status='agent_confirmed',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'global-human-tone',
    ]
    assert body['overridden_global_ids'] == []
    assert body['overridden_lower_authority_ids'] == ['child-agent-tone']


@pytest.mark.asyncio
async def test_effective_exact_project_override_suppresses_global_conflict_only():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [],
        [
            preference_node(
                'global-tone-formal',
                'shared.tone',
                '使用正式语气。',
                None,
                weight=0.9,
                reason='旧的个人全局判断 A。',
            ),
            preference_node(
                'global-tone-casual',
                'shared.tone',
                '使用轻松语气。',
                None,
                weight=0.1,
                reason='旧的个人全局判断 B。',
            ),
            preference_node(
                'local-tone-direct',
                'shared.tone',
                '在 D 中使用直接语气。',
                'travel-d',
                weight=0.5,
                reason='用户明确确认 D 的精确局部覆盖。',
                inheritance_mode='local_only',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'local-tone-direct',
    ]
    assert body['conflicts'] == []
    assert body['overridden_global_ids'] == [
        'global-tone-casual',
        'global-tone-formal',
    ]
    assert {item['id'] for item in body['global_preferences']} == {
        'global-tone-casual',
        'global-tone-formal',
    }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if 'active_groups' in parameters:
            return [], None, None
        return self.responses.pop(0), None, None


@pytest.mark.asyncio
async def test_source_windows_use_real_neo4j_provider_and_mcp_without_space_queue_starvation():
    """Opt-in synthetic source data; real HTTP and MCP, no native host/model."""
    import asyncio
    import shutil
    import socket
    import subprocess
    import threading
    from pathlib import Path
    from uuid import uuid4
    import uvicorn
    from neo4j import AsyncGraphDatabase
    from test_project_agent_memory_neo4j import fixture_settings

    settings = fixture_settings()
    node = shutil.which('node')
    assert node, 'This opt-in source acceptance also requires Node for the real MCP client.'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    application = create_app(settings)
    server = uvicorn.Server(uvicorn.Config(application, host='127.0.0.1', port=port, log_level='error', access_log=False,
                                           # uvloop would replace this process's event loop policy and break subprocess spawning.
                                           loop='asyncio'))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{port}'
    try:
        async with httpx.AsyncClient(base_url=url, timeout=20) as client:
            for attempt in range(300):
                try:
                    if (await client.get('/health')).is_success:
                        break
                except httpx.ConnectError:
                    pass
                assert thread.is_alive() and attempt < 299, 'Isolated source Provider did not become ready.'
                await asyncio.sleep(0.1)
            bootstrap = await client.post('/v1/bootstrap', headers={'x-fuli-bootstrap-token': settings.bootstrap_token},
                                          json={'principal_name': 'Synthetic preference sources'})
            assert bootstrap.status_code == 200
            access = bootstrap.json()
            client.headers['Authorization'] = f"Bearer {access['access_token']}"
            response = await client.post('/v1/spaces', json={'name': 'Synthetic source completeness', 'kind': 'personal'})
            assert response.status_code == 200
            space = response.json()['id']
            for project in ['queue-project', 'active-child']:
                created = await client.put('/v1/personal-projects', json={'personal_space_id': space,
                    'project_id': project, 'profile': {'name': 'Synthetic source project',
                    'purpose': 'Verify preference source completeness on a real graph.', 'lifecycle': 'active'}})
                assert created.status_code == 200
            prefix = 'source-' + uuid4().hex
            left, right = prefix + '-left', prefix + '-right'
            stamp = datetime(2026, 8, 3, tzinfo=UTC)
            basis = preference_node(left, 'source-tone', 'Formal.', None, weight=0.5, reason='Synthetic user confirmation.')['confirmation_basis_json']
            async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
                await driver.execute_query('''
                    MATCH (space:FuliSpace {id:$space})
                    UNWIND $items AS item
                    CREATE (:Entity {uuid:item.id, group_id:space.group_id, name:item.id, summary:item.instruction,
                      created_at:$stamp, fuli_profile_aspect:'taste', fuli_preference_scope:'global',
                      fuli_confirmation_status:'confirmed', fuli_confirmation_basis_json:$basis,
                      fuli_attributes_json:'{"preferenceKey":"source-tone"}'})
                    ''', space=space, stamp=stamp, basis=basis,
                    items=[{'id': left, 'instruction': 'Formal.'}, {'id': right, 'instruction': 'Casual.'}])
                pending = {'personal_space_id': space, 'preference_key': 'source-tone', 'preference_scope': 'global',
                    'left_item_id': left, 'left_item_kind': 'entity', 'right_item_id': right, 'right_item_kind': 'entity',
                    'status': 'ai_pending', 'requested_by': 'human', 'reason': 'Synthetic deferred decision.',
                    'deferred_at': stamp, 'updated_at': stamp}

                async def queue(records):
                    await driver.execute_query('''MATCH (space:FuliSpace {id:$space})
                        UNWIND $records AS record CREATE (conflict:FuliPreferenceConflict) SET conflict=record
                        CREATE (space)-[:HAS_PREFERENCE_CONFLICT]->(conflict)''', space=space, records=records)

                await queue([{**pending, 'id': f'{prefix}-unrelated-{i:03}', 'left_item_id': 'unrelated-left',
                              'right_item_id': 'unrelated-right', 'updated_at': datetime(2026, 9, 1, tzinfo=UTC)} for i in range(150)]
                    + [{**pending, 'id': prefix + '-match-a'},
                       {**pending, 'id': prefix + '-match-b', 'left_item_id': right, 'right_item_id': left}]
                    + [{**pending, **change, 'id': f'{prefix}-excluded-{i}', 'updated_at': datetime(2026, 9, 2, tzinfo=UTC)}
                       for i, change in enumerate([{'personal_space_id': 'foreign-space'}, {'left_item_kind': 'relationship'},
                            {'right_item_id': 'unrelated-right'}, {'right_item_id': left}, {'status': 'resolved'}])])
                params = {'personal_space_id': space, 'limit': 2}
                result = await client.get('/v1/collaboration-preferences', params=params)
                assert result.status_code == 200, result.text
                body = result.json()
                assert body['source_windows'] == {'candidates_truncated': False, 'project_ancestors_truncated': False, 'queued_conflicts_truncated': False}
                assert [item['id'] for item in body['queued_conflicts']] == [prefix + '-match-a', prefix + '-match-b']
                page = await client.get('/v1/preference-conflicts', params={'personal_space_id': space, 'status': 'ai_pending', 'limit': 100})
                assert page.status_code == 200 and all('match-' not in item['id'] for item in page.json())

                async def mcp(project, limit, blocked):
                    script = '''
                      import assert from 'node:assert/strict';
                      import { Client } from '@modelcontextprotocol/sdk/client/index.js';
                      import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
                      import { createMcpServer } from './src/mcp/create-mcp-server.js';
                      import { FederatedGraphApplication } from './src/graphiti/federated-application.js';
                      let raw=''; for await (const chunk of process.stdin) raw+=chunk;
                      const input=JSON.parse(raw);
                      const app=new FederatedGraphApplication({version:1,workspaces:[],personal:input.personal});
                      const server=createMcpServer(app,{env:{},toolNames:['get_collaboration_preferences'],registerResources:false});
                      const client=new Client({name:'source-completeness-acceptance',version:'1'});
                      const [a,b]=InMemoryTransport.createLinkedPair();
                      try { await server.connect(b); await client.connect(a);
                        const response=await client.callTool({name:'get_collaboration_preferences',arguments:{projectPath:process.cwd(),personalProjectId:input.project,limit:input.limit}});
                        assert.notEqual(response.isError,true,JSON.stringify(response.structuredContent?.error));
                        const data=response.structuredContent;
                        if(input.blocked) { assert.equal(data.preference_delivery.reason,'source_window'); assert.equal(Object.hasOwn(data,'effective_preferences'),false); }
                        else { assert.notEqual(data.context.source_truncated,true); assert.equal(data.deferred_conflicts.length,2); }
                        console.log(JSON.stringify({blocked:input.blocked,sourceWindow:input.blocked?data.preference_delivery.reason:data.context.source_windows}));
                      } finally { await client.close(); await server.close(); await app.close(); }
                    '''
                    child = await asyncio.create_subprocess_exec(node, '--input-type=module', '-e', script,
                        cwd=Path(__file__).resolve().parents[2], stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                    try:
                        stdout, stderr = await asyncio.wait_for(child.communicate(json.dumps({'personal': {'providerUrl': url,
                            'accessToken': access['access_token'], 'principalId': access['principal_id'], 'spaceId': space},
                            'project': project, 'limit': limit, 'blocked': blocked}).encode()), timeout=30)
                    except asyncio.TimeoutError:
                        if child.returncode is None:
                            child.kill()
                        await child.wait()
                        raise
                    assert child.returncode == 0, stderr.decode().replace(access['access_token'], '[fixture credential]')
                    assert stderr == b'' and access['access_token'].encode() not in stdout
                    return json.loads(stdout)

                assert (await mcp('queue-project', 2, False))['blocked'] is False
                await queue([{**pending, 'id': prefix + '-match-c'}])
                overflow = (await client.get('/v1/collaboration-preferences', params=params)).json()
                assert len(overflow['queued_conflicts']) == 2
                assert overflow['source_windows']['queued_conflicts_truncated'] is True and overflow['truncated'] is True
                assert (await mcp('queue-project', 2, True))['blocked'] is True
                for count, expected in [(64, False), (1, True)]:
                    parent_ids = [prefix + '-parent-' + str(i) for i in (range(64) if count == 64 else [64])]
                    for parent_id in parent_ids:
                        created = await client.put('/v1/personal-projects', json={'personal_space_id': space,
                            'project_id': parent_id, 'profile': {'name': 'Synthetic parent',
                                    'purpose': 'Synthetic parent for the inheritance window.', 'lifecycle': 'active'}})
                        assert created.status_code == 200
                    await driver.execute_query('''MATCH (space:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(child:FuliPersonalProject {project_id:'active-child'})
                        UNWIND $parent_ids AS project_id
                        MATCH (space)-[:CONTAINS_PROJECT]->(parent:FuliPersonalProject {project_id:project_id})
                        CREATE (child)-[:PERSONAL_PROJECT_RELATION {relation_type:'PART_OF',status:'active',confirmation_authority:'human_review'}]->(parent)''',
                        space=space, parent_ids=parent_ids)
                    ancestor = await client.get('/v1/collaboration-preferences', params={**params, 'personal_project_id': 'active-child', 'limit': 10})
                    assert ancestor.status_code == 200, ancestor.text
                    assert ancestor.json()['source_windows']['project_ancestors_truncated'] is expected
                    assert ancestor.json()['truncated'] is expected
                assert (await mcp('active-child', 10, True))['blocked'] is True
    finally:
        server.should_exit = True
        await asyncio.to_thread(thread.join, 15)
        assert not thread.is_alive(), 'Isolated source Provider must stop.'


def async_value(value):
    async def resolve(*_args, **_kwargs):
        return value

    return resolve


def preference_node(
    item_id,
    preference_key,
    instruction,
    project_id,
    *,
    weight,
    reason,
    inheritance_mode='descendants',
    inherited_project_ids=None,
    confirmation_status='confirmed',
):
    return {
        'id': item_id,
        'key': preference_key,
        'title': preference_key,
        'instruction': instruction,
        'profile_aspect': 'judgment_preference',
        'preference_scope': 'project' if project_id else 'global',
        'preference_project_id': project_id,
        'attributes_json': json.dumps({
            'preferenceKey': preference_key,
            'weight': weight,
            'reason': reason,
        }),
        'confirmation_basis_json': json.dumps({
            'existence_reason': reason,
            'quadrant_reason': reason,
            'proposed_by': {'kind': 'user', 'label': '用户'},
            'confirmed_by': (
                {'kind': 'agent', 'label': 'Fuli usage policy'}
                if confirmation_status == 'agent_confirmed'
                else {'kind': 'user', 'label': '用户'}
            ),
            'confirmed_at': '2026-08-03T00:00:00Z',
            **(
                {'agent_policy_version': 'agent-usage-v1'}
                if confirmation_status == 'agent_confirmed'
                else {}
            ),
        }),
        'confirmation_status': confirmation_status,
        'inheritance_mode': inheritance_mode,
        'inherited_project_ids': inherited_project_ids or [],
        'created_at': datetime(2026, 8, 3, tzinfo=UTC),
    }
