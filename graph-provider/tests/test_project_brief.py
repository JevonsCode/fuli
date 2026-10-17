import pytest
from pydantic import ValidationError
from fuli_graph.models import PersonalProjectUpsert, ProjectProfile

@pytest.mark.parametrize('profile', [{'name': 'Sample'}, {'name': 'Sample', 'purpose': ' \n', 'scope': '\t', 'boundaries': [' ']}])
def test_new_project_requires_a_substantive_brief(profile):
    with pytest.raises(ValidationError, match='brief'):
        PersonalProjectUpsert(personal_space_id='space', project_id='sample', profile=profile, create_only=True)

@pytest.mark.parametrize('fields', [{'purpose': 'Track requests'}, {'scope': 'Sample requests'}, {'boundaries': ['Only sample requests']}])
def test_existing_fields_satisfy_brief_without_a_second_description(fields):
    assert PersonalProjectUpsert(personal_space_id='space', project_id='sample', profile={'name': 'Sample', **fields})

def test_legacy_profile_still_decodes_and_draft_remains_editable():
    assert ProjectProfile(name='Legacy').purpose is None
    profile = ProjectProfile(name='Legacy', purpose='README excerpt', brief_draft={'source': 'readme'})
    assert profile.brief_draft.label == 'AI draft'
    assert profile.brief_draft.editable is True

from types import SimpleNamespace
from unittest.mock import AsyncMock
from fuli_graph.store_projects import StoreProjects
from fuli_graph.store_records import StoreRecords
import json

class ProjectStore(StoreProjects, StoreRecords):
    def _require_personal(self):
        pass


def legacy_store(profile, task_title=None):
    row = {'project': {'project_id': 'sample', 'publication_key': 'key',
        'profile_json': json.dumps({'name': 'Legacy', **profile}),
        'created_at': '2026-10-01T00:00:00Z', 'updated_at': '2026-10-01T00:00:00Z'}}
    store = ProjectStore()
    store.authorize = AsyncMock()
    store.runtime = SimpleNamespace(driver=SimpleNamespace(execute_query=AsyncMock(
        side_effect=[([row], None, None), ([{'title': task_title}] if task_title else [], None, None)])))
    return store

@pytest.mark.asyncio
async def test_first_read_derives_editable_draft_from_readme_source_without_writing():
    store = legacy_store({'sources': [{'key': 'readme', 'kind': 'repository', 'title': 'README.md', 'summary': 'Tracks\nsample requests.'}]})
    project = await store.get_personal_project({'id': 'reader'}, 'space', 'sample')
    assert project.profile.purpose == 'Tracks sample requests.'
    assert project.profile.brief_draft.source == 'readme'
    assert store.runtime.driver.execute_query.call_count == 1

@pytest.mark.asyncio
async def test_first_read_uses_earliest_project_task_and_never_fabricates_missing_evidence():
    store = legacy_store({}, 'Track\nsample requests.')
    project = await store.get_personal_project({'id': 'reader'}, 'space', 'sample')
    assert project.profile.purpose == 'Track sample requests.'
    assert project.profile.brief_draft.source == 'first_task'
    query, = store.runtime.driver.execute_query.call_args.args
    assert 'ORDER BY task.created_at' in query
    assert store.runtime.driver.execute_query.call_args.kwargs['project_id'] == 'sample'
    empty = await legacy_store({}).get_personal_project({'id': 'reader'}, 'space', 'sample')
    assert empty.profile.purpose is None
    assert empty.profile.brief_draft is None

@pytest.mark.asyncio
async def test_explicit_description_is_never_replaced_with_a_draft():
    store = legacy_store({'scope': 'An explicit scope.'}, 'Different task')
    project = await store.get_personal_project({'id': 'reader'}, 'space', 'sample')
    assert project.profile.scope == 'An explicit scope.'
    assert project.profile.purpose is None
    assert project.profile.brief_draft is None
    assert store.runtime.driver.execute_query.call_count == 1

def test_legacy_edits_are_not_rejected_by_create_only_validation():
    request = PersonalProjectUpsert(personal_space_id='space', project_id='sample', profile={'name': 'Renamed legacy', 'lifecycle': 'archived'})
    assert request.profile.purpose is None

@pytest.mark.asyncio
async def test_implicit_create_without_brief_is_rejected_before_creating_a_node():
    from fastapi import HTTPException
    store = legacy_store({})
    store.settings = SimpleNamespace(provider_id='provider')
    store.runtime.driver.execute_query = AsyncMock(return_value=([], None, None))
    request = PersonalProjectUpsert(personal_space_id='space', project_id='sample', profile={'name': 'No brief'})
    with pytest.raises(HTTPException) as exc:
        await store.upsert_personal_project({'id': 'maintainer'}, request)
    assert exc.value.status_code == 422
    query, = store.runtime.driver.execute_query.call_args.args
    assert query.index('WHERE $has_brief OR existing IS NOT NULL') < query.index('MERGE (project:')

@pytest.mark.asyncio
async def test_existing_legacy_project_can_be_renamed_or_archived_without_fabrication():
    store = legacy_store({'lifecycle': 'archived'})
    store.settings = SimpleNamespace(provider_id='provider')
    request = PersonalProjectUpsert(personal_space_id='space', project_id='sample', profile={'name': 'Legacy', 'lifecycle': 'archived'})
    project = await store.upsert_personal_project({'id': 'maintainer'}, request)
    assert project.profile.purpose is None
    assert project.profile.lifecycle == 'archived'
    assert store.runtime.driver.execute_query.call_args.kwargs['has_brief'] is False
