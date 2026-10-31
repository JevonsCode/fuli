"""Each Agent's own person-like name: generated, numbered or refused with free
alternatives at write time, offered as a rename on read. Synthetic Agents only."""
import json
import re
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.name_identity import identity_key
from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentRecord, ProjectAgentRename, ProjectAgentUpsert
from fuli_graph.project_agent_names import (
    FIRST_NAMES,
    LAST_NAMES,
    NameTaken,
    agent_display_name,
    free_nicknames,
    new_agent_display_name,
    title_like,
    unique_nickname,
)
from fuli_graph.store_project_agent_naming import (
    renamed_profile, require_free_proposed_name, with_person_name, with_rename_suggestion,
)
from fuli_graph.store_project_agent_rename import StoreProjectAgentRename


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
    # A role name that reads as a person is numbered; a nickname given on purpose is refused.
    assert new_agent_display_name('agent-ppt', 'Lyra North', None, taken) == 'Lyra North 2'
    assert new_agent_display_name('agent-ppt', 'LYRA  north', None, taken | {'lyra north 2'}) == 'LYRA  north 3'
    with pytest.raises(NameTaken) as refused:
        new_agent_display_name('agent-ppt', 'PPT 专责', 'LYRA  north', taken)
    assert refused.value.alternatives == free_nicknames('agent-ppt', taken)


def test_free_alternatives_are_distinct_unused_generated_names():
    legacy = unique_nickname('agent-ppt', set())
    taken = {identity_key(legacy), 'bole'}
    free = free_nicknames('agent-ppt', taken)
    assert len(free) == 3 and len(set(free)) == 3
    assert all(is_generated(name) and identity_key(name) not in taken for name in free)
    every = {identity_key(f'{first} {last}') for first in FIRST_NAMES for last in LAST_NAMES}
    assert free_nicknames('agent-ppt', every) == [f'{legacy} 2']


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
    assert 'free names' in refused.value.detail


@pytest.mark.asyncio
async def test_a_new_agent_given_a_taken_name_is_refused_with_free_alternatives():
    store = NamesStore({'agent-other': {'name': 'x', 'display_name': 'Lyra North'}})
    with pytest.raises(HTTPException) as refused:
        await with_person_name(store, upsert('agent-ppt', 'PPT 专责', 'lyra NORTH'))
    detail = refused.value.detail
    assert refused.value.status_code == 409 and detail.startswith('agent_name_taken')
    assert all(name in detail for name in free_nicknames('agent-ppt', {'lyra north'}))
    # A free name in the person's style is kept as given.
    kept = await with_person_name(store, upsert('agent-ppt', 'PPT 专责', '青禾'))
    assert kept.profile.display_name == '青禾'


@pytest.mark.asyncio
async def test_a_recruited_agent_whose_proposed_name_was_taken_since_gets_a_generated_one():
    store = NamesStore({'agent-other': {'name': 'x', 'display_name': '青禾'}})
    request = await with_person_name(store, upsert('agent-ppt', 'PPT 专责', '青禾'), recruitment_id='recruitment-1')
    assert request.profile.display_name == unique_nickname('agent-ppt', {'青禾'})


@pytest.mark.asyncio
async def test_a_recruitment_proposing_a_taken_name_is_refused_before_anything_is_written():
    store = NamesStore({'agent-other': {'name': 'x', 'display_name': '青禾'}})
    with pytest.raises(HTTPException) as refused:
        await require_free_proposed_name(store, 'space', 'task-1', ProjectAgentProfile(
            name='PPT 专责', display_name='青禾', responsibility='制作 PPT。'))
    assert refused.value.status_code == 409 and 'agent_name_taken' in refused.value.detail
    for display_name in ('松风', 'PPT 专责'):
        await require_free_proposed_name(store, 'space', 'task-1', ProjectAgentProfile(
            name='PPT 专责', display_name=display_name, responsibility='制作 PPT。'))
    reads = store.calls
    # Without a proposed name the generator names the Agent, so nothing is read.
    await require_free_proposed_name(store, 'space', 'task-1', ProjectAgentProfile(
        name='PPT 专责', responsibility='制作 PPT。'))
    assert store.calls == reads


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


ROSTER = {'employee.jefa': ('Jefa', None), 'employee.bole': ('Bole', '伯乐'), 'agent-ppt': ('PPT 专责', 'Iris Vale')}


