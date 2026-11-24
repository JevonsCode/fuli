"""Each Agent's own person-like name: generated or refused with free
alternatives (and who uses it, where) at write time, offered as a rename on
read. Synthetic Agents only."""
import json
import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

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
    clear_stale_name_keys, name_identity, renamed_profile, require_free_proposed_name, space_agent_names,
    with_person_name, with_rename_suggestion,
)
from fuli_graph.store_project_agent_rename import StoreProjectAgentRename


class NamesStore:
    """Answers the one names read with the given Agents: agent_id -> profile dict,
    and a refusal's read of where the holders work: agent_id -> project names."""

    def __init__(self, agents, projects=None, history=None):
        rows = [{'agent_id': agent_id, 'profile_json': json.dumps(profile),
                 'name_history_json': json.dumps((history or {}).get(agent_id)) if agent_id in (history or {})
                 else None} for agent_id, profile in agents.items()]
        self.calls = 0

        async def execute_query(query, **parameters):
            self.calls += 1
            assert parameters['personal_space_id'] == 'space'
            if 'ASSIGNED_AGENT' in query:
                return [{'agent_id': agent_id, 'projects': [{'project_id': f'p-{name}', 'name': name} for name in names]}
                        for agent_id, names in (projects or {}).items() if agent_id in parameters['agent_ids']], None, None
            assert 'HAS_PROJECT_AGENT_IDENTITY' in query
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
    # Every first-and-last name taken: a double surname, never a number.
    every = {identity_key(f'{first} {last}') for first in FIRST_NAMES for last in LAST_NAMES}
    longer = unique_nickname('agent-ppt', every)
    assert re.fullmatch(r'[A-Z][a-z]+ [A-Z][a-z]+-[A-Z][a-z]+', longer) and longer.startswith(legacy)
    first, last, second = re.split(r'[ -]', longer)
    assert first in FIRST_NAMES and last in LAST_NAMES and second in LAST_NAMES and second != last


def test_a_new_agent_gets_a_person_name_and_keeps_the_job_as_its_role():
    taken = {'bole', 'lyra north'}
    assert is_generated(new_agent_display_name('agent-ppt', 'PPT 专责', None, taken))
    assert is_generated(new_agent_display_name('agent-ppt', 'PPT 专责', 'PPT 专责', taken))
    assert new_agent_display_name('agent-ppt', 'PPT 专责', 'Iris Vale', taken) == 'Iris Vale'
    assert new_agent_display_name('agent-ppt', 'Iris Vale', None, taken) == 'Iris Vale'
    # A taken role name that reads as a person gets a generated name, never "Lyra North 2";
    # a nickname given on purpose is refused.
    assert is_generated(new_agent_display_name('agent-ppt', 'Lyra North', None, taken))
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
    longer = free_nicknames('agent-ppt', every)
    assert len(set(longer)) == 3 and all('-' in name and identity_key(name) not in every for name in longer)


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
    assert refused.value.status_code == 409 and refused.value.detail['code'] == 'agent_name_taken'
    assert 'free names' in refused.value.detail['message']


@pytest.mark.asyncio
async def test_a_new_agent_given_a_taken_name_is_refused_with_free_alternatives():
    store = NamesStore({'agent-other': {'name': 'x', 'display_name': 'Lyra North'}})
    with pytest.raises(HTTPException) as refused:
        await with_person_name(store, upsert('agent-ppt', 'PPT 专责', 'lyra NORTH'))
    detail = refused.value.detail
    assert refused.value.status_code == 409 and detail['message'].startswith('agent_name_taken')
    assert detail['free_names'] == free_nicknames('agent-ppt', {'lyra north'})
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
    assert refused.value.status_code == 409 and refused.value.detail['code'] == 'agent_name_taken'
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


# A session's temporary project: no stored name, read by its number.
TEMPORARY_PROJECT = 'temporary-' + 'c0' * 32
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
    with pytest.raises(NameTaken) as refused:
        renamed_profile(ROSTER, agent_id, {'name': 'x'}, name)
    assert refused.value.alternatives and all(is_generated(free) for free in refused.value.alternatives)


