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
