"""Workspace reconciliation reveals only the caller's submission identity/status."""
from fastapi import HTTPException
import pytest

from test_publication_source_http import setup, client_for
from fuli_graph.provider_values import stable_uuid


@pytest.mark.asyncio
async def test_lookup_scopes_to_contributor_and_returns_no_body():
    app, _, _, _ = setup()
    store = app.state.store
    store._require_workspace = lambda: None
    role = 'contributor'
    principal = {}

    async def authorize(actor, project_id, required):
        assert project_id == 'project' and required == 'contributor'
        principal.update(actor)
        if role == 'reader':
            raise HTTPException(403)

    async def query(cypher, **params):
        assert 'submitted_by: $actor_id' in cypher
        assert params['actor_id'] == principal['id']
        expected = stable_uuid(store.settings.provider_id, 'project', principal['id'], 'mine')
        return ([{'id': expected, 'status': 'pending'}] if params['id'] == expected else [], None, None)

    store.authorize = authorize
    store.runtime.driver.execute_query = query
    async with client_for(app) as client:
        found = await client.get('/v1/projects/project/proposals/lookup', params={'idempotency_key': 'mine'})
        assert found.status_code == 200
        assert set(found.json()) == {'id', 'status'}
        missing = await client.get('/v1/projects/project/proposals/lookup', params={'idempotency_key': 'another'})
        assert missing.status_code == 200 and missing.json() is None
        role = 'reader'
        refused = await client.get('/v1/projects/project/proposals/lookup', params={'idempotency_key': 'mine'})
        assert refused.status_code == 403
