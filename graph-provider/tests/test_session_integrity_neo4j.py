"""Session integrity on disposable Neo4j, including sources without task nodes."""
from types import SimpleNamespace
from uuid import uuid4
import json

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_integrity import KnowledgeIntegrityRequest, check_knowledge_integrity
from fuli_graph.provider_values import stable_uuid
from test_knowledge_hard_delete_neo4j import reviewed
from fuli_graph.knowledge_source_tasks import cleared_task_record


@pytest.mark.asyncio
@pytest.mark.parametrize('audited', [False, True])
async def test_session_integrity_detects_episode_only_presence_and_resurrection(audited):
    settings = reviewed()
    space = 'synthetic-session-integrity-' + str(uuid4())
    session_id = lambda client: stable_uuid(settings.provider_id, space, client, 'host', 'task-context-session')
    async with AsyncGraphDatabase.driver(settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        async def authorize(actor, space_id, role):
            assert space_id == space
            return {'id': space, 'group_id': space, 'kind': 'personal'}

        store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), authorize=authorize,
            _require_personal=lambda: None,
            _task_session_id=lambda space_id, client, host: stable_uuid(
                settings.provider_id, space_id, client, host, 'task-context-session'))
        try:
            await driver.execute_query('''
                CREATE (:Episodic {group_id: $space, uuid: $episode,
                    fuli_source_application: 'codex', fuli_session_id: 'host'})
                CREATE (:Episodic {group_id: $foreign, uuid: $foreign_episode,
                    fuli_source_application: 'cursor', fuli_session_id: 'host'})
                ''', space=space, episode=space + '-episode', foreign=space + '-foreign',
                foreign_episode=space + '-foreign-episode')
            if audited:
                await driver.execute_query('''
                    CREATE (:FuliKnowledgeAudit {space_id: $space, id: $deletion,
                        action: 'hard_delete', deleted_item_keys: $keys})
                    ''', space=space, deletion=space + '-deletion', keys=['session:' + session_id('codex')])
            result = await check_knowledge_integrity(store, {}, KnowledgeIntegrityRequest(
                personal_space_id=space, references=[{'kind': 'session', 'id': session_id('codex')},
                                                    {'kind': 'session', 'id': session_id('cursor')}]))
            assert result.present_count == (0 if audited else 1)
            assert [ref.id for ref in result.resurrected] == ([session_id('codex')] if audited else [])
            assert [ref.id for ref in result.missing] == [session_id('cursor')]
            assert result.hard_deleted_count == int(audited)
        finally:
            await driver.execute_query('''
                MATCH (node) WHERE node.group_id IN [$space, $foreign] OR node.space_id = $space
                DETACH DELETE node
                ''', space=space, foreign=space + '-foreign')


@pytest.mark.asyncio
async def test_retained_task_shell_is_legitimate_absence_but_restored_body_is_reported():
    settings = reviewed()
    space = 'synthetic-shell-integrity-' + str(uuid4())
    session, token = space + '-session', space + '-token'
    record = cleared_task_record(dict(token=token, personal_space_id=space, source_application='codex',
                                     session_id='host', created_at='2026-10-24T00:00:00Z'))
    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        async def authorize(actor, space_id, role):
            return {'id': space, 'group_id': space, 'kind': 'personal'}
        store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), authorize=authorize, _require_personal=lambda: None,
                                _task_session_id=lambda *args: session)
        try:
            await driver.execute_query('''
                CREATE (space:FuliSpace {id:$space, kind:'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
                       (:FuliTaskContextSession {id:$session})-[:HAS_CONTEXT]->
                       (:FuliTaskContext {id:$token, token:$token, personal_space_id:$space,
                         record_json:$record, work_log_json:$work_log, scrubbed_by:$deletion})
                CREATE (:FuliKnowledgeAudit {space_id:$space, id:$deletion, action:'hard_delete',
                                             deleted_item_keys:$keys})''', space=space, session=session, token=token,
                record=json.dumps(record), work_log=json.dumps(record['checkpoint']['work_log']),
                deletion=space + '-deletion', keys=['session:' + session])
            request = KnowledgeIntegrityRequest(personal_space_id=space, references=[{'kind':'session', 'id':session}])
            healthy = await check_knowledge_integrity(store, {}, request)
            assert healthy.status == 'healthy' and healthy.hard_deleted_count == 1
            record['checkpoint']['reason'] = 'Synthetic restored source words'
            await driver.execute_query('MATCH (task:FuliTaskContext {id:$token}) SET task.record_json=$record',
                                       token=token, record=json.dumps(record))
            restored = await check_knowledge_integrity(store, {}, request)
            assert restored.status == 'attention_required' and [row.id for row in restored.resurrected] == [session]
        finally:
            await driver.execute_query('MATCH (node) WHERE node.id IN $ids OR node.space_id=$space DETACH DELETE node',
                ids=[space, session, token], space=space)


