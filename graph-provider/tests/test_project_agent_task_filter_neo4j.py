"""Agent task filtering against an explicitly disposable graph."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from test_project_agent_memory_neo4j import fixture_settings


class TaskQueryStore(StoreProjectAgentTasks):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)

    def _require_personal(self):
        pass

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    def _task_from_row(self, row):
        return row['task']['task_id']


@pytest.mark.asyncio
async def test_agent_filter_includes_roles_before_limit_and_preserves_scope():
    settings = fixture_settings()
    space_id = f'task-filter-{uuid4()}'
    async with AsyncGraphDatabase.driver(
        settings.neo4j_uri, auth=('neo4j', settings.neo4j_password),
    ) as driver:
        # Synthetic history includes roles without a participant relationship.
        await driver.execute_query('''
            CREATE (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (agent:FuliProjectAgent {agent_id: 'target'})
            WITH space, agent
            UNWIND range(0, 204) AS n
            CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {
                personal_space_id: $space_id, task_id: toString(n),
                personal_project_id: 'project-a', status: 'running', updated_at: n,
                lead_agent_id: CASE WHEN n IN [0, 3] THEN 'target' ELSE 'other' END,
                coordinator_agent_id: CASE WHEN n IN [1, 3] THEN 'target' ELSE 'other' END
            })
            FOREACH (ignored IN CASE WHEN n IN [2, 3] THEN [1] ELSE [] END |
                CREATE (task)-[:HAS_PARTICIPANT]->(agent))
            WITH DISTINCT agent
            CREATE (:FuliSpace {id: $foreign_space_id, kind: 'personal'})
                -[:HAS_PROJECT_AGENT_TASK]->(:FuliProjectAgentTask {
                    personal_space_id: $foreign_space_id, task_id: 'foreign',
                    lead_agent_id: 'target', updated_at: 999, status: 'running'
                })-[:HAS_PARTICIPANT]->(agent)
        ''', space_id=space_id, foreign_space_id=space_id + '-foreign')
        store = TaskQueryStore(driver)
        result = await store.list_project_agent_tasks(
            {}, space_id, agent_id='target', limit=200,
        )
        assert result == ['3', '2', '1', '0']
        assert await store.list_project_agent_tasks(
            {}, space_id, agent_id='target', limit=2,
        ) == ['3', '2']
        assert await store.list_project_agent_tasks(
            {}, space_id, agent_id='target', status='completed',
        ) == []
        assert len(await store.list_project_agent_tasks({}, space_id, limit=200)) == 200
