"""Real Neo4j: concurrent first triage labels for one conversation (SOL's #93 repro).

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1; only synthetic
nodes this test creates are touched and removed.
"""
import asyncio
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from fuli_graph.conversation_triage_models import ConversationTriageWrite
from fuli_graph.provider_values import graphiti_group_id, stable_uuid
from fuli_graph.store_conversation_triage import StoreConversationTriage
from fuli_graph.system_agents import SYSTEM_ASSISTANT_AGENT_ID


def disposable_uri():
    uri = os.getenv('FULI_TEST_NEO4J_URI')
    if not uri or os.getenv('FULI_TEST_NEO4J_EPHEMERAL') != '1':
        pytest.skip('requires an explicitly disposable FULI_TEST_NEO4J_URI')
    assert urlparse(uri).hostname in {'localhost', '127.0.0.1', '::1'}
    return uri


class TransactionDriver:
    def __init__(self, transaction):
        self.transaction = transaction

    async def execute_query(self, query, **params):
        rows = await self.transaction.run(query, params)
        return await rows.data(), None, None


class SessionDriver:
    """The raw driver as the store's runtime port: one-off queries and one
    explicit transaction (forming a topic runs in one, D-86)."""

    def __init__(self, driver):
        self._driver = driver

    async def execute_query(self, query, **params):
        return await self._driver.execute_query(query, **params)

    @asynccontextmanager
    async def transaction(self):
        async with self._driver.session() as session:
            async with await session.begin_transaction() as transaction:
                yield transaction


def store(driver, space):
    class Store(StoreConversationTriage):
        def _require_personal(self):
            return None

        async def authorize(self, *args):
            return {'id': space, 'group_id': graphiti_group_id('synthetic-provider', 'personal', space)}

        async def get_personal_project(self, *args):
            return {}

    triage = Store()
    triage.runtime = SimpleNamespace(driver=SessionDriver(driver))
    return triage


@pytest.mark.asyncio
async def test_a_first_host_label_and_a_first_correction_leave_one_label():
    from neo4j import AsyncGraphDatabase

    space = 'synthetic-r04-' + uuid4().hex
    conversation = 'synthetic-r04-' + uuid4().hex
    password = os.getenv('FULI_TEST_NEO4J_PASSWORD', 'fixture-pass')
    async with AsyncGraphDatabase.driver(disposable_uri(), auth=('neo4j', password)) as driver:
        await driver.execute_query(
            'CREATE (:FuliConversation {id: $id, scope: $scope})', id=conversation,
            scope=stable_uuid('global-conversation-scope', space, SYSTEM_ASSISTANT_AGENT_ID))

        def write(source, **label):
            return ConversationTriageWrite(personal_space_id=space, conversation_id=conversation,
                                           source=source, **label)

        try:
            async with driver.session() as session:
                tx = await session.begin_transaction()
                try:
                    # The host creates the first label and holds it uncommitted.
                    await store(TransactionDriver(tx), space).record_conversation_triage(
                        {}, write('host', kind='topic', topic='Garden'))
                    correction = asyncio.create_task(store(driver, space).record_conversation_triage(
                        {}, write('user', kind='one_off')))
                    done, _ = await asyncio.wait({correction}, timeout=.5)
                    assert not done, 'the correction must wait for the conversation lock'
                    await tx.commit()
                finally:
                    await tx.close()
            result = await asyncio.wait_for(correction, 10)
            rows, _, _ = await driver.execute_query(
                'MATCH (t:FuliConversationTriage {id: $id}) RETURN properties(t) AS t', id=conversation)
            assert [row['t']['source'] for row in rows] == ['user']
            assert result['triage']['kind'] == 'one_off'
            assert not any('_triage_lock' in row['t'] for row in rows)
        finally:
            await driver.execute_query(
                'MATCH (n) WHERE n.id = $id DETACH DELETE n', id=conversation)