def test_an_agent_may_keep_or_respell_its_own_names():
    assert renamed_profile(ROSTER, 'employee.bole', {'name': 'Bole'}, 'BOLE')['display_name'] == 'BOLE'
    assert renamed_profile(ROSTER, 'agent-ppt', {'name': 'PPT 专责'}, 'iris vale')['display_name'] == 'iris vale'


@pytest.mark.parametrize('name', ['', '   ', 'two\nlines', 'x' * 65])
def test_a_name_is_one_short_visible_line(name):
    with pytest.raises(ValueError):
        ProjectAgentRename(personal_space_id='space', display_name=name)
    assert ProjectAgentRename(personal_space_id='space', display_name='  小林 ').display_name == '小林'


class RenameStore(StoreProjectAgentRename):
    """One Agent in a synthetic space (and others by name); the write lands only
    over the profile it read. taken_meanwhile: the name another write committed
    between the check and this write, refused by the graph's uniqueness rule."""

    def __init__(self, profile, *, agent_id='employee.jefa', others=None, changed_meanwhile=False,
                 taken_meanwhile=None, stale=None):
        self.profile_json = json.dumps(profile)
        self.writes = []
        self.others = dict(others or {})
        # Keys an older FULI left on Agents it renamed: the graph refuses the
        # name until they are cleared.
        self.stale, self.cleared = list(stale or []), []

        async def execute_query(query, **parameters):
            if 'display_name_key IS NOT NULL' in query:
                return [row for row in self.stale if row['key'] in parameters['keys']], None, None
            if 'SET agent.display_name_space_id = null' in query:
                self.cleared += [row['agent_id'] for row in parameters['rows']]
                self.stale = []
                return [{'cleared': len(parameters['rows'])}], None, None
            if 'RETURN agent.agent_id AS agent_id, agent.profile_json' in query:
                rows = {**{other: json.dumps(value) for other, value in self.others.items()},
                        agent_id: self.profile_json}
                return [{'agent_id': key, 'profile_json': value} for key, value in rows.items()], None, None
            if 'ASSIGNED_AGENT' in query:
                return [{'agent_id': other, 'projects': [
                    {'project_id': 'p-saturn', 'name': 'Saturn'},
                    {'project_id': TEMPORARY_PROJECT, 'name': None, 'scope_type': 'temporary'}]}
                        for other in parameters['agent_ids']], None, None
            if 'SET agent.profile_json' in query:
                [row] = parameters['rows']
                if self.stale:
                    raise ConstraintError('Node(3) already exists with label `FuliProjectAgent` and properties '
                                          '`display_name_key` = \'' + self.stale[0]['key'] + '\'')
                if taken_meanwhile:
                    self.others['racer'] = {'name': 'x', 'display_name': taken_meanwhile}
                    raise ConstraintError('Node(7) already exists with label `FuliProjectAgent` and properties '
                                          '`display_name_space_id` = \'space\', `display_name_key` = \'nova park\'')
                if changed_meanwhile or row['stored'] != self.profile_json:
                    return [{'written': 0}], None, None
                self.writes.append({**json.loads(row['profile_json']),
                                    'history': json.loads(row['name_history_json'] or '[]'),
                                    'key': row['display_name_key']})
                return [{'written': 1}], None, None
            return [{'profile_json': self.profile_json, 'name_history_json': None}], None, None
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


@pytest.mark.asyncio
async def test_a_rename_keeps_the_old_name_in_the_history_and_stores_the_new_names_identity():
    store = RenameStore({'name': 'PPT 专责', 'display_name': 'Iris Vale', 'responsibility': '制作 PPT。'},
                        agent_id='agent-ppt')
    await store.rename_project_agent({}, 'agent-ppt', ProjectAgentRename(personal_space_id='space',
                                                                         display_name='Nova  Park'))
    written = store.writes[0]
    assert written['display_name'] == 'Nova  Park' and written['key'] == 'nova park'
    assert [(item['name'], item['reason']) for item in written['history']] == [('Iris Vale', 'renamed')]
    # A role holds the name it is shown by too, so no concurrent write can take it.
    roles = RenameStore({'name': 'Jefa', 'responsibility': '项目经理'})
    await roles.rename_project_agent({}, 'employee.jefa', ProjectAgentRename(personal_space_id='space',
                                                                            display_name='小J'))
    assert roles.writes[0]['key'] == '小j' and roles.writes[0]['history'][0]['name'] == 'Jefa'