def test_any_agent_can_be_renamed_built_in_roles_included():
    profile = {'name': 'Jefa', 'responsibility': '项目经理'}
    assert renamed_profile(ROSTER, 'employee.jefa', profile, '小J') == {**profile, 'display_name': '小J'}
    assert renamed_profile(ROSTER, 'agent-ppt', {'name': 'PPT 专责'}, 'Nova Park')['display_name'] == 'Nova Park'


def test_a_role_goes_back_to_its_own_name_and_other_agents_always_keep_one():
    assert 'display_name' not in renamed_profile(ROSTER, 'employee.bole', {'name': 'Bole', 'display_name': '伯乐'}, None)
    with pytest.raises(HTTPException) as refused:
        renamed_profile(ROSTER, 'agent-ppt', {'name': 'PPT 专责'}, None)
    assert refused.value.status_code == 422


@pytest.mark.parametrize('agent_id,name', [
    ('agent-ppt', '伯乐'),       # another Agent's shown name
    ('agent-ppt', 'bole'),       # a role's built-in name stays its second name
    ('agent-ppt', 'TONBORG'),    # even a role nobody renamed
    ('employee.jefa', 'Iris  vale'),
    ('employee.jefa', 'Astro'),  # another role's built-in name
])
def test_a_name_someone_is_called_by_is_refused_with_free_alternatives(agent_id, name):
    with pytest.raises(HTTPException) as refused:
        renamed_profile(ROSTER, agent_id, {'name': 'x'}, name)
    assert refused.value.status_code == 409
    # The console reads the free names from this exact wording (web agent-rename.ts freeNamesOffered).
    match = re.fullmatch(r'agent_name_taken: .*; free names: (.+)\. Choose one or propose another\.', refused.value.detail)
    assert match and all(is_generated(free) for free in match.group(1).split(', '))


def test_an_agent_may_keep_or_respell_its_own_names():
    assert renamed_profile(ROSTER, 'employee.bole', {'name': 'Bole'}, 'BOLE')['display_name'] == 'BOLE'
    assert renamed_profile(ROSTER, 'agent-ppt', {'name': 'PPT 专责'}, 'iris vale')['display_name'] == 'iris vale'


@pytest.mark.parametrize('name', ['', '   ', 'two\nlines', 'x' * 65])
def test_a_name_is_one_short_visible_line(name):
    with pytest.raises(ValueError):
        ProjectAgentRename(personal_space_id='space', display_name=name)
    assert ProjectAgentRename(personal_space_id='space', display_name='  小林 ').display_name == '小林'


class RenameStore(StoreProjectAgentRename):
    """One Agent in a synthetic space; the write lands only over the profile it read."""

    def __init__(self, profile, *, changed_meanwhile=False):
        self.profile_json = json.dumps(profile)
        self.writes = []

        async def execute_query(query, **parameters):
            if 'RETURN agent.agent_id AS agent_id, agent.profile_json' in query:
                return [{'agent_id': 'employee.jefa', 'profile_json': self.profile_json}], None, None
            if 'SET agent.profile_json' in query:
                if changed_meanwhile or parameters['stored'] != self.profile_json:
                    return [], None, None
                self.writes.append(json.loads(parameters['profile_json']))
                return [{'agent_id': parameters['agent_id']}], None, None
            return [{'profile_json': self.profile_json}], None, None
        self.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query))

    def _require_personal(self):
        pass

    async def authorize(self, actor, space_id, role):
        assert space_id == 'space' and role == 'maintainer'

    async def get_project_agent(self, actor, space_id, project_id, agent_id):
        return agent_id


@pytest.mark.asyncio
async def test_renaming_writes_only_the_shown_name():
    store = RenameStore({'name': 'Jefa', 'responsibility': '项目经理', 'agent_type': 'coordinator'})
    request = ProjectAgentRename(personal_space_id='space', display_name='小J')
    assert await store.rename_project_agent({}, 'employee.jefa', request) == 'employee.jefa'
    assert store.writes[0]['display_name'] == '小J' and store.writes[0]['name'] == 'Jefa'
    assert store.writes[0]['agent_type'] == 'coordinator'


@pytest.mark.asyncio
async def test_a_rename_racing_another_edit_is_refused_not_lost():
    store = RenameStore({'name': 'Jefa', 'responsibility': '项目经理'}, changed_meanwhile=True)
    with pytest.raises(HTTPException) as refused:
        await store.rename_project_agent({}, 'employee.jefa', ProjectAgentRename(personal_space_id='space', display_name='小J'))
    assert refused.value.status_code == 409
