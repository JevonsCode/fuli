"""Real HTTP/Neo4j read contracts; no model or daily installation involved."""
import json
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client


@pytest.mark.asyncio
async def test_graph_and_preferences_derive_the_same_scoped_weight_over_http():
    settings = fixture_settings()
    prefix = 'synthetic-weight-' + uuid4().hex
    async with provider_client(settings) as (client, _):
        response = await client.post('/v1/spaces', json={'name': prefix, 'kind': 'personal'})
        assert response.status_code == 200, response.text
        space = response.json()
        group = space['group_id']
        cases = []
        for key, status, actor in (
            ('pending', 'pending', None), ('agent', 'agent_confirmed', 'agent'),
            ('human', 'confirmed', 'user'), ('authority', 'confirmed', 'authoritative_source'),
            ('knowledge', 'pending', None),
        ):
            basis = {'existence_reason': 'Synthetic supported rule.',
                     'quadrant_reason': 'A disposable acceptance fixture.',
                     'proposed_by': {'kind': 'agent'}}
            if actor:
                basis.update(confirmed_by={'kind': actor}, confirmed_at='2026-10-18T00:00:00Z')
            if status == 'agent_confirmed':
                basis['agent_policy_version'] = 'agent-usage-v1'
            cases.append({'key': key, 'status': status, 'basis': json.dumps(basis)})
        async with AsyncGraphDatabase.driver(settings.neo4j_uri,
                auth=('neo4j', settings.neo4j_password)) as driver:
            try:
                await driver.execute_query('''
                    CREATE (episode:Episodic {uuid:$prefix+'-episode', group_id:$group,
                        name:'Synthetic support', source_description:'Disposable fixture',
                        fuli_source_kind:'test', created_at:datetime()})
                    CREATE (foreign:Episodic {uuid:$prefix+'-foreign', group_id:$prefix+'-foreign-group',
                        name:'Foreign support', source_description:'Not in the authorized space',
                        fuli_source_kind:'test', created_at:datetime()})
                    WITH episode, foreign UNWIND $cases AS row
                    CREATE (node:Entity {uuid:$prefix+'-'+row.key, group_id:$group,
                        name:'Synthetic weight '+row.key, fuli_type:'Preference',
                        summary:'Synthetic rule '+row.key, fuli_key:$prefix+'-'+row.key,
                        fuli_profile_aspect:CASE WHEN row.key='knowledge' THEN null ELSE 'judgment_preference' END,
                        fuli_preference_scope:'global',
                        fuli_confirmation_status:row.status, fuli_confirmation_basis_json:row.basis,
                        fuli_qualified_use_count:8, fuli_distinct_task_count:4,
                        created_at:datetime()})
                    CREATE (episode)-[:MENTIONS]->(node)
                    CREATE (episode)-[:MENTIONS]->(node)
                    CREATE (foreign)-[:MENTIONS]->(node)
                ''', prefix=prefix, group=group, cases=cases)
                await driver.execute_query('''
                    MATCH (a:Entity {uuid:$prefix+'-agent'}), (b:Entity {uuid:$prefix+'-pending'})
                    CREATE (a)-[:RELATES_TO {uuid:$prefix+'-edge', group_id:$group,
                        name:'PREFERS', fact:'Synthetic relationship', created_at:datetime(),
                        fuli_profile_aspect:'judgment_preference', fuli_preference_scope:'global',
                        fuli_key:$prefix+'-edge', fuli_confirmation_status:'agent_confirmed',
                        fuli_confirmation_basis_json:$basis, fuli_qualified_use_count:8,
                        fuli_distinct_task_count:4,
                        episodes:[$prefix+'-episode',$prefix+'-episode',$prefix+'-foreign',$prefix+'-missing']}]->(b)
                ''', prefix=prefix, group=group, basis=cases[1]['basis'])
                result = await client.get('/v1/spaces/'+space['id']+'/graph', params={'limit':100})
                assert result.status_code == 200, result.text
                body = result.json()
                nodes = {node['id']:node for node in body['nodes']}
                result = await client.get('/v1/collaboration-preferences',
                                          params={'personal_space_id':space['id'], 'limit':100})
                assert result.status_code == 200, result.text
                preferences = {item['id']:item for item in result.json()['effective_preferences']}
                # Existing preference projection represents an edge's endpoints
                # by that relationship; the weight must not change this rule.
                expected = {prefix+'-'+key for key in ('edge','human','authority')}
                assert expected <= preferences.keys(), result.json()
                assert {prefix+'-'+key for key in ('agent','human','authority')} <= nodes.keys(), body
                assert prefix+'-pending' not in preferences
                for key in ('human', 'authority'):
                    assert preferences[prefix+'-'+key]['weight_percent'] == nodes[prefix+'-'+key]['weight_percent']
                assert 10 <= nodes[prefix+'-pending']['weight_percent'] <= 69
                assert nodes[prefix+'-knowledge']['weight_percent'] == nodes[prefix+'-pending']['weight_percent']
                assert 70 <= nodes[prefix+'-agent']['weight_percent'] <= 95
                for key in ('human', 'authority'):
                    assert nodes[prefix+'-'+key]['weight_percent'] == 100
                    assert nodes[prefix+'-'+key]['confirmed_by_person'] is (key == 'human')
                edge = next(item for item in body['edges'] if item['id']==prefix+'-edge')
                assert edge['weight_percent'] == nodes[prefix+'-agent']['weight_percent']
                assert preferences[prefix+'-edge']['weight_percent'] == edge['weight_percent']
                assert all(item['id']!=prefix+'-foreign' for item in edge['evidence'])
            finally:
                await driver.execute_query('''
                    MATCH (n) WHERE n.group_id IN [$group,$prefix+'-foreign-group']
                        OR n.space_id=$space OR n.id=$space DETACH DELETE n
                ''', group=group, prefix=prefix, space=space['id'])
