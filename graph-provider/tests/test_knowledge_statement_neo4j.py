"""The compounding statement's counts on a disposable Neo4j (FULI_TEST_NEO4J_URI,
FULI_TEST_NEO4J_EPHEMERAL=1). One synthetic personal space; only it is removed."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from fuli_graph.knowledge_audit import AGENT_CONFIRMATION_POLICY_VERSION
from fuli_graph.tonborg_confirmation import TONBORG_CONFIRMATION_POLICY_VERSION
from test_knowledge_tags_neo4j import run_in_world

PATH = '/v1/knowledge/statement'
UNTIL = datetime(2026, 11, 16, tzinfo=timezone.utc)
SINCE = UNTIL - timedelta(days=7)
POINTS = [UNTIL - timedelta(days=14), UNTIL - timedelta(days=7), UNTIL]
LAST_WEEK = UNTIL - timedelta(days=10)
THIS_WEEK = UNTIL - timedelta(days=2)


def basis(kind=None, at=None, policy=None):
    value = {'existence_reason': 'Synthetic', 'quadrant_reason': 'Synthetic',
             'proposed_by': {'kind': 'agent', 'label': 'Fuli'},
             'confirmed_by': {'kind': kind, 'label': 'Synthetic'} if kind else None,
             'confirmed_at': at.isoformat() if at else None, 'agent_policy_version': policy}
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


async def statement_scenario(world):
    group = await world.group_id()
    entities = [
        # Confirmed by the person last week, still current.
        {'id': 'person-old', 'status': 'confirmed', 'basis': basis('user', LAST_WEEK), 'created': LAST_WEEK},
        # Captured and confirmed by the person this week, then edited into a new version.
        {'id': 'person-new', 'status': 'confirmed', 'basis': basis('user', THIS_WEEK), 'created': THIS_WEEK,
         'invalid': THIS_WEEK + timedelta(hours=1), 'replaced_by': 'person-new-v2'},
        {'id': 'person-new-v2', 'status': 'confirmed', 'basis': basis('user', THIS_WEEK),
         'created': THIS_WEEK + timedelta(hours=1)},
        # Tonborg and the usage rule this week; a pending capture; one retired this week.
        {'id': 'tonborg', 'status': 'agent_confirmed', 'created': LAST_WEEK,
         'basis': basis('agent', THIS_WEEK, TONBORG_CONFIRMATION_POLICY_VERSION)},
        {'id': 'usage', 'status': 'agent_confirmed', 'created': LAST_WEEK,
         'basis': basis('agent', THIS_WEEK, AGENT_CONFIRMATION_POLICY_VERSION)},
        {'id': 'pending', 'status': 'pending', 'basis': basis(), 'created': THIS_WEEK},
        {'id': 'retired', 'status': 'confirmed', 'basis': basis('user', LAST_WEEK - timedelta(days=7)),
         'created': LAST_WEEK - timedelta(days=7), 'invalid': THIS_WEEK},
        # A status the basis does not back counts as unconfirmed.
        {'id': 'forged', 'status': 'confirmed', 'basis': basis(), 'created': LAST_WEEK},
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
        CREATE (:Entity {uuid: $space + '-from', group_id: $group, name: 'From'})
               -[:RELATES_TO {uuid: $space + '-fact', group_id: $group, name: 'RELATES_TO', fact: 'Synthetic',
                              created_at: $created, fuli_confirmation_status: 'confirmed',
                              fuli_confirmation_basis_json: $basis}]->
               (:Entity {uuid: $space + '-to', group_id: $group, name: 'To'})
    ''', space=world.space, group=group, created=LAST_WEEK, basis=basis('user', LAST_WEEK))
    await world.driver.execute_query('''
        UNWIND $uses AS use
        CREATE (:FuliKnowledgeAudit {id: $space + '-use-' + use.id, space_id: $space, action: 'knowledge_used',
                                     task_id: use.task, use_kind: use.kind, created_at: use.at})
    ''', space=world.space, uses=[
        {'id': '1', 'task': 'task-a', 'kind': 'applied', 'at': THIS_WEEK},
        {'id': '2', 'task': 'task-a', 'kind': 'cited', 'at': THIS_WEEK},
        {'id': '3', 'task': 'task-b', 'kind': 'applied', 'at': THIS_WEEK},
        {'id': '4', 'task': 'task-c', 'kind': 'applied', 'at': LAST_WEEK}])
    await world.driver.execute_query('''
        MATCH (space:FuliSpace {id: $space})
        UNWIND $tasks AS task
        CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(:FuliProjectAgentTask {
            task_id: $space + '-' + task.id, personal_space_id: $space, status: task.status,
            completed_at: task.completed, updated_at: task.updated})
    ''', space=world.space, tasks=[
        {'id': 'done', 'status': 'completed', 'completed': THIS_WEEK, 'updated': THIS_WEEK},
        {'id': 'failed', 'status': 'failed', 'completed': None, 'updated': THIS_WEEK},
        {'id': 'old', 'status': 'completed', 'completed': LAST_WEEK, 'updated': THIS_WEEK},
        {'id': 'running', 'status': 'running', 'completed': None, 'updated': THIS_WEEK}])
    await world.driver.execute_query('''
        MATCH (space:FuliSpace {id: $space})
        UNWIND $requests AS request
        CREATE (space)-[:HAS_AGENT_ATTENTION]->(:FuliAgentAttention {
            id: $space + '-' + request.id, personal_space_id: $space, status: request.status,
            responded_by: request.by, updated_at: request.at})
    ''', space=world.space, requests=[
        {'id': 'answered', 'status': 'resolved', 'by': 'human', 'at': THIS_WEEK},
        {'id': 'cancelled', 'status': 'cancelled', 'by': 'agent', 'at': THIS_WEEK},
        {'id': 'earlier', 'status': 'resolved', 'by': 'human', 'at': LAST_WEEK}])

    response = await world.client.post(PATH, json={
        'personal_space_id': world.space, 'since': SINCE.isoformat(), 'until': UNTIL.isoformat(),
        'points': [point.isoformat() for point in POINTS]})
    assert response.status_code == 200, response.text
    assert response.json() == {
        # Two weeks ago: retired only. Last week: + person-old and the fact. Now: retired gone,
        # person-new replaced by its version, + tonborg and usage.
        'series': [1, 3, 5],
        'used': {'times': 3, 'tasks': 2, 'cited': 1, 'applied': 2},
        'learned': {'captured': 2, 'confirmed_by_you': 1, 'confirmed_by_tonborg': 1,
                    'promoted_by_use': 1, 'retired': 1},
        'done': {'finished': 1, 'failed': 1},
        'answered': 1,
    }


@pytest.mark.asyncio
async def test_statement_counts_a_real_graph():
    await run_in_world(statement_scenario)
