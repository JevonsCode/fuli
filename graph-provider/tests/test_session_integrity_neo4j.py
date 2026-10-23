"""Session integrity on disposable Neo4j, including sources without task nodes."""
from types import SimpleNamespace
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.knowledge_integrity import KnowledgeIntegrityRequest, check_knowledge_integrity
from fuli_graph.provider_values import stable_uuid
from test_knowledge_hard_delete_neo4j import reviewed


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
