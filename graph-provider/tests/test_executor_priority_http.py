import os
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


class PriorityDriver:
    def __init__(self):
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        timestamp = datetime.now(UTC)
        return [
            {
                'executor': {
                    'executor_id': 'claude-candidate',
                    'display_name': 'Claude candidate',
                    'executor_kind': 'claude-code',
                    'registration_status': 'registered',
                    'preflight_status': 'passed',
                    'health_status': 'healthy',
                    'health_required': False,
                    'workspace_permission': True,
                    'capabilities': ['coding'],
                    'available_models_json': '[]',
                    'global_priority': 10,
                    'revision': 1,
                    'registered_at': timestamp,
                    'updated_at': timestamp,
                },
                'permission': {
                    'status': 'authorized',
                    'revision': 0,
                },
            },
        ], None, None


@pytest.mark.asyncio
async def test_priority_update_accepts_personal_space_id_over_public_http():
    driver = PriorityDriver()
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)

    async def authenticate(token):
        assert token == 'test-access-token'
        return {'id': 'principal-1'}

    async def authorize(actor, personal_space_id, role):
        assert actor == {'id': 'principal-1'}
        assert (personal_space_id, role) == ('personal-space', 'maintainer')
        return {
            'id': personal_space_id,
            'kind': 'personal',
            'group_id': 'personal-group',
        }

    store.authenticate = authenticate
    store.authorize = authorize

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.patch(
            '/v1/executors/priority',
            json={
                'personal_space_id': 'personal-space',
                'executor_id': 'claude-candidate',
                'global_priority': 10,
                'expected_revision': 0,
                'idempotency_key': 'priority-1',
                'reason': 'Prefer the Claude candidate.',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    assert response.json()['global_priority'] == 10
    assert driver.calls[0][1]['personal_space_id'] == 'personal-space'
    assert driver.calls[0][1]['executor_id'] == 'claude-candidate'
