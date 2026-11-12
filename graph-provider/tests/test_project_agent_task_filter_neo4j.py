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


@pytest.mark.asyncio
async def test_a_list_continues_after_the_last_task_it_returned_without_gaps_or_repeats():
    settings = fixture_settings()
    space_id = f'task-keyset-{uuid4()}'
    async with AsyncGraphDatabase.driver(
        settings.neo4j_uri, auth=('neo4j', settings.neo4j_password),
    ) as driver:
        # Two tasks share each change time, so the task ID breaks the tie.
        await driver.execute_query('''
            CREATE (space:FuliSpace {id: $space_id, kind: 'personal'})
            WITH space
            UNWIND range(0, 6) AS n
            CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(:FuliProjectAgentTask {
                personal_space_id: $space_id, task_id: 'task-' + toString(n),
                personal_project_id: 'project-a', status: 'blocked',
                updated_at: datetime('2026-11-01T00:00:00Z') + duration({minutes: n / 2})
            })
        ''', space_id=space_id)
        class PositionStore(TaskQueryStore):
            def _task_from_row(self, row):
                return row['task']['task_id'], row['task']['updated_at'].to_native()

        store = PositionStore(driver)
        seen, after = [], None
        while True:
            page = await store.list_project_agent_tasks(
                {}, space_id, limit=3,
                after_updated_at=after[1] if after else None, after_task_id=after[0] if after else None,
            )
            if not page:
                break
            seen += [task_id for task_id, _ in page]
            after = page[-1]
        assert seen == ['task-6', 'task-4', 'task-5', 'task-2', 'task-3', 'task-0', 'task-1']
