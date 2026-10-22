"""Frozen checkpoint owner names, without a graph."""

import json
from types import SimpleNamespace

import pytest

from fuli_graph.project_agent_names import agent_display_name
from fuli_graph.task_worker_attribution import checkpoint_collaboration


def store_with_owner(profile):
    async def execute_query(*_args, **_kwargs):
        return [{'profile_json': json.dumps(profile)}], None, None
    return SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query)))


@pytest.mark.asyncio
async def test_owner_role_title_is_kept_as_role_not_as_name():
    store = store_with_owner({'name': 'Synthetic Framework 负责人'})
    snapshot = await checkpoint_collaboration(store, 'space', {'project_agent_id': 'lead-a'})
    assert snapshot['owner'] == {'agent_id': 'lead-a', 'role': 'Synthetic Framework 负责人',
        'name': agent_display_name('lead-a', 'Synthetic Framework 负责人')}
    assert '负责人' not in snapshot['owner']['name']


@pytest.mark.asyncio
async def test_owner_configured_name_stays_the_name():
    store = store_with_owner({'name': 'Synthetic Framework 负责人', 'display_name': 'Lumi'})
    snapshot = await checkpoint_collaboration(store, 'space', {'project_agent_id': 'lead-a'})
    assert snapshot['owner'] == {'agent_id': 'lead-a', 'name': 'Lumi', 'role': 'Synthetic Framework 负责人'}
