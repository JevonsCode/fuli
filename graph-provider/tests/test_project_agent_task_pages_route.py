from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI

from fuli_graph.project_agent_routes import register_project_agent_routes
from fuli_graph.store_project_agent_task_pages import (
    ProjectAgentTaskPage,
    decode_task_cursor,
    encode_task_cursor,
)


@pytest.mark.asyncio
async def test_task_pages_route_passes_every_filter_and_refuses_an_empty_status():
    calls = []

    async def read(actor, space, **options):
        calls.append((space, options))
        return ProjectAgentTaskPage(items=[], next_cursor=None, total=0)

    async def actor():
        return {'id': 'principal-a'}

    app = FastAPI()
    register_project_agent_routes(
        app, SimpleNamespace(list_project_agent_task_page=read), Annotated[dict, Depends(actor)],
        Annotated[dict, Depends(actor)],
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
        page = await client.get('/v1/project-agent-task-pages', params=[
            ('personal_space_id', 'space-a'), ('status', 'running'), ('status', 'blocked'),
            ('project', 'project-a'), ('agent', 'ada'), ('text', 'needle'),
            ('since', '2026-11-01T00:00:00Z'), ('order', 'completed'), ('sort', 'oldest'), ('limit', '30'),
            ('started_since', '2026-10-01T00:00:00Z'), ('changed_before', '2026-11-05T00:00:00Z'),
            ('has_result', 'true'), ('took_at_least', '60'), ('took_at_most', '3600'),
        ])
        assert page.status_code == 200, page.text
        assert page.json() == {'items': [], 'next_cursor': None, 'total': 0}
        space, options = calls[-1]
        assert space == 'space-a'
        assert options['statuses'] == ['running', 'blocked']
        assert options['project_ids'] == ['project-a'] and options['agent_ids'] == ['ada']
        assert options['since'] == datetime(2026, 11, 1, tzinfo=timezone.utc) and options['until'] is None
        assert (options['order'], options['sort'], options['limit'], options['text']) == ('completed', 'oldest', 30, 'needle')
        assert options['started_since'] == datetime(2026, 10, 1, tzinfo=timezone.utc)
        assert options['changed_before'] == datetime(2026, 11, 5, tzinfo=timezone.utc)
        assert (options['has_result'], options['took_at_least'], options['took_at_most']) == (True, 60, 3600)

        missing = await client.get('/v1/project-agent-task-pages', params={'personal_space_id': 'space-a'})
        assert missing.status_code == 422
        unknown = await client.get('/v1/project-agent-task-pages', params={'personal_space_id': 'space-a', 'status': 'lost'})
        assert unknown.status_code == 422


def test_task_cursor_round_trips_its_position():
    at = datetime(2026, 11, 6, 12, 30, 1, 250000, tzinfo=timezone.utc)
    assert decode_task_cursor(encode_task_cursor(at, 'task-7')) == (at.isoformat(), 'task-7')
