import os
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


@pytest.mark.asyncio
async def test_mock_actor_cannot_forge_human_project_to_global_scope_expansion():
    driver = ScopeSecurityDriver(current_scope='project')
    application = scope_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer ordinary-agent-token'},
    ) as client:
        response = await client.post(
            '/v1/knowledge/items/entity-profile/preference-scope',
            json={
                'personal_space_id': 'personal-space',
                'item_kind': 'entity',
                'scope': 'global',
                'project_id': None,
                'reason': 'Forged payload claims a human approved expansion.',
                'operation_actor': 'human',
            },
        )

    assert response.status_code == 403, response.text
    assert driver.scope_updates == []
    assert driver.human_audit_writes == 0


@pytest.mark.asyncio
async def test_mock_actor_cannot_move_project_scope_laterally_or_request_descendants():
    driver = ScopeSecurityDriver(current_scope='project')
    application = scope_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer ordinary-agent-token'},
    ) as client:
        lateral = await client.post(
            '/v1/knowledge/items/entity-profile/preference-scope',
            json={
                'personal_space_id': 'personal-space',
                'item_kind': 'entity',
                'scope': 'project',
                'project_id': 'project-b',
                'reason': 'Attempted lateral move.',
                'operation_actor': 'human',
            },
        )
        descendants = await client.post(
            '/v1/knowledge/items/entity-profile/preference-scope',
            json={
                'personal_space_id': 'personal-space',
                'item_kind': 'entity',
                'scope': 'descendants',
                'project_id': 'parent-a',
                'reason': 'Attempted direct parent expansion.',
                'operation_actor': 'human',
            },
        )

    assert lateral.status_code == 403, lateral.text
    assert descendants.status_code == 422, descendants.text
    assert driver.scope_updates == []
    assert driver.human_audit_writes == 0


@pytest.mark.asyncio
async def test_mock_direct_endpoint_only_narrows_global_to_one_exact_project():
    driver = ScopeSecurityDriver(current_scope='global')
    application = scope_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer ordinary-agent-token'},
    ) as client:
        response = await client.post(
            '/v1/knowledge/items/entity-profile/preference-scope',
            json={
                'personal_space_id': 'personal-space',
                'item_kind': 'entity',
                'scope': 'project',
                'project_id': 'project-b',
                'reason': 'Restrict this preference to one exact project.',
                'operation_actor': 'human',
            },
        )

    assert response.status_code == 200, response.text
    assert driver.scope_updates == [{
        'scope': 'project',
        'project_id': 'project-b',
    }]
    assert driver.human_audit_writes == 0


def scope_application(driver):
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({
        'id': 'principal-1',
        'name': 'Ordinary bearer principal',
    })
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })
    return application


class ScopeSecurityDriver:
    def __init__(self, *, current_scope):
        self.current_scope = current_scope
        self.scope_updates = []
        self.human_audit_writes = 0

    async def execute_query(self, query, **parameters):
        if 'RETURN project' in query:
            return [{
                'project': {'project_id': parameters['project_id']},
            }], None, None
        if 'RETURN item.name AS name' in query:
            return [{
                'name': 'Preference',
                'type': 'PersonalPreference',
                'summary': 'A bounded personal preference.',
                'invalid_at': None,
                'profile_aspect': 'taste',
                'preference_scope': self.current_scope,
                'preference_project_id': (
                    'project-a' if self.current_scope == 'project' else None
                ),
                'inheritance_mode': 'local_only',
                'inherited_project_ids': [],
            }], None, None
        if 'SET item.fuli_preference_scope = $scope' in query:
            self.scope_updates.append({
                'scope': parameters['scope'],
                'project_id': parameters['project_id'],
            })
            return [], None, None
        if 'CREATE (revision:FuliKnowledgeRevision' in query:
            return [], None, None
        if 'FuliKnowledgeAudit' in query:
            self.human_audit_writes += 1
            return [{'human_change_version': 1}], None, None
        raise AssertionError(f'Unexpected query: {query[:120]}')


def async_value(value):
    async def resolve(*_args, **_kwargs):
        return value

    return resolve
