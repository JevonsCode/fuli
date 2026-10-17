import pytest
from pydantic import ValidationError
from fuli_graph.config import Settings


def settings(**kwargs):
    return Settings(bootstrap_token='synthetic-bootstrap-token', neo4j_password='synthetic-pass', **kwargs)


def test_dedicated_staffing_thresholds_are_configurable_and_bounded():
    default = settings()
    assert getattr(default, 'staffing_demand_window_days', None) == 30
    assert getattr(default, 'staffing_demand_task_threshold', None) == 5
    custom = settings(staffing_demand_window_days=7, staffing_demand_task_threshold=2)
    assert custom.staffing_demand_window_days == 7
    assert custom.staffing_demand_task_threshold == 2
    for values in [{'staffing_demand_window_days': 0}, {'staffing_demand_task_threshold': -1}]:
        with pytest.raises(ValidationError):
            settings(**values)

@pytest.mark.asyncio
async def test_demand_endpoint_requires_exact_project_authorization_and_returns_only_aggregates():
    from fastapi import FastAPI, HTTPException
    from httpx import ASGITransport, AsyncClient
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from fuli_graph.agent_conversation_routes import register_agent_conversation_routes
    app = FastAPI()
    driver = SimpleNamespace(execute_query=AsyncMock(side_effect=[
        ([{'project': {'project_id': 'sample'}}], None, None),
        ([{'occupation': 'engineering', 'task_count': 6}], None, None),
        ([{'occupation': 'engineering', 'has_dedicated': False}], None, None),
    ]))
    store = SimpleNamespace(settings=settings(), _require_personal=lambda: None,
        authorize=AsyncMock(return_value={'id': 'space', 'kind': 'personal'}), runtime=SimpleNamespace(driver=driver))
    register_agent_conversation_routes(app, store, dict)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://synthetic') as client:
        body = {'request': {'personal_space_id': 'space', 'personal_project_id': 'sample', 'occupations': ['engineering']}, 'actor': {'id': 'owner'}}
        response = await client.post('/v1/occupation-demand/query', json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['occupations'] == [{'occupation': 'engineering', 'task_count': 6, 'has_dedicated': False}]
        assert result['window_days'] == 30
        assert result['task_threshold'] == 5
        store.authorize.assert_awaited_once_with({'id': 'owner'}, 'space', 'reader')
        driver.execute_query.reset_mock()
        store.authorize.side_effect = HTTPException(403, 'not authorized')
        denied = await client.post('/v1/occupation-demand/query', json=body)
        assert denied.status_code == 403
        driver.execute_query.assert_not_awaited()


def test_query_rejects_unknown_duplicate_or_unbounded_roles():
    from fuli_graph.staffing_demand import StaffingDemandQuery
    for roles in [[], ['unknown'], ['engineering', 'engineering'], ['lead'], ['engineering', 'testing', 'design', 'data']]:
        with pytest.raises(ValidationError):
            StaffingDemandQuery(personal_space_id='space', personal_project_id='sample', occupations=roles)


def test_environment_can_override_both_thresholds(monkeypatch):
    monkeypatch.setenv('FULI_STAFFING_DEMAND_WINDOW_DAYS', '14')
    monkeypatch.setenv('FULI_STAFFING_DEMAND_TASK_THRESHOLD', '8')
    configured = settings()
    assert configured.staffing_demand_window_days == 14
    assert configured.staffing_demand_task_threshold == 8

@pytest.mark.asyncio
async def test_real_graph_counts_distinct_recent_tasks_without_cross_project_or_role_reassignment_leakage():
    from datetime import datetime, timedelta, timezone
    from uuid import uuid4
    from neo4j import AsyncGraphDatabase
    from test_project_agent_memory_neo4j import fixture_settings, provider_client
    configured = fixture_settings()
    async with provider_client(configured) as (client, _):
        space = (await client.post('/v1/spaces', json={'name': 'Synthetic demand', 'kind': 'personal'})).json()['id']
        project = 'demand-' + uuid4().hex[:12]
        response = await client.put('/v1/personal-projects', json={'personal_space_id': space, 'project_id': project,
            'profile': {'name': 'Synthetic demand', 'purpose': 'Verify occupation demand.'}})
        assert response.status_code == 200, response.text
        now = datetime.now(timezone.utc)
        async with AsyncGraphDatabase.driver(configured.neo4j_uri, auth=(configured.neo4j_user, configured.neo4j_password)) as driver:
            await driver.execute_query('''
              MATCH (space:FuliSpace {id: $space})
              CREATE (a:FuliProjectAgent {occupation_role:'engineering', occupation_updated_at:$old})
              CREATE (b:FuliProjectAgent {occupation_role:'engineering', occupation_updated_at:$old})
              CREATE (changed:FuliProjectAgent {occupation_role:'engineering', occupation_updated_at:$now})
              WITH space,a,b,changed
              UNWIND range(1,6) AS i
              CREATE (t:FuliProjectAgentTask {task_id:$prefix + toString(i), personal_space_id:$space,
                personal_project_id:$project, created_at:$recent, status:'completed'})
              CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(t)
              CREATE (t)-[:HAS_PARTICIPANT]->(a)
              CREATE (t)-[:HAS_PARTICIPANT]->(b)
            ''', space=space, project=project, prefix=project, old=now-timedelta(days=60), recent=now-timedelta(days=1), now=now)
            for suffix, task_project, when, status, occupation_set in [
                ('old', project, now-timedelta(days=31), 'completed', now-timedelta(days=60)),
                ('other', 'other-project', now-timedelta(days=1), 'completed', now-timedelta(days=60)),
                ('cancelled', project, now-timedelta(days=1), 'cancelled', now-timedelta(days=60)),
                ('changed', project, now-timedelta(days=1), 'completed', now),
                ('future', project, now+timedelta(days=1), 'completed', now-timedelta(days=60)),
            ]:
                await driver.execute_query('''
                  MATCH (space:FuliSpace {id:$space})
                  CREATE (t:FuliProjectAgentTask {task_id:$id,personal_space_id:$space,
                    personal_project_id:$project,created_at:$when,status:$status})
                  CREATE (a:FuliProjectAgent {occupation_role:'engineering',occupation_updated_at:$occupation_set})
                  CREATE (space)-[:HAS_PROJECT_AGENT_TASK]->(t)-[:HAS_PARTICIPANT]->(a)
                ''', space=space, id=project+suffix, project=task_project, when=when, status=status, occupation_set=occupation_set)
        result = await client.post('/v1/occupation-demand/query', json={'personal_space_id':space,
            'personal_project_id':project,'occupations':['engineering']})
        assert result.status_code == 200, result.text
        assert result.json()['occupations'] == [{'occupation':'engineering','task_count':6,'has_dedicated':False}]