@pytest.mark.asyncio
async def test_memory_only_session_integrity_tracks_live_scrubbed_and_restored_bodies():
    """Public memory writes need neither episodes nor task contexts to establish a session."""
    from test_project_agent_memory_neo4j import provider_client, seed_agent
    from test_source_memory_erasure_neo4j import memory_write
    from test_source_delete_integration_neo4j import source_preview, source_delete
    from test_turn_receipt_neo4j import ok, space_with_projects
    from test_knowledge_hard_delete_neo4j import REVIEW
    from test_negative_feedback_block_neo4j import query

    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        foreign = await space_with_projects(client)
        for target_space in (space, foreign):
            await seed_agent(client, target_space, project='memory-source-project', allowed_clients=['codex', 'cursor'])
        source = ok(await memory_write(client, space, 0, 'memory-only', 'Synthetic memory-only source'))
        ok(await memory_write(client, space, 1, 'different-session', 'Synthetic different session'))
        # These remain present throughout: neither is evidence for the requested tuple.
        ok(await memory_write(client, space, 2, 'memory-only', 'Synthetic other client', source_application='cursor'))
        ok(await memory_write(client, foreign, 0, 'memory-only', 'Synthetic foreign space source'))
        store = client._transport.app.state.store
        target = store._task_session_id(space, 'codex', 'memory-only')
        absent = store._task_session_id(space, 'codex', 'never-written')
        async def inspect(*ids):
            return ok(await client.post('/v1/knowledge/integrity', headers=REVIEW, json={
                'personal_space_id': space, 'references': [{'kind': 'session', 'id': id} for id in ids]}))
        live = await inspect(target, absent)
        assert live['present_count'] == 1
        assert live['missing'] == [{'kind': 'session', 'id': absent}]
        identity = dict(source_application='codex', fuli_session_id='memory-only')
        plan = ok(await source_preview(client, space, target, 'session', **identity))
        assert plan['removed_episodes'] == [] and plan['counts']['source_turns'] == 0
        receipt = ok(await source_delete(client, space, target, plan, **identity))
        cleared = await inspect(target)
        assert cleared['status'] == 'healthy' and cleared['hard_deleted_count'] == 1
        assert cleared['resurrected'] == []
        rows = await query(settings, 'MATCH (c:FuliProjectAgentMemoryCheckpoint {id:$id}) RETURN c.record_json AS record',
                           id=source['checkpoint_id'])
        scrubbed = json.loads(rows[0]['record'])
        assert scrubbed['memory'] is None and 'source_session_id' not in scrubbed
        # Restore a whole old record while leaving the node's scrubbed marker.
        # Then restore just its body: the source tuple remains erased and the
        # audit relationship must still identify the affected session.
        for restored in (source, {**scrubbed, 'memory': source['memory']},
                         {**scrubbed, 'unexpected_body': 'Synthetic unexpected restored text'}):
            await query(settings, 'MATCH (c:FuliProjectAgentMemoryCheckpoint {id:$id}) SET c.record_json=$record',
                        id=source['checkpoint_id'], record=json.dumps(restored))
            report = await inspect(target)
            assert report['status'] == 'attention_required'
            assert report['resurrected'] == [{'kind': 'session', 'id': target}]
            assert receipt['deletion_id'] in report['deletion_ids']
        # The foreign checkpoint and another client's same session must not
        # make the now-legitimate erased local source look resurrected.
        await query(settings, 'MATCH (c:FuliProjectAgentMemoryCheckpoint {id:$id}) SET c.record_json=$record',
                    id=source['checkpoint_id'], record=json.dumps(scrubbed))
        assert (await inspect(target))['status'] == 'healthy'
