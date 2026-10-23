from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_source_delete_models import SourceDeleteRef
from fuli_graph.knowledge_source_delete_target import source_delete_target


@pytest.mark.asyncio
async def test_episode_resolves_only_its_stored_provenance_and_legacy_missing_turn_stays_narrow():
    async def query(cypher, **params):
        if 'count(trace)' in cypher:
            return [{'deleted': False}], None, None
        assert params == {'group_id': 'group', 'episode_id': 'episode', 'routing_': 'r'}
        return [{'source_application': 'codex', 'session_id': 'session', 'turn_id': None}], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)),
                            _task_session_id=lambda *parts: ':'.join(parts))
    target = await source_delete_target(store, {'id': 'space', 'group_id': 'group'}, 'episode',
        SourceDeleteRef(personal_space_id='space', item_kind='episode'))
    assert target.item_id == 'episode'
    assert not target.whole_session and not target.exact_turn


@pytest.mark.asyncio
async def test_session_reuses_existing_provider_scoped_task_identity_and_rejects_mismatch_before_reads():
    calls = []
    async def query(cypher, **params):
        calls.append(params)
        return [{'deleted': False}], None, None
    def session_id(*args):
        assert args == ('space', 'codex', 'session')
        return 'existing-task-session'
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)),
                            _task_session_id=session_id)
    request = SourceDeleteRef(personal_space_id='space', item_kind='session',
                             source_application='codex', fuli_session_id='session')
    with pytest.raises(HTTPException) as refused:
        await source_delete_target(store, {'id': 'space'}, 'wrong-id', request)
    assert refused.value.status_code == 409 and calls == []
    target = await source_delete_target(store, {'id': 'space'}, 'existing-task-session', request)
    assert target.whole_session and target.item_id == 'existing-task-session'
    assert calls[0]['keys'] == ['session:existing-task-session']
