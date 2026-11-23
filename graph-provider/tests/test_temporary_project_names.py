"""A temporary project stores no name (graph/23): the step's own queries and
undo journal, the project models' name rule, and what a lead of an unnamed
project is called. Every value is synthetic; the step itself runs against
Neo4j in test_graph_format_confirm_neo4j.py."""

import json

import pytest
from pydantic import ValidationError

from fuli_graph.default_project_lead import default_lead_profile
from fuli_graph.graph_field_contract import NODE_FIELDS
from fuli_graph.graph_format_journal import UNDO_LABEL
from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION, GRAPH_MIGRATIONS
from fuli_graph.graph_format_temporary_names import (
    GENERATED_NAMES,
    TEMPORARY_NAME_JOURNAL,
    _without_name,
    apply_temporary_names,
    pending_temporary_names,
)
from fuli_graph.models import PersonalProjectUpsert, ProjectProfile
from fuli_graph.temporary_project_scope import _SESSION_PROFILE, _TASK_PROFILE, is_temporary_project, project_reference

STEP = 'graph/23-temporary-project-names'


class RecordingDriver:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.rows, None, None


def test_the_step_is_the_next_version_and_changes_records_only_with_a_person():
    step = next(migration for migration in GRAPH_MIGRATIONS if migration.id == STEP)
    assert step.to_version == GRAPH_FORMAT_VERSION == 23
    assert step.kind == 'rewrite' and not step.automatic
    assert step.journal is TEMPORARY_NAME_JOURNAL and TEMPORARY_NAME_JOURNAL.reversible


def test_every_generated_name_ever_shipped_is_matched_and_nothing_by_how_it_was_stored():
    # The conversation fallback saved its projects as registered: the name alone decides.
    assert GENERATED_NAMES == ('临时任务 / Temporary task', '临时会话 / Temporary session',
                               '会话项目 / Conversation project')
    (touch,) = TEMPORARY_NAME_JOURNAL.touches
    for name in GENERATED_NAMES:
        assert f"'{name}'" in touch.match
    assert 'scope_type' not in touch.match and 'STARTS WITH' not in touch.match


def profile(name):
    return json.dumps({'name': name, 'purpose': 'Synthetic purpose.'}, ensure_ascii=False)


@pytest.mark.asyncio
async def test_pending_lists_the_projects_still_holding_a_generated_name_in_both_places():
    driver = RecordingDriver([
        {'id': 'node-b', 'profile_json': profile('会话项目 / Conversation project')},
        {'id': 'node-a', 'profile_json': profile('')},
        # The column says FULI's name, the profile a person's: theirs stays.
        {'id': 'node-c', 'profile_json': profile('Synthetic own words')},
    ])
    assert await pending_temporary_names(driver, None) == ['node-a', 'node-b']
    (query, parameters), = driver.calls
    assert query.startswith(TEMPORARY_NAME_JOURNAL.touches[0].match) and parameters == {'routing_': 'r'}


@pytest.mark.asyncio
async def test_apply_clears_both_names_and_marks_the_project_temporary():
    stored = json.dumps({'name': '会话项目 / Conversation project', 'purpose': 'Synthetic purpose.',
                         'boundaries': ['Synthetic boundary.'], 'lifecycle': 'active'}, ensure_ascii=False)
    driver = RecordingDriver([{'id': 'node-a', 'profile_json': stored},
                              {'id': 'node-c', 'profile_json': json.dumps({'name': 'Synthetic own words'})}])
    await apply_temporary_names(driver, None)
    (_, _), (write, parameters) = driver.calls
    assert "item.name = ''" in write and "item.scope_type = 'temporary'" in write
    (row,) = parameters['rows']
    assert row['id'] == 'node-a'
    assert json.loads(row['profile_json']) == {**json.loads(stored), 'name': ''}


@pytest.mark.asyncio
async def test_apply_with_nothing_left_writes_nothing():
    driver = RecordingDriver([])
    await apply_temporary_names(driver, None)
    assert len(driver.calls) == 1, 'only the read'


def test_only_the_name_changes_inside_the_profile_and_its_order_stays():
    stored = '{"purpose": "Synthetic purpose.", "name": "临时任务 / Temporary task", "lifecycle": "active"}'
    assert _without_name(stored) == '{"purpose": "Synthetic purpose.", "name": "", "lifecycle": "active"}'


