"""The statement's days on a disposable Neo4j (FULI_TEST_NEO4J_URI,
FULI_TEST_NEO4J_EPHEMERAL=1). One synthetic personal space; only it is removed."""
from datetime import datetime, timedelta, timezone

import pytest

from fuli_graph.knowledge_audit import AGENT_CONFIRMATION_POLICY_VERSION
from test_knowledge_statement_neo4j import basis
from test_knowledge_tags_neo4j import run_in_world

PATH = '/v1/knowledge/statement/days'
LOCAL = timezone(timedelta(hours=8))
SINCE = datetime(2026, 11, 9, tzinfo=LOCAL)
UNTIL = datetime(2026, 11, 16, tzinfo=LOCAL)
# Both on 10 November in UTC, on either side of the local midnight.
BEFORE_MIDNIGHT = datetime(2026, 11, 10, 23, 30, tzinfo=LOCAL)
AFTER_MIDNIGHT = datetime(2026, 11, 11, 0, 30, tzinfo=LOCAL)


async def days_scenario(world):
    group = await world.group_id()
    entities = [
        # Captured before midnight, confirmed by the person after it.
        {'id': 'late', 'status': 'confirmed', 'basis': basis('user', AFTER_MIDNIGHT), 'created': BEFORE_MIDNIGHT},
        # Captured after midnight, kept by use the same day.
        {'id': 'early', 'status': 'agent_confirmed', 'created': AFTER_MIDNIGHT,
         'basis': basis('agent', AFTER_MIDNIGHT + timedelta(hours=1), AGENT_CONFIRMATION_POLICY_VERSION)},
        # A new version is not learned again; its predecessor was captured before the range.
        {'id': 'old', 'status': 'confirmed', 'basis': basis('user', SINCE - timedelta(days=3)),
         'created': SINCE - timedelta(days=3), 'invalid': AFTER_MIDNIGHT, 'replaced_by': 'old-v2'},
        {'id': 'old-v2', 'status': 'confirmed', 'basis': basis('user', SINCE - timedelta(days=3)), 'created': AFTER_MIDNIGHT},
    ]
    await world.driver.execute_query('''
        UNWIND $rows AS row
        CREATE (:Entity {uuid: $space + '-' + row.id, group_id: $group, name: 'Synthetic', summary: 'Synthetic',
                         fuli_confirmation_status: row.status, fuli_confirmation_basis_json: row.basis,
                         created_at: row.created, fuli_invalid_at: row.invalid,
                         fuli_replaced_by_item_id: CASE WHEN row.replaced_by IS NULL THEN NULL
                                                        ELSE $space + '-' + row.replaced_by END})
    ''', rows=entities, space=world.space, group=group)
    await world.driver.execute_query('''
        UNWIND $uses AS use
        CREATE (:FuliKnowledgeAudit {id: $space + '-use-' + use.id, space_id: $space, action: 'knowledge_used',
                                     task_id: use.task, use_kind: 'applied', created_at: use.at})
    ''', space=world.space, uses=[
        {'id': '1', 'task': 'task-a', 'at': BEFORE_MIDNIGHT},
        {'id': '2', 'task': 'task-b', 'at': AFTER_MIDNIGHT},
        {'id': '3', 'task': 'task-c', 'at': AFTER_MIDNIGHT},
        {'id': '4', 'task': 'task-d', 'at': UNTIL + timedelta(hours=1)}])

    response = await world.client.post(PATH, json={
        'personal_space_id': world.space, 'since': SINCE.isoformat(), 'until': UNTIL.isoformat()})
    assert response.status_code == 200, response.text
    assert response.json() == {'days': [
        {'day': '2026-11-10', 'learned': 1, 'confirmed': 0, 'used': 1},
        {'day': '2026-11-11', 'learned': 1, 'confirmed': 2, 'used': 2},
    ]}


@pytest.mark.asyncio
async def test_statement_days_cut_a_real_graph_at_the_local_midnight():
    await run_in_world(days_scenario)
