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
from fuli_graph.temporary_project_scope import _SESSION_PROFILE, _TASK_PROFILE, project_reference

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


@pytest.mark.asyncio
async def test_pending_lists_the_projects_still_holding_a_generated_name():
    driver = RecordingDriver([{'key': 'node-b'}, {'key': 'node-a'}])
    assert await pending_temporary_names(driver, None) == ['node-a', 'node-b']
    (query, parameters), = driver.calls
    assert query.startswith(TEMPORARY_NAME_JOURNAL.touches[0].match) and parameters == {'routing_': 'r'}


@pytest.mark.asyncio
async def test_apply_clears_both_names_and_marks_the_project_temporary():
    profile = json.dumps({'name': '会话项目 / Conversation project', 'purpose': 'Synthetic purpose.',
                          'boundaries': ['Synthetic boundary.'], 'lifecycle': 'active'}, ensure_ascii=False)
    driver = RecordingDriver([{'id': 'node-a', 'profile_json': profile}])
    await apply_temporary_names(driver, None)
    (_, _), (write, parameters) = driver.calls
    assert "item.name = ''" in write and "item.scope_type = 'temporary'" in write
    (row,) = parameters['rows']
    assert row['id'] == 'node-a'
    assert json.loads(row['profile_json']) == {**json.loads(profile), 'name': ''}


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
        PersonalProjectUpsert(personal_space_id='space', project_id='synthetic', profile=profile)
    with pytest.raises(ValidationError, match='needs a name'):
        PersonalProjectUpsert(personal_space_id='space', project_id='synthetic', profile={**profile, 'name': '  '})
    created = PersonalProjectUpsert(personal_space_id='space', project_id='synthetic',
                                    profile={**profile, 'name': 'Synthetic project'})
    assert created.profile.name == 'Synthetic project'


def test_an_unnamed_project_is_referred_to_by_the_number_the_console_shows():
    assert project_reference('temporary-' + 'ab12' * 16, '') == '#ab12ab12'
    assert project_reference('conversation-' + 'cd34' * 16, '') == '#cd34cd34'
    assert project_reference('synthetic-other', '') == '#synthetic-other'
    assert project_reference('temporary-' + 'ab12' * 16, 'Synthetic title') == 'Synthetic title'


def test_the_lead_of_an_unnamed_project_is_never_named_after_an_empty_name():
    lead = default_lead_profile(project_reference('temporary-' + 'ef56' * 16, ''))
    assert lead.name == '#ef56ef56 负责人'
    assert not lead.name.startswith(' ')
