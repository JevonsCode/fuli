"""Each Agent's own person-like name: generated, numbered or refused at write time,
offered as a rename on read. Synthetic Agents only."""
import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.name_identity import identity_key
from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentRecord, ProjectAgentUpsert
from fuli_graph.project_agent_names import (
    FIRST_NAMES,
    LAST_NAMES,
    agent_display_name,
    new_agent_display_name,
    title_like,
    unique_nickname,
)
from fuli_graph.store_project_agent_naming import with_person_name, with_rename_suggestion


class NamesStore:
    """Answers the one names read with the given Agents: agent_id -> profile dict."""

    def __init__(self, agents):
        rows = [{'agent_id': agent_id, 'profile_json': json.dumps(profile)} for agent_id, profile in agents.items()]
        self.calls = 0

        async def execute_query(query, **parameters):
            self.calls += 1
            assert 'HAS_PROJECT_AGENT_IDENTITY' in query and parameters['personal_space_id'] == 'space'
            return rows, None, None
        self.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query))


def upsert(agent_id, name, display_name=None):
    return ProjectAgentUpsert(personal_space_id='space', agent_id=agent_id, profile=ProjectAgentProfile(
        name=name, display_name=display_name, responsibility='制作项目汇报 PPT。'))


def is_generated(name):
    first, _, last = name.partition(' ')
    return first in FIRST_NAMES and last in LAST_NAMES


@pytest.mark.parametrize('name', ['PPT 专责', 'design Agent', '产品经理', 'Release Manager', '前端工程师', 'Data analyst'])
def test_job_titles_read_as_titles(name):
    assert title_like(name)


@pytest.mark.parametrize('name', ['Lyra North', 'Jamie Ash', '小林', 'Bole', 'Milo Reed'])
def test_person_names_do_not(name):
    assert not title_like(name)


def test_generated_nicknames_skip_every_taken_name_and_start_at_the_legacy_one():
    legacy = agent_display_name('agent-ppt', 'design Agent')
    assert unique_nickname('agent-ppt', set()) == legacy
    taken = {identity_key(legacy)}
    second = unique_nickname('agent-ppt', taken)
    assert is_generated(second) and identity_key(second) not in taken
    every = {identity_key(f'{first} {last}') for first in FIRST_NAMES for last in LAST_NAMES}
    assert unique_nickname('agent-ppt', every) == f'{legacy} 2'


def test_a_new_agent_gets_a_person_name_and_keeps_the_job_as_its_role():
    taken = {'bole', 'lyra north'}
    assert is_generated(new_agent_display_name('agent-ppt', 'PPT 专责', None, taken))
    assert is_generated(new_agent_display_name('agent-ppt', 'PPT 专责', 'PPT 专责', taken))
    assert new_agent_display_name('agent-ppt', 'PPT 专责', 'Iris Vale', taken) == 'Iris Vale'
    assert new_agent_display_name('agent-ppt', 'Iris Vale', None, taken) == 'Iris Vale'
    assert new_agent_display_name('agent-ppt', 'PPT 专责', 'Lyra North', taken) == 'Lyra North 2'
    assert new_agent_display_name('agent-ppt', 'PPT 专责', 'LYRA  north', taken | {'lyra north 2'}) == 'LYRA  north 3'


@pytest.mark.asyncio
async def test_recruiting_a_title_named_agent_stores_a_unique_nickname():
    store = NamesStore({'employee.bole': {'name': 'Bole', 'display_name': 'Bole'},
                        'agent-old': {'name': 'design Agent'}})
    request = await with_person_name(store, upsert('agent-ppt', 'PPT 专责'))
    nickname = request.profile.display_name
    assert request.profile.name == 'PPT 专责'
    assert is_generated(nickname)
    assert nickname not in {'Bole', agent_display_name('agent-old', 'design Agent')}


@pytest.mark.asyncio
async def test_an_update_keeps_the_stored_nickname_and_refuses_another_agents_name():
    store = NamesStore({'agent-ppt': {'name': 'PPT 专责', 'display_name': 'Iris Vale'},
                        'agent-other': {'name': 'Lyra North'}})
    kept = await with_person_name(store, upsert('agent-ppt', 'PPT 专责'))
    assert kept.profile.display_name == 'Iris Vale'
    renamed = await with_person_name(store, upsert('agent-ppt', 'PPT 专责', 'Cleo Park'))
    assert renamed.profile.display_name == 'Cleo Park'
    with pytest.raises(HTTPException) as refused:
        await with_person_name(store, upsert('agent-ppt', 'PPT 专责', 'lyra north'))
    assert refused.value.status_code == 409 and 'agent_name_taken' in refused.value.detail


@pytest.mark.asyncio
async def test_an_existing_agent_is_never_renamed_by_a_write():
    store = NamesStore({'agent-ppt': {'name': 'PPT 专责'}, 'twin': {'name': 'PPT 专责'}})
    # Two legacy Agents already share a name: saving one unchanged is allowed and changes nothing.
    request = await with_person_name(store, upsert('agent-ppt', 'PPT 专责', 'PPT 专责'))
    assert request.profile.display_name == 'PPT 专责'


@pytest.mark.asyncio
async def test_system_agents_keep_their_own_names_without_a_read():
    store = NamesStore({})
    request = upsert('employee.bole', 'Bole')
    assert await with_person_name(store, request) is request
    assert store.calls == 0


def record(agent_id, display_name, **profile):
    timestamp = datetime(2026, 10, 27, tzinfo=UTC)
    return ProjectAgentRecord(agent_id=agent_id, personal_space_id='space', created_at=timestamp, updated_at=timestamp,
        profile=ProjectAgentProfile(name='PPT 专责', display_name=display_name, responsibility='制作 PPT。', **profile))


@pytest.mark.asyncio
async def test_a_title_named_agent_is_offered_a_free_nickname_on_read():
    legacy = unique_nickname('agent-ppt', set())
    store = NamesStore({'agent-ppt': {'name': 'PPT 专责'}, 'agent-other': {'name': 'x', 'display_name': legacy}})
    offered = await with_rename_suggestion(store, record('agent-ppt', 'PPT 专责'))
    assert offered.name_suggestion and offered.name_suggestion != legacy and is_generated(offered.name_suggestion)
    assert offered.profile.display_name == 'PPT 专责'


@pytest.mark.asyncio
@pytest.mark.parametrize('agent_id,display_name,profile', [
    ('agent-ppt', 'Iris Vale', {}),
    ('agent-ppt', 'PPT 专责', {'status': 'archived'}),
    ('employee.assistant', '助理', {}),
])
async def test_no_suggestion_for_person_names_archived_or_system_agents(agent_id, display_name, profile):
    store = NamesStore({})
    result = await with_rename_suggestion(store, record(agent_id, display_name, **profile))
    assert result.name_suggestion is None and store.calls == 0
