"""Destructive source membership never uses recency or page limits."""
import json
from types import SimpleNamespace

import pytest

from fuli_graph.knowledge_source_delete_inventory import source_delete_inventory
from fuli_graph.knowledge_source_delete_target import SourceDeleteTarget


@pytest.mark.asyncio
@pytest.mark.parametrize('scope', ['episode', 'session'])
async def test_source_inventory_uses_scoped_tasks_checkpoint_ids_and_client_identity_without_limits(scope):
    calls = []

    async def query(cypher, **parameters):
        calls.append((cypher, parameters))
        assert 'LIMIT ' not in cypher
        if 'RETURN task.id' in cypher:
            assert parameters['session_node'] == 'space:codex:host'
            assert parameters['turn_id'] == ('turn-1' if scope == 'episode' else None)
            assert parameters['whole_session'] == (scope == 'session')
            return ([{'id': 'task', 'token': 'token', 'turn_id': 'turn-1', 'project_id': None,
                      'agent_id': 'agent', 'record_json': json.dumps({'checkpoint': {'capture_results': [
                          {'status': 'committed', 'episode_id': 'saved'},
                          {'status': 'committed', 'episode_id': 'legacy-capture-without-turn-field'},
                          {'status': 'failed', 'episode_id': 'failed'}]}})}], None, None)
        if 'RETURN episode ORDER' in cypher:
            assert parameters['episode_ids'] == ['legacy-capture-without-turn-field', 'saved']
            assert parameters['source_application'] == 'codex'
            assert parameters['session_id'] == 'host'
            return ([{'episode': {'uuid': 'saved', 'fuli_source_excerpt': 'Synthetic source'}}], None, None)
        if 'RETURN event.id' in cypher:
            assert parameters['tokens'] == ['token']
            assert len(parameters['scopes']) == 1
            assert parameters['whole_session'] == (scope == 'session')
            assert parameters['source_application'] == 'codex'
            assert parameters['session_id'] == 'host'
            assert 'event.source_application = $source_application' in cypher
            return ([{'id': 'event', 'digest': 'content-digest', 'conversation_id': 'conversation',
                      'conversation_revision': 4}], None, None)
        raise AssertionError(cypher)

    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)),
                            _task_session_id=lambda *values: ':'.join(values))
    result = await source_delete_inventory(store, {'id': 'space', 'group_id': 'group'},
                  SourceDeleteTarget(scope, 'saved', 'codex', 'host', 'turn-1' if scope == 'episode' else None))
    assert result['task_ids'] == ['task']
    assert result['event_ids'] == ['event']
    assert result['conversation_ids'] == ['conversation']
    assert result['event_versions'] == [['event', 'content-digest']]
    assert result['conversation_versions'] == [('conversation', 4)]
    assert len(result['task_versions'][0][1]) == 64
    assert 'record_json' not in repr(result)
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_legacy_episode_without_turn_never_widens_into_whole_session():
    async def query(cypher, **params):
        if 'RETURN task.id' in cypher or 'RETURN episode ORDER' in cypher:
            assert params['whole_session'] is False
            assert params['exact_turn'] is False
            assert '$turn_id IS NULL' not in cypher
        if 'RETURN episode ORDER' in cypher:
            assert params['episode_ids'] == ['legacy-episode']
            return [{'episode': {'uuid': 'legacy-episode'}}], None, None
        return [], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)),
                            _task_session_id=lambda *values: ':'.join(values))
    result = await source_delete_inventory(store, {'id': 'space', 'group_id': 'group'},
        SourceDeleteTarget('episode', 'legacy-episode', 'codex', 'session'))
    assert result['task_ids'] == result['event_ids'] == []
    assert result['episodes'] == [{'uuid': 'legacy-episode'}]
