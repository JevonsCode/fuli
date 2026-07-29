from datetime import datetime, timezone

import pytest

from fuli_graph.config import Settings
from fuli_graph.models import (
    PersonalProjectUpsert,
    ProjectRelationCreate,
    SpaceCreate,
    StructuredEpisode,
)
from fuli_graph.store import GraphStore, graphiti_group_id, native_datetime
from fuli_graph.store_knowledge import StoreKnowledge


class Neo4jDateTimeStub:
    def __init__(self, value):
        self.value = value

    def to_native(self):
        return self.value


def test_native_datetime_converts_neo4j_temporal_values():
    expected = datetime(2026, 7, 21, tzinfo=timezone.utc)

    assert native_datetime(Neo4jDateTimeStub(expected)) is expected
    assert native_datetime(expected) is expected
    assert native_datetime(None) is None


def test_graphiti_group_id_uses_only_supported_characters():
    assert graphiti_group_id('local:personal', 'personal', 'space/1') == (
        'local_personal-personal-space_1'
    )


@pytest.mark.asyncio
async def test_structured_supersession_stores_the_exact_replacement_relationship():
    driver = SequentialDriver([[], []])
    store = StoreKnowledge()
    store.runtime = RuntimeStub(driver)
    store._group_locks = {}
    episode = StructuredEpisode.model_validate({
        'idempotency_key': 'replacement-episode-1',
        'session_id': 'session-1',
        'name': 'Updated requirement',
        'source_kind': 'conversation',
        'source_description': 'A reviewed requirement replaces the prior relationship.',
        'reference_time': datetime(2026, 7, 28, tzinfo=timezone.utc),
        'entities': [
            {'key': 'source', 'name': 'Source', 'type': 'Requirement'},
            {'key': 'target', 'name': 'Target', 'type': 'Requirement'},
        ],
        'relationships': [{
            'key': 'current-rule',
            'source': 'source',
            'target': 'target',
            'type': 'APPLIES_TO',
            'fact': 'The current rule applies to the target.',
            'supersedes': ['old-rule'],
        }],
    })

    result = await store._commit_episode(
        {'id': 'personal-space', 'group_id': 'personal-group'},
        episode,
        personal_project_id='project-a',
    )

    query, parameters = driver.calls[1]
    assert 'old.fuli_replaced_by_item_id = replacement.replacement_id' in query
    assert "old.fuli_replaced_by_item_kind = 'relationship'" in query
    assert 'NOT (old.uuid IN $relationship_ids)' in query
    assert 'assignment.project_id = $personal_project_id' in query
    assert (
        'old_episode.fuli_personal_project_id =\n'
        '                              $personal_project_id'
    ) in query
    assert parameters['space_id'] == 'personal-space'
    assert parameters['personal_project_id'] == 'project-a'
    assert parameters['superseded_relationships'] == [{
        'key': 'old-rule',
        'replacement_id': result.relationship_ids[0],
    }]


@pytest.mark.asyncio
async def test_workspace_project_creator_becomes_owner_and_maintainer():
    driver = RecordingDriver([{ 'space': {
        'id': 'project-1',
        'name': 'Hotel Theme',
        'kind': 'project',
        'group_id': 'workspace-project-project-1',
        'description': None,
        'visibility': 'public',
        'created_at': datetime(2026, 7, 21, tzinfo=timezone.utc),
    }}])
    store = GraphStore(RuntimeStub(driver), workspace_settings())

    project = await store.create_space(
        {'id': 'principal-1'},
        SpaceCreate(name='Hotel Theme', kind='project'),
    )

    query, parameters = driver.calls[0]
    assert '[:OWNS' in query
    assert "[:MEMBER_OF {role: 'maintainer'" in query
    assert "visibility: 'public'" in query
    assert project.owner_id == 'principal-1'
    assert project.role == 'maintainer'
    assert project.visibility == 'public'


@pytest.mark.asyncio
async def test_project_publication_records_release_version_publisher_time_and_summary():
    published_at = datetime(2026, 7, 22, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [],
        [{'space': {
            'id': 'project-release',
            'name': 'Hotel Theme',
            'kind': 'project',
            'group_id': 'workspace-project-project-release',
            'description': 'Hotel themed events',
            'visibility': 'public',
            'publication_key': 'publication-key',
            'release_id': 'release-1',
            'release_version': 'v1.0.0',
            'release_summary': 'Initial public release',
            'release_publisher_id': 'principal-1',
            'release_publisher_name': 'Alice',
            'released_at': published_at,
            'created_at': published_at,
        }}],
    ])
    store = GraphStore(RuntimeStub(driver), workspace_settings())

    project = await store.create_space(
        {'id': 'principal-1', 'name': 'Alice'},
        SpaceCreate.model_validate({
            'name': 'Hotel Theme',
            'kind': 'project',
            'publication_key': 'publication-key',
            'release': {'version': 'v1.0.0', 'summary': 'Initial public release'},
        }),
    )

    query, parameters = driver.calls[1]
    assert 'FuliProjectRelease' in query
    assert 'HAS_RELEASE' in query
    assert parameters['version'] == 'v1.0.0'
    assert parameters['summary'] == 'Initial public release'
    assert parameters['publisher_name'] == 'Alice'
    assert project.current_release.version == 'v1.0.0'
    assert project.current_release.publisher_name == 'Alice'
    assert project.current_release.published_at == published_at