def test_the_undo_journal_keeps_everything_it_restores():
    (touch,) = TEMPORARY_NAME_JOURNAL.touches
    assert touch.properties == ('name', 'profile_json', 'scope_type')
    assert {f'b_{name}' for name in touch.properties} <= set(NODE_FIELDS[UNDO_LABEL])


def test_temporary_scopes_are_created_without_a_name():
    for profile in (_TASK_PROFILE, _SESSION_PROFILE):
        assert profile.name == ''
    # An unnamed stored profile reads back: the field is optional for a stored record.
    assert ProjectProfile.model_validate_json(_SESSION_PROFILE.model_dump_json()).name == ''


def test_a_project_a_person_or_an_agent_creates_still_needs_a_name():
    profile = {'purpose': 'Synthetic purpose.'}
    with pytest.raises(ValidationError, match='needs a name'):
        PersonalProjectUpsert(personal_space_id='space', project_id='synthetic', profile=profile, create_only=True)
    with pytest.raises(ValidationError, match='needs a name'):
        PersonalProjectUpsert(personal_space_id='space', project_id='synthetic', profile={**profile, 'name': '  '},
                              create_only=True)
    created = PersonalProjectUpsert(personal_space_id='space', project_id='synthetic',
                                    profile={**profile, 'name': 'Synthetic project'}, create_only=True)
    assert created.profile.name == 'Synthetic project'
    # An edit may go without a name: the store allows it only for a temporary project.
    edit = PersonalProjectUpsert(personal_space_id='space', project_id='temporary-' + 'ab' * 32,
                                 profile={**profile, 'lifecycle': 'archived'})
    assert edit.profile.name == ''


class ProjectsDriver(RecordingDriver):
    def __init__(self, scope_type, name):
        super().__init__([{'scope_type': scope_type, 'name': name}])


@pytest.mark.asyncio
async def test_the_store_lets_only_a_temporary_project_go_on_without_a_name():
    from types import SimpleNamespace
    from fastapi import HTTPException
    from fuli_graph.store_projects import StoreProjects

    def store(scope_type, name):
        value = StoreProjects()
        value.runtime = SimpleNamespace(driver=ProjectsDriver(scope_type, name))
        return value
    assert await store('temporary', '')._temporary_project('space', 'temporary-' + 'ab' * 32) is True
    assert await store('registered', 'Synthetic own')._temporary_project('space', 'synthetic') is False
    named = store('registered', 'Synthetic own')
    named._require_personal = lambda: None
    async def authorize(*_args):
        return {}
    named.authorize = authorize
    with pytest.raises(HTTPException, match='needs a name'):
        await named.upsert_personal_project({}, PersonalProjectUpsert(
            personal_space_id='space', project_id='synthetic', profile={'purpose': 'Synthetic purpose.'}))


def test_an_unnamed_project_is_referred_to_by_the_number_the_console_shows():
    assert project_reference('temporary-' + 'ab12' * 16, '') == '#ab12ab12'
    assert project_reference('conversation-' + 'cd34' * 16, '') == '#cd34cd34'
    assert project_reference('synthetic-other', '') == '#synthetic-other'
    assert project_reference('temporary-' + 'ab12' * 16, 'Synthetic title') == 'Synthetic title'


def test_the_lead_of_an_unnamed_project_is_never_named_after_an_empty_name():
    lead = default_lead_profile(project_reference('temporary-' + 'ef56' * 16, ''))
    assert lead.name == '#ef56ef56 负责人'
    assert not lead.name.startswith(' ')


def test_a_project_is_temporary_by_its_scope_type_or_an_unnamed_generated_id_never_by_a_readable_id():
    digest = 'ab12' * 16
    assert is_temporary_project('temporary-' + digest, 'temporary', '') is True
    assert is_temporary_project('synthetic-any', 'temporary', 'Anything') is True
    # A conversation fallback a graph waiting for graph/23 has not marked yet.
    assert is_temporary_project('conversation-' + digest, None, '会话项目 / Conversation project') is True
    assert is_temporary_project('conversation-' + digest, 'registered', '') is True
    # A person named it: it is theirs.
    assert is_temporary_project('conversation-' + digest, 'registered', 'Synthetic garden notes') is False
    # Readable IDs a person's project name makes ('Temporary fix', 'Conversation notes').
    assert is_temporary_project('temporary-fix', 'registered', 'Temporary fix') is False
    assert is_temporary_project('conversation-notes', None, 'Conversation notes') is False
