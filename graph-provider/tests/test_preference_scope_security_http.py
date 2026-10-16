import os
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


def pending_commit(project_id=None):
    return {
        'space_id': 'personal-space', 'personal_project_id': project_id,
        'episode': {
            'idempotency_key': 'synthetic-preflight-commit', 'session_id': 'synthetic-session',
            'name': 'Synthetic preflight', 'source_kind': 'synthetic_fixture',
            'source_description': 'Synthetic pending evidence.', 'reference_time': '2026-10-16T00:00:00Z',
            'entities': [{'key': 'synthetic-preference', 'name': 'Synthetic preference',
                          'type': 'PersonalPreference', 'profile_aspect': 'taste',
                          'confirmation_status': 'pending'}],
        },
    }


@pytest.mark.asyncio
async def test_commit_preflight_reuses_full_commit_models_and_never_writes():
    application = scope_application(ScopeSecurityDriver(current_scope='global'))

    async def forbid_commit(*_args, **_kwargs):
        raise AssertionError('Read-only preflight must not commit or embed')

    application.state.store._commit_episode = forbid_commit
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url='http://provider.test',
        headers={'authorization': 'Bearer ordinary-agent-token'},
    ) as client:
        valid = [pending_commit('project-a'), pending_commit()]
        response = await client.post('/v1/knowledge/commits/preflight', json=valid)
        assert response.status_code == 200, response.text
        assert response.json() == {'status': 'validated', 'count': 2}
        for kind in ['attributes', 'inheritance']:
            invalid = pending_commit()
            entity = invalid['episode']['entities'][0]
            if kind == 'attributes':
                entity['attributes'] = {f'fixture{i}': 'synthetic' for i in range(33)}
            else:
                entity.update(inheritance_mode='selected_projects', inherited_project_ids=[])
            # Both endpoints accept the same KnowledgeCommit model, including
            # rules the MCP schema deliberately does not duplicate.
            for path, payload in [('/v1/knowledge/commits/preflight', [valid[0], invalid]),
                                  ('/v1/knowledge/commits', invalid)]:
                rejected = await client.post(path, json=payload)
                assert rejected.status_code == 422, rejected.text
        for invalid_size in [[], valid + [valid[0]]]:
            rejected = await client.post('/v1/knowledge/commits/preflight', json=invalid_size)
            assert rejected.status_code == 422, rejected.text


@pytest.mark.asyncio
async def test_commit_preflight_checks_the_same_personal_space_and_project_access_as_commit():
    driver = ScopeSecurityDriver(current_scope='global')
    execute = driver.execute_query

    async def project_access(query, **parameters):
        if parameters.get('project_id') == 'foreign-project':
            return [], None, None
        return await execute(query, **parameters)

    driver.execute_query = project_access
    application = scope_application(driver)

    async def space_access(_actor, space_id, _role):
        if space_id != 'personal-space':
            raise HTTPException(status_code=403, detail='Synthetic foreign space')
        return {'id': space_id, 'kind': 'personal', 'group_id': 'personal-group'}

    application.state.store.authorize = space_access
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url='http://provider.test',
        headers={'authorization': 'Bearer ordinary-agent-token'},
    ) as client:
        for changes, status in [({'space_id': 'foreign-space'}, 403),
                                ({'personal_project_id': 'foreign-project'}, 404)]:
            invalid = {**pending_commit(), **changes}
            for path, payload in [('/v1/knowledge/commits/preflight', [pending_commit(), invalid]),
                                  ('/v1/knowledge/commits', invalid)]:
                rejected = await client.post(path, json=payload)
                assert rejected.status_code == status, rejected.text
    assert driver.scope_updates == []
    assert driver.human_audit_writes == 0


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
