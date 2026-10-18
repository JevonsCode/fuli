"""Real Neo4j: concurrent first triage labels for one conversation (SOL's #93 repro).

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1; only synthetic
nodes this test creates are touched and removed.
"""
import asyncio
import os
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from fuli_graph.conversation_triage_models import ConversationTriageWrite
from fuli_graph.provider_values import stable_uuid
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


def store(driver, space):
    class Store(StoreConversationTriage):
        def _require_personal(self):
            return None

        async def authorize(self, *args):
            return {'id': space}

    triage = Store()
    triage.runtime = SimpleNamespace(driver=driver)
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