@pytest.mark.asyncio
async def test_a_taken_name_is_refused_with_who_uses_it_where_and_free_names():
    store = RenameStore({'name': 'PPT 专责', 'display_name': 'Iris Vale', 'responsibility': '制作 PPT。'},
                        agent_id='agent-ppt', others={'agent-other': {'name': 'x', 'display_name': 'Morgan Vale'}})
    with pytest.raises(HTTPException) as refused:
        await store.rename_project_agent({}, 'agent-ppt', ProjectAgentRename(personal_space_id='space',
                                                                             display_name='morgan vale'))
    # The console reads the fields and names a temporary project in its own
    # language; an Agent reads the sentence, where it is its number.
    detail = refused.value.detail
    assert detail['used_by'] == [{'agent_id': 'agent-other', 'name': 'Morgan Vale', 'projects': [
        {'project_id': TEMPORARY_PROJECT, 'name': '', 'scope_type': 'temporary'},
        {'project_id': 'p-saturn', 'name': 'Saturn', 'scope_type': None}]}]
    assert detail['free_names'] and all(is_generated(free) for free in detail['free_names'])
    assert re.fullmatch(r'agent_name_taken: .*; used by: Morgan Vale \(agent-other\) in #c0c0c0c0, Saturn; '
                        r'free names: .+\. Choose one or propose another\.', detail['message'])
    assert not store.writes


@pytest.mark.asyncio
async def test_a_rename_that_loses_its_name_to_a_concurrent_write_is_refused_the_same_way():
    store = RenameStore({'name': 'PPT 专责', 'display_name': 'Iris Vale', 'responsibility': '制作 PPT。'},
                        agent_id='agent-ppt', taken_meanwhile='Nova Park')
    with pytest.raises(HTTPException) as refused:
        await store.rename_project_agent({}, 'agent-ppt', ProjectAgentRename(personal_space_id='space',
                                                                             display_name='Nova Park'))
    assert refused.value.status_code == 409
    assert refused.value.detail['used_by'][0]['agent_id'] == 'racer'


@pytest.mark.asyncio
async def test_a_refused_new_name_says_who_has_it():
    store = NamesStore({'agent-other': {'name': 'x', 'display_name': 'Lyra North'}},
                       projects={'agent-other': ['Alpha', 'Beta']})
    with pytest.raises(HTTPException) as refused:
        await with_person_name(store, upsert('agent-ppt', 'PPT 专责', 'lyra north'))
    assert refused.value.detail['used_by'] == [{'agent_id': 'agent-other', 'name': 'Lyra North', 'projects': [
        {'project_id': 'p-Alpha', 'name': 'Alpha', 'scope_type': None},
        {'project_id': 'p-Beta', 'name': 'Beta', 'scope_type': None}]}]
    # A role's built-in name is held by the role.
    roles = NamesStore({})
    with pytest.raises(HTTPException) as role:
        await require_free_proposed_name(roles, 'space', 'task-1', ProjectAgentProfile(
            name='PPT 专责', display_name='Tonborg', responsibility='制作 PPT。'))
    assert role.value.status_code == 409 and 'used by: Tonborg (employee.tonborg)' in role.value.detail['message']


RECENTLY = [{'name': 'Morgan Vale', 'until': (datetime.now(UTC) - timedelta(days=3)).isoformat(),
             'reason': 'renamed'}]