@pytest.mark.asyncio
async def test_project_owner_or_provider_admin_can_delete_public_project_graph():
    driver = SequentialDriver([
        [{'name': 'Hotel Theme', 'group_id': 'workspace-project-hotel-theme'}],
        [],
    ])
    store = GraphStore(RuntimeStub(driver), workspace_settings())

    result = await store.delete_project(
        {'id': 'principal-1', 'provider_admin': False},
        'hotel-theme',
    )

    authorization_query, authorization_parameters = driver.calls[0]
    deletion_query, deletion_parameters = driver.calls[1]
    assert 'provider administrator required' not in authorization_query
    assert authorization_parameters['provider_admin'] is False
    assert 'artifact.group_id = $group_id' in deletion_query
    assert 'DETACH DELETE space' in deletion_query
    assert deletion_parameters['group_id'] == 'workspace-project-hotel-theme'
    assert result.deleted is True


@pytest.mark.asyncio
async def test_workspace_catalog_lists_public_projects_for_non_members_as_readers():
    created_at = datetime(2026, 7, 21, tzinfo=timezone.utc)
    driver = RecordingDriver([{
        's': {
            'id': 'project-2',
            'name': 'Activity Platform',
            'kind': 'project',
            'group_id': 'workspace-project-project-2',
            'description': None,
            'visibility': 'public',
            'created_at': created_at,
        },
        'owner_id': 'principal-owner',
        'role': 'reader',
    }])
    store = GraphStore(RuntimeStub(driver), workspace_settings())

    projects = await store.list_spaces({'id': 'principal-reader'})

    query, _ = driver.calls[0]
    assert "MATCH (s:FuliSpace {kind: 'project', visibility: 'public'})" in query
    assert projects[0].owner_id == 'principal-owner'
    assert projects[0].role == 'reader'


@pytest.mark.asyncio
async def test_personal_project_profile_is_stored_inside_the_personal_graph_boundary():
    created_at = datetime(2026, 7, 21, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{'space': {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }, 'role': 'maintainer'}],
        [{'project': {
            'id': 'personal-project-node',
            'project_id': 'hotel-theme',
            'publication_key': 'publication-key',
            'profile_json': '{"name":"Hotel Theme","lifecycle":"active","sources":[],"boundaries":[]}',
            'created_at': created_at,
            'updated_at': created_at,
        }}],
    ])
    store = GraphStore(RuntimeStub(driver), personal_settings())

    result = await store.upsert_personal_project(
        {'id': 'principal-1'},
        PersonalProjectUpsert.model_validate({
            'personal_space_id': 'personal-space',
            'project_id': 'hotel-theme',
            'profile': {'name': 'Hotel Theme', 'lifecycle': 'active'},
        }),
    )

    query, parameters = driver.calls[1]
    assert 'FuliPersonalProject' in query
    assert 'CONTAINS_PROJECT' in query
    assert parameters['personal_space_id'] == 'personal-space'
    assert result.project_id == 'hotel-theme'
    assert result.profile.name == 'Hotel Theme'


@pytest.mark.asyncio
async def test_part_of_relation_waits_for_parent_project_confirmation():
    created_at = datetime(2026, 7, 21, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{'space': {'id': 'hotel-theme'}, 'role': 'maintainer'}],
        [{'target': {'id': 'activity-platform'}}],
        [],
        [{'relation': {
            'id': 'relation-1',
            'source_project_id': 'hotel-theme',
            'target_project_id': 'activity-platform',
            'relation_type': 'PART_OF',
            'status': 'pending',
            'note': None,
            'created_by': 'principal-1',
            'created_at': created_at,
        }}],
    ])
    store = GraphStore(RuntimeStub(driver), workspace_settings())

    relation = await store.create_project_relation(
        {'id': 'principal-1'},
        'hotel-theme',
        ProjectRelationCreate(
            target_project_id='activity-platform',
            relation_type='PART_OF',
        ),
    )

    _, parameters = driver.calls[-1]
    assert parameters['relation_status'] == 'pending'
    assert relation.status == 'pending'


@pytest.mark.asyncio
async def test_dependency_relation_is_active_without_target_confirmation():
    created_at = datetime(2026, 7, 21, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{'space': {'id': 'hotel-theme'}, 'role': 'maintainer'}],
        [{'target': {'id': 'shared-platform'}}],
        [{'relation': {
            'id': 'relation-2',
            'source_project_id': 'hotel-theme',
            'target_project_id': 'shared-platform',
            'relation_type': 'DEPENDS_ON',
            'status': 'active',
            'note': None,
            'created_by': 'principal-1',
            'created_at': created_at,
        }}],
    ])
    store = GraphStore(RuntimeStub(driver), workspace_settings())

    relation = await store.create_project_relation(
        {'id': 'principal-1'},
        'hotel-theme',
        ProjectRelationCreate(
            target_project_id='shared-platform',
            relation_type='DEPENDS_ON',
        ),
    )

    assert relation.status == 'active'
    assert driver.calls[-1][1]['relation_status'] == 'active'


class RecordingDriver:
    def __init__(self, records):
        self.records = records
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.records, None, None


class SequentialDriver:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return next(self.responses), None, None


class RuntimeStub:
    def __init__(self, driver):
        self.driver = driver
        self.embedder = EmbedderStub()


class EmbedderStub:
    async def create_batch(self, values):
        return [[float(len(value))] for value in values]


def workspace_settings():
    return Settings(
        provider_mode='workspace',
        provider_id='workspace',
        bootstrap_token='bootstrap-token-with-24-chars',
        neo4j_password='password-123',
    )


def personal_settings():
    return Settings(
        provider_mode='personal',
        provider_id='personal',
        bootstrap_token='bootstrap-token-with-24-chars',
        neo4j_password='password-123',
    )
