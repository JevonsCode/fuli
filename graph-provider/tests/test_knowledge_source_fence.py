from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_source_fence import require_source_available


@pytest.mark.asyncio
async def test_source_fence_points_at_exact_episode_session_and_returns_no_deleted_id():
    async def query(cypher, **params):
        assert params['keys'] == ['episode:episode', 'session:space:codex:session']
        assert params['space_id'] == 'space'
        assert 'RETURN count(trace) > 0 AS deleted' in cypher
        return [{'deleted': True}], None, None

    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)),
                            _task_session_id=lambda *parts: ':'.join(parts))
    with pytest.raises(HTTPException) as rejected:
        await require_source_available(store, {'id': 'space'}, episode_id='episode',
                                       source_application='codex', session_id='session')
    assert rejected.value.status_code == 410
    assert rejected.value.detail == {'code': 'source_hard_deleted'}


@pytest.mark.asyncio
async def test_changed_capture_id_cannot_recreate_a_deleted_full_source_turn():
    async def query(cypher, **params):
        assert params['episode_id'] == 'new-capture-id'
        assert params['source_turn_key']
        assert 'trace.deleted_source_turn_keys' in cypher
        return [{'deleted': True}], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)),
                            _task_session_id=lambda *parts: ':'.join(parts))
    with pytest.raises(HTTPException) as rejected:
        await require_source_available(store, {'id': 'space'}, episode_id='new-capture-id',
            source_application='codex', session_id='session', source_turn_id='deleted-turn')
    assert rejected.value.status_code == 410
    assert rejected.value.detail == {'code': 'source_hard_deleted'}
