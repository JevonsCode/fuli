"""Task pages for the console's full lists, against an explicitly disposable graph."""

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from neo4j import AsyncGraphDatabase

from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks
from fuli_graph import store_project_agent_task_pages
from fuli_graph.store_project_agent_task_pages import StoreProjectAgentTaskPages
from test_project_agent_memory_neo4j import fixture_settings


class TaskPageStore(StoreProjectAgentTaskPages, StoreProjectAgentTasks):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)

    def _require_personal(self):
        pass

    async def authorize(self, actor, personal_space_id, role):
        return {'id': personal_space_id, 'kind': 'personal'}

    def _task_from_row(self, row):
        return row['task']['task_id']


async def walk(store, space_id, **filters):
    seen, cursor, totals = [], None, []
    while True:
        page = await store.list_project_agent_task_page({}, space_id, limit=7, cursor=cursor, **filters)
        seen += page.items
        totals.append(page.total)
        if not page.next_cursor:
            return seen, totals
        cursor = page.next_cursor


@pytest.mark.asyncio
async def test_pages_filter_sort_and_walk_without_skips_or_repeats(monkeypatch):
    # Rows stand for their task ids here, so the page holds them as they are.
    monkeypatch.setattr(store_project_agent_task_pages, 'ProjectAgentTaskPage', SimpleNamespace)
    settings = fixture_settings()
    space_id = f'task-pages-{uuid4()}'
    async with AsyncGraphDatabase.driver(
        settings.neo4j_uri, auth=('neo4j', settings.neo4j_password),
    ) as driver:
        # 60 synthetic tasks a minute apart; every third is done, pairs share a time
        # so the task id breaks ties; five lead with 'ada', two more have her join.
        await driver.execute_query('''
            CREATE (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (ada:FuliProjectAgent {agent_id: 'ada'})
            WITH space, ada
            UNWIND range(0, 59) AS n
            CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {
                personal_space_id: $space_id,
                task_id: 'task-' + right('0' + toString(n), 2),
                personal_project_id: CASE WHEN n % 2 = 0 THEN 'project-a' ELSE 'project-b' END,
                title: CASE WHEN n = 7 THEN 'Synthetic Needle report' ELSE 'Synthetic task ' + toString(n) END,
                objective: 'Synthetic objective',
                status: CASE WHEN n % 3 = 0 THEN 'completed' ELSE 'running' END,
                created_at: datetime({epochSeconds: 1700000000 - n * 600}),
                updated_at: datetime({epochSeconds: 1700000000 + (n / 2) * 60}),
                result_summary: CASE WHEN n IN [0, 3] THEN 'Synthetic result' WHEN n = 6 THEN '  ' END,
                completed_at: CASE WHEN n % 3 = 0 THEN datetime({epochSeconds: 1700100000 - n * 60}) END,
                lead_agent_id: CASE WHEN n < 5 THEN 'ada' ELSE 'other' END
            })
            FOREACH (ignored IN CASE WHEN n IN [10, 11] THEN [1] ELSE [] END |
                CREATE (task)-[:HAS_PARTICIPANT {role: 'member', status: 'running'}]->(ada))
            WITH DISTINCT space
            CREATE (:FuliSpace {id: $foreign, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                (:FuliProjectAgentTask {personal_space_id: $foreign, task_id: 'foreign', status: 'running',
                 title: 'Synthetic Needle', objective: '', updated_at: datetime()})
        ''', space_id=space_id, foreign=space_id + '-foreign')
        store = TaskPageStore(driver)

        running, totals = await walk(store, space_id, statuses=['running'])
        assert len(running) == 40 and len(set(running)) == 40
        assert totals[0] == 40 and all(total is None for total in totals[1:])
        # Newest first; tasks that share a time come in task id order.
        assert running[:3] == ['task-58', 'task-59', 'task-56']

        oldest, _ = await walk(store, space_id, statuses=['running'], sort='oldest')
        assert oldest[:3] == ['task-01', 'task-02', 'task-04']
        assert sorted(oldest) == sorted(running)

        # 最近完成 orders by completion: task-00 finished last.
        done, _ = await walk(store, space_id, statuses=['completed'], order='completed')
        assert done[:2] == ['task-00', 'task-03'] and len(done) == 20

        project_b, _ = await walk(store, space_id, statuses=['running', 'completed'], project_ids=['project-b'])
        assert len(project_b) == 30

        ada, _ = await walk(store, space_id, statuses=['running', 'completed'], agent_ids=['ada'])
        assert sorted(ada) == ['task-00', 'task-01', 'task-02', 'task-03', 'task-04', 'task-10', 'task-11']

        needle, totals = await walk(store, space_id, statuses=['running'], text='  needle ')
        assert needle == ['task-07'] and totals == [1]

        window, _ = await walk(
            store, space_id, statuses=['running', 'completed'],
            since=datetime.fromtimestamp(1700000000 + 10 * 60, timezone.utc),
            until=datetime.fromtimestamp(1700000000 + 12 * 60, timezone.utc),
        )
        assert sorted(window) == ['task-20', 'task-21', 'task-22', 'task-23']

        # 进行中's own narrowing: started lately, or quiet for a while.
        started, _ = await walk(store, space_id, statuses=['running'],
                                started_since=datetime.fromtimestamp(1700000000 - 5 * 600, timezone.utc))
        assert sorted(started) == ['task-01', 'task-02', 'task-04', 'task-05']
        quiet, _ = await walk(store, space_id, statuses=['running'],
                              changed_before=datetime.fromtimestamp(1700000000 + 2 * 60, timezone.utc))
        assert sorted(quiet) == ['task-01', 'task-02']

        # 最近完成's own: with a written result (blank does not count), and how long it took.
        with_result, _ = await walk(store, space_id, statuses=['completed'], order='completed', has_result=True)
        assert with_result == ['task-00', 'task-03']
        without, _ = await walk(store, space_id, statuses=['completed'], order='completed', has_result=False)
        assert len(without) == 18 and 'task-06' in without
        quick, _ = await walk(store, space_id, statuses=['completed'], order='completed', took_at_most=101000)
        assert quick == ['task-00']
        slow, _ = await walk(store, space_id, statuses=['completed'], order='completed', took_at_least=101000)
        assert len(slow) == 19 and 'task-00' not in slow

        with pytest.raises(HTTPException) as refused:
            await store.list_project_agent_task_page({}, space_id, statuses=['running'], cursor='not-a-cursor')
        assert refused.value.status_code == 422