@pytest.mark.asyncio
async def test_topic_days_and_a_decline_read_back_from_real_cypher():
    from neo4j import AsyncGraphDatabase
    from fuli_graph.conversation_triage_models import ConversationTopicDecline, ConversationTopicQuery

    space = 'synthetic-topics-' + uuid4().hex
    conversations = ['synthetic-topics-' + uuid4().hex for _ in range(3)]
    password = os.getenv('FULI_TEST_NEO4J_PASSWORD', 'fixture-pass')
    async with AsyncGraphDatabase.driver(disposable_uri(), auth=('neo4j', password)) as driver:
        triage = store(driver, space)
        try:
            for conversation in conversations:
                await driver.execute_query(
                    'CREATE (:FuliConversation {id: $id, scope: $scope})', id=conversation,
                    scope=stable_uuid('global-conversation-scope', space, SYSTEM_ASSISTANT_AGENT_ID))
                await triage.record_conversation_triage({}, ConversationTriageWrite(
                    personal_space_id=space, conversation_id=conversation, kind='topic', topic='Garden'))
            await driver.execute_query('MATCH (t:FuliConversationTriage {id: $id}) '
                                       "SET t.labeled_at = '2026-10-01T08:00:00+00:00'", id=conversations[0])
            query = ConversationTopicQuery(personal_space_id=space, topic='garden', min_count=3)
            [garden] = (await triage.query_conversation_topics({}, query))['topics']
            assert (garden['count'], garden['days'], garden['declined_count']) == (3, 2, None)
            await triage.decline_conversation_topic({}, ConversationTopicDecline(personal_space_id=space, topic='Garden'))
            [garden] = (await triage.query_conversation_topics({}, query))['topics']
            assert garden['declined_count'] == 3
            assert (await triage.query_conversation_topics({}, ConversationTopicQuery(
                personal_space_id=space, min_count=4)))['topics'] == []
        finally:
            await driver.execute_query('MATCH (n) WHERE n.id IN $ids OR n.space_id = $space DETACH DELETE n',
                                       ids=conversations, space=space)


@pytest.mark.asyncio
async def test_a_read_returns_the_current_label_and_a_correction_changes_its_version():
    from neo4j import AsyncGraphDatabase
    from fuli_graph.conversation_triage_models import ConversationTopicFormation, ConversationTriageRead

    space = 'synthetic-read-' + uuid4().hex
    conversation = 'synthetic-read-' + uuid4().hex
    password = os.getenv('FULI_TEST_NEO4J_PASSWORD', 'fixture-pass')
    async with AsyncGraphDatabase.driver(disposable_uri(), auth=('neo4j', password)) as driver:
        triage = store(driver, space)
        read = ConversationTriageRead(personal_space_id=space, conversation_id=conversation)
        try:
            await driver.execute_query(
                'CREATE (:FuliConversation {id: $id, scope: $scope})', id=conversation,
                scope=stable_uuid('global-conversation-scope', space, SYSTEM_ASSISTANT_AGENT_ID))
            assert await triage.read_conversation_triage({}, read) == {'triage': None}
            await triage.record_conversation_triage({}, ConversationTriageWrite(
                personal_space_id=space, conversation_id=conversation, kind='topic', topic='Garden'))
            host = (await triage.read_conversation_triage({}, read))['triage']
            assert (host['source'], host['kind']) == ('host', 'topic')
            await asyncio.sleep(.01)
            await triage.record_conversation_triage({}, ConversationTriageWrite(
                personal_space_id=space, conversation_id=conversation, kind='one_off', source='user'))
            user = (await triage.read_conversation_triage({}, read))['triage']
            assert (user['source'], user['kind']) == ('user', 'one_off')
            assert user['labeled_at'] != host['labeled_at']
            # Forming a topic into a project changes neither labeled_at nor source:
            # the read still shows it, through formed_project_id.
            await triage.record_conversation_triage({}, ConversationTriageWrite(
                personal_space_id=space, conversation_id=conversation, kind='topic', topic='Garden', source='user'))
            labeled = (await triage.read_conversation_triage({}, read))['triage']
            await triage.form_conversation_topic({}, ConversationTopicFormation(
                personal_space_id=space, topic='Garden', personal_project_id='synthetic-project-b'))
            formed = (await triage.read_conversation_triage({}, read))['triage']
            assert formed['formed_project_id'] == 'synthetic-project-b'
            assert (formed['labeled_at'], formed['source']) == (labeled['labeled_at'], labeled['source'])
            # Another space never sees this conversation's label.
            assert await store(driver, 'synthetic-other').read_conversation_triage({}, ConversationTriageRead(
                personal_space_id='synthetic-other', conversation_id=conversation)) == {'triage': None}
        finally:
            await driver.execute_query('MATCH (n) WHERE n.id = $id DETACH DELETE n', id=conversation)
