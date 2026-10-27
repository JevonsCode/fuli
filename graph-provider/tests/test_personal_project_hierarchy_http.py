"""The parent-change route: human-review proof, validation and the write it sends.

A synthetic driver answers the hierarchy read and records the move; the real
Cypher runs in test_personal_project_hierarchy_neo4j.py.
"""

import os
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings

REVIEW_TOKEN = 'test-hierarchy-review-token-0123456789'

# platform <- app <- mobile (active); app -> docs PART_OF was declined earlier.
HIERARCHY = [
    {'project_id': 'platform', 'relation_id': None, 'parent_project_id': None, 'status': None, 'decision_revision': 0},
    {'project_id': 'docs', 'relation_id': None, 'parent_project_id': None, 'status': None, 'decision_revision': 0},
    {'project_id': 'app', 'relation_id': 'app-platform', 'parent_project_id': 'platform', 'status': 'active',
     'decision_revision': 1},
    {'project_id': 'app', 'relation_id': 'app-docs', 'parent_project_id': 'docs', 'status': 'rejected',
     'decision_revision': 4},
    {'project_id': 'mobile', 'relation_id': 'mobile-app', 'parent_project_id': 'app', 'status': 'active',
     'decision_revision': 1},
]


class HierarchyDriver:
    def __init__(self, write_rows=True):
        self.writes = []
        self.write_rows = write_rows

    async def execute_query(self, query, **parameters):
        if 'fuli:read-personal-project-hierarchy' in query:
            return HIERARCHY, None, None
        if 'fuli:move-personal-project' in query:
            self.writes.append(parameters)
            return ([{'project_id': parameters['project_id']}] if self.write_rows else []), None, None
        raise AssertionError(f'Unexpected query: {query[:120]}')


def application(driver):
    app = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        human_review_token=REVIEW_TOKEN,
        neo4j_password='test-password',
    ))
    store = app.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({'id': 'personal-space', 'kind': 'personal', 'group_id': 'personal-group'})
    return app


async def move(app, project_id, parent, headers={'x-fuli-human-review-token': REVIEW_TOKEN}):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        return await client.post(
            f'/v1/personal-spaces/personal-space/projects/{project_id}/parent',
            json={'parent_project_id': parent, 'reason': 'Synthetic reorganization.'},
            headers=headers,
        )


@pytest.mark.asyncio
async def test_only_the_person_on_the_review_channel_moves_a_project():
    driver = HierarchyDriver()
    response = await move(application(driver), 'app', 'docs', headers={})
    assert response.status_code == 403, response.text
    assert driver.writes == []


@pytest.mark.asyncio
async def test_a_move_ends_the_current_parent_and_reactivates_the_declined_relation():
    driver = HierarchyDriver()
    response = await move(application(driver), 'app', 'docs')
    assert response.status_code == 200, response.text
    assert response.json() == {'personal_space_id': 'personal-space', 'project_id': 'app',
                               'parent_project_id': 'docs', 'previous_parent_project_ids': ['platform'],
                               'changed': True}
    [write] = driver.writes
    assert write['retire_ids'] == ['app-platform']
    assert write['retire_revisions'] == {'app-platform': 2}
    assert write['expected_active'] == ['app-platform@1']
    assert write['attach']['relation_id'] == 'app-docs', 'the earlier relation, not a second one'
    assert (write['attach']['expected_revision'], write['attach']['next_revision']) == (4, 5)
    assert write['reviewed_by'] == 'principal-1'


@pytest.mark.asyncio
async def test_a_move_to_the_top_level_only_ends_the_parent():
    driver = HierarchyDriver()
    response = await move(application(driver), 'app', None)
    assert response.status_code == 200, response.text
    [write] = driver.writes
    assert write['retire_ids'] == ['app-platform']
    assert write['attach'] is None


@pytest.mark.asyncio
async def test_a_move_to_the_current_parent_writes_nothing():
    driver = HierarchyDriver()
    response = await move(application(driver), 'app', 'platform')
    assert response.status_code == 200, response.text
    assert response.json()['changed'] is False
    assert driver.writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize(('project_id', 'parent', 'status', 'code'), [
    ('platform', 'mobile', 409, 'project_hierarchy_cycle'),
    ('app', 'mobile', 409, 'project_hierarchy_cycle'),
    ('app', 'app', 422, 'project_hierarchy_self'),
    ('app', 'missing', 404, 'parent_not_found'),
    ('missing', 'app', 404, 'project_not_found'),
])
async def test_a_move_that_breaks_the_hierarchy_is_refused(project_id, parent, status, code):
    driver = HierarchyDriver()
    response = await move(application(driver), project_id, parent)
    assert response.status_code == status, response.text
    assert response.json()['detail']['code'] == code
    assert driver.writes == []


@pytest.mark.asyncio
async def test_a_hierarchy_changed_during_the_move_is_a_conflict():
    driver = HierarchyDriver(write_rows=False)
    response = await move(application(driver), 'app', 'docs')
    assert response.status_code == 409, response.text
    assert response.json()['detail']['code'] == 'project_hierarchy_changed'


def async_value(value):
    async def resolve(*_args, **_kwargs):
        return value

    return resolve