@pytest.mark.asyncio
async def test_another_agents_recent_former_name_is_taken_until_it_stops_being_one():
    store = NamesStore({'agent-other': {'name': 'x', 'display_name': 'Wren Hill'}}, history={'agent-other': RECENTLY})
    with pytest.raises(HTTPException) as refused:
        await with_person_name(store, upsert('agent-new', 'PPT 专责', 'morgan  vale'))
    [holder] = refused.value.detail['used_by']
    free_from = (datetime.fromisoformat(RECENTLY[0]['until']) + timedelta(days=30)).date().isoformat()
    assert holder == {'agent_id': 'agent-other', 'name': 'Wren Hill', 'projects': [],
                      'former_name': 'Morgan Vale', 'free_from': free_from}
    assert f'Wren Hill (agent-other), its former name until {free_from}' in refused.value.detail['message']
    assert 'morgan vale' not in {identity_key(name) for name in refused.value.detail['free_names']}
    # A rename to it is refused the same way; the Agent itself may take its 原名 back.
    names = await space_agent_names(store, 'space')
    with pytest.raises(NameTaken):
        renamed_profile(names, 'agent-ppt', {'name': 'PPT 专责'}, 'Morgan Vale')
    assert renamed_profile(names, 'agent-other', {'name': 'x'}, 'Morgan Vale')['display_name'] == 'Morgan Vale'
    # Once 30 days have passed the old name is free.
    long_ago = [{**RECENTLY[0], 'until': (datetime.now(UTC) - timedelta(days=31)).isoformat()}]
    later = NamesStore({'agent-other': {'name': 'x', 'display_name': 'Wren Hill'}}, history={'agent-other': long_ago})
    named = await with_person_name(later, upsert('agent-new', 'PPT 专责', 'Morgan Vale'))
    assert named.profile.display_name == 'Morgan Vale'


@pytest.mark.asyncio
async def test_a_name_held_only_by_a_key_an_older_fuli_left_behind_is_freed_and_the_rename_goes_through():
    # FULI 22 renamed old-holder from Nova Park to Wren Hill but left its key.
    stale = [{'agent_id': 'old-holder', 'space_id': 'space', 'key': 'nova park',
              'profile_json': json.dumps({'name': 'x', 'display_name': 'Wren Hill'})}]
    store = RenameStore({'name': 'PPT 专责', 'display_name': 'Iris Vale', 'responsibility': '制作 PPT。'},
                        agent_id='agent-ppt', others={'old-holder': {'name': 'x', 'display_name': 'Wren Hill'}},
                        stale=stale)
    await store.rename_project_agent({}, 'agent-ppt', ProjectAgentRename(personal_space_id='space',
                                                                         display_name='Nova Park'))
    assert store.cleared == ['old-holder'] and store.writes[0]['key'] == 'nova park'


@pytest.mark.asyncio
async def test_a_key_that_still_says_its_agents_name_is_never_cleared():
    held = [{'agent_id': 'holder', 'space_id': 'space', 'key': 'nova park',
             'profile_json': json.dumps({'name': 'x', 'display_name': 'Nova Park'})}]
    store = RenameStore({'name': 'PPT 专责', 'display_name': 'Iris Vale', 'responsibility': '制作 PPT。'},
                        agent_id='agent-ppt', stale=held)
    assert await clear_stale_name_keys(store.runtime.driver, 'space', ['nova park']) == 0
    assert store.cleared == []


def test_the_stored_name_identity_is_the_shown_names_key_roles_included():
    profile = ProjectAgentProfile(name='PPT 专责', display_name='Ｍorgan  VALE', responsibility='制作 PPT。')
    assert name_identity('space', 'agent-ppt', profile) == {'display_name_space_id': 'space',
                                                            'display_name_key': 'morgan vale'}
    legacy = ProjectAgentProfile(name='design Agent', responsibility='设计。')
    assert name_identity('space', 'agent-old', legacy)['display_name_key'] == identity_key(
        agent_display_name('agent-old', 'design Agent'))
    assert name_identity('space', 'employee.bole', ProjectAgentProfile(name='Bole', responsibility='招聘。')) == {
        'display_name_space_id': 'space', 'display_name_key': 'bole'}

