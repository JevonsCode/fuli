"""Regression evidence for the source-bound working-memory ruling (rec#34).

These exercise the actual checkpoint/memory writers and source-delete route.
Only the explicitly disposable test database is permitted.
"""
from uuid import uuid4
import json
import asyncio

import pytest

from test_knowledge_hard_delete_neo4j import reviewed
from test_project_agent_memory_neo4j import provider_client, seed_agent
from test_source_delete_integration_neo4j import capture, source_preview, source_delete
from test_turn_receipt_neo4j import ok, space_with_projects
from test_negative_feedback_block_neo4j import query
from test_knowledge_hard_delete_neo4j import REVIEW


async def memory_write(client, space, revision, session, summary, **changes):
    payload = dict(personal_space_id=space,
        personal_project_id='memory-source-project', agent_id='engineer', source_application='codex',
        source_session_id=session, expected_revision=revision, idempotency_key=str(uuid4()),
        memory=dict(summary=summary))
    return await client.put(f'/v1/project-agents/{changes.get("agent_id", "engineer")}/memory', json={**payload, **changes})


async def memory_read(client, space):
    return ok(await client.get('/v1/project-agents/engineer/memory', params=dict(
        personal_space_id=space, personal_project_id='memory-source-project', limit=10)))


@pytest.mark.asyncio
async def test_deleted_source_cannot_reappear_in_its_exact_checkpoint_memory_copy():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        session, token = 'memory-source-session', 'fuli-task-' + uuid4().hex
        marker = 'Synthetic source body copied into working memory ' + uuid4().hex
        old = ok(await memory_write(client, space, 0, 'older-session', 'Synthetic older memory'))
        ok(await client.put('/v1/task-contexts', json=dict(personal_space_id=space,
            personal_project_id='memory-source-project', project_agent_id='engineer', source_application='codex',
            session_id=session, turn_id='source-turn', token=token)))
        ok(await client.put(f'/v1/task-contexts/{token}/checkpoint', json=dict(personal_space_id=space,
            source_application='codex', phase='prepare', disposition='retain_nothing', reason='Synthetic checkpoint',
            fingerprint='a' * 64, agent_memory=dict(expected_revision=1, memory=dict(summary=marker)))))
        saved, _ = await capture(client, space, session, 'source-turn',
            [dict(key='source', name='Synthetic source item', type='ProjectFact')], source_excerpt=marker)
        plan = ok(await source_preview(client, space, saved['episode_id']))
        assert plan['agent_memory']['scrubbed'][0]['revisions'] == [2]
        assert plan['agent_memory']['scrubbed'][0]['current'] is True
        receipt = ok(await source_delete(client, space, saved['episode_id'], plan))
        memory = await memory_read(client, space)
        assert marker not in str(memory), 'Source-bound checkpoint copy remains publicly readable after source deletion'
        assert memory['revision'] == memory['current']['revision'] == 2
        assert memory['current']['memory_state'] == 'scrubbed' and memory['current']['memory'] is None
        assert memory['history'][1] == old
        assert memory['current']['scrubbed_by'] == receipt['deletion_id']
        assert not set(memory['current']).intersection({'source_application', 'source_session_id', 'task_id', 'payload_hash'})
        assert memory['work_log'][0]['task_context_token'] == token
        assert memory['work_log'][0]['summary'] == 'Work summary cleared with its source.'
        rows = await query(settings, 'MATCH (t:FuliTaskContext {token:$token}) RETURN properties(t) AS task', token=token)
        assert len(rows) == 1 and rows[0]['task']['token'] == token
        assert marker not in str(rows) and 'Synthetic checkpoint' not in str(rows)
        replay = await client.put('/v1/project-agents/engineer/memory', json=dict(personal_space_id=space,
            personal_project_id='memory-source-project', agent_id='engineer', source_application='codex',
            source_session_id=session, expected_revision=1, idempotency_key=f'{token}:memory', memory=dict(summary=marker)))
        assert replay.status_code == 410
        late_checkpoint = await client.put(f'/v1/task-contexts/{token}/checkpoint', json=dict(personal_space_id=space,
            source_application='codex', phase='prepare', disposition='retain_nothing', reason='Synthetic late checkpoint',
            fingerprint='b' * 64, agent_memory=dict(expected_revision=2, memory=dict(summary=marker))))
        assert late_checkpoint.status_code == 410
        continued = ok(await memory_write(client, space, 2, 'next-session', 'Synthetic next memory'))
        assert continued['revision'] == 3
        traces = ok(await client.post('/v1/knowledge/hard-deletions', headers=REVIEW, json={'personal_space_id': space}))
        # Receipts rebuild the fixed erased revisions, with the head's latest revision.
        assert traces[0]['memory_scopes'] == [{**receipt['memory_scopes'][0], 'current_revision': 3}]


@pytest.mark.asyncio
async def test_deleted_session_rejects_late_standalone_memory_write():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        session = 'deleted-memory-session'
        saved, _ = await capture(client, space, session, 'source-turn',
            [dict(key='source', name='Synthetic source item', type='ProjectFact')])
        store = client._transport.app.state.store
        target = store._task_session_id(space, 'codex', session)
        identity = dict(source_application='codex', fuli_session_id=session)
        plan = ok(await source_preview(client, space, target, 'session', **identity))
        ok(await source_delete(client, space, target, plan, **identity))
        late = await client.put('/v1/project-agents/engineer/memory', json=dict(personal_space_id=space,
            personal_project_id='memory-source-project', agent_id='engineer', source_application='codex',
            source_session_id=session, expected_revision=0, idempotency_key='synthetic-late-memory',
            memory=dict(summary='Synthetic late source copy')))
        assert late.status_code == 410, late.text


@pytest.mark.asyncio
@pytest.mark.parametrize('include_later', [False, True])
async def test_session_scrubs_exact_tuple_and_optional_later_revisions_without_rewinding(include_later):
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex', 'cursor'])
        session = 'exact-memory-session'
        before = ok(await memory_write(client, space, 0, 'earlier', 'Synthetic older words'))
        own = ok(await memory_write(client, space, 1, session, 'Synthetic exact source words'))
        after = ok(await memory_write(client, space, 2, 'later', 'Synthetic later derived words'))
        # Same session ID in another client is a distinct source tuple.
        other_client = ok(await client.put('/v1/project-agents/engineer/memory', json=dict(personal_space_id=space,
            personal_project_id='memory-source-project', agent_id='engineer', source_application='cursor',
            source_session_id=session, expected_revision=3, idempotency_key=str(uuid4()),
            memory=dict(summary='Synthetic other client words'))))
        saved, _ = await capture(client, space, session, 'source-turn', [dict(key='source', name='Synthetic memory source', type='ProjectFact')])
        store = client._transport.app.state.store
        target = store._task_session_id(space, 'codex', session)
        identity = dict(source_application='codex', fuli_session_id=session)
        preview = ok(await source_preview(client, space, target, 'session', **identity))
        assert [{k: v for k, v in row.items() if k != 'agent_name'} for row in preview['agent_memory']['scrubbed']] == [dict(agent_id='engineer', personal_project_id='memory-source-project',
            revisions=[2], current=False, current_revision=4)]
        assert preview['agent_memory']['scrubbed'][0]['agent_name']
        later = preview['agent_memory']['later'][0]
        assert later['from_revision'] == 2 and later['revisions'] == [3, 4] and not later['selected']
        selection = dict(include=[later['key']]) if include_later else {}
        selected = ok(await source_preview(client, space, target, 'session', **identity, **selection))
        assert (selected['preview_id'] != preview['preview_id']) == include_later
        receipt = ok(await source_delete(client, space, target, selected, **identity, **selection))
        assert receipt['counts']['memory_checkpoints'] == 1
        assert receipt['counts']['memory_later_revisions'] == (2 if include_later else 0)
        memory = await memory_read(client, space)
        assert memory['revision'] == 4
        assert memory['history'][3] == before
        assert memory['history'][2]['memory'] is None
        if include_later:
            assert all(row['memory_state'] == 'scrubbed' for row in memory['history'][:3])
        else:
            assert memory['history'][:2] == [other_client, after]
        raw = await query(settings, 'MATCH (h:FuliProjectAgentMemory {personal_space_id:$space})-[:HAS_MEMORY_CHECKPOINT]->(c) RETURN properties(c) AS checkpoint', space=space)
        erased = [row['checkpoint'] for row in raw if row['checkpoint'].get('scrubbed_by') == receipt['deletion_id']]
        assert len(erased) == (3 if include_later else 1)
        assert all('payload_hash' not in row and 'source_session_id' not in json.loads(row['record_json']) for row in erased)
        assert own['memory']['summary'] not in str(raw)


@pytest.mark.asyncio
async def test_memory_head_change_invalidates_source_preview_before_any_scrub():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        own = ok(await memory_write(client, space, 0, 'stale-session', 'Synthetic untouched words'))
        await capture(client, space, 'stale-session', 'turn', [dict(key='source', name='Synthetic stale source', type='ProjectFact')])
        target = client._transport.app.state.store._task_session_id(space, 'codex', 'stale-session')
        identity = dict(source_application='codex', fuli_session_id='stale-session')
        preview = ok(await source_preview(client, space, target, 'session', **identity))
        ok(await memory_write(client, space, 1, 'another-session', 'Synthetic newer words'))
        refused = await source_delete(client, space, target, preview, **identity)
        assert refused.status_code == 409
        assert (await memory_read(client, space))['history'][1] == own


@pytest.mark.asyncio
async def test_episode_without_exact_turn_task_does_not_clear_session_working_memory():
    async with provider_client(reviewed()) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        own = ok(await memory_write(client, space, 0, 'unmapped-session', 'Synthetic unmapped memory'))
        saved, _ = await capture(client, space, 'unmapped-session', 'unmapped-turn', [dict(key='source', name='Synthetic unmapped source', type='ProjectFact')])
        preview = ok(await source_preview(client, space, saved['episode_id']))
        assert preview['agent_memory'] == {'scrubbed': [], 'later': []}
        ok(await source_delete(client, space, saved['episode_id'], preview))
        assert (await memory_read(client, space))['current'] == own


@pytest.mark.asyncio
async def test_session_memory_scope_is_all_owned_agents_but_not_other_spaces_or_clients():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space, foreign = await space_with_projects(client), await space_with_projects(client)
        for scope in (space, foreign):
            await seed_agent(client, scope, project='memory-source-project', allowed_clients=['codex', 'cursor'])
        await seed_agent(client, space, project='memory-source-project', agent='helper', allowed_clients=['codex'])
        session = 'shared-session-id'
        first = ok(await memory_write(client, space, 0, session, 'Synthetic global source', personal_project_id=None))
        second = ok(await memory_write(client, space, 0, session, 'Synthetic helper source', agent_id='helper'))
        unrelated = ok(await memory_write(client, space, 0, session, 'Synthetic other client', source_application='cursor'))
        foreign_record = ok(await memory_write(client, foreign, 0, session, 'Synthetic other space'))
        await capture(client, space, session, 'turn', [dict(key='source', name='Synthetic scope source', type='ProjectFact')])
        target = client._transport.app.state.store._task_session_id(space, 'codex', session)
        identity = dict(source_application='codex', fuli_session_id=session)
        preview = ok(await source_preview(client, space, target, 'session', **identity))
        assert {(row['agent_id'], row['personal_project_id']) for row in preview['agent_memory']['scrubbed']} == {
            ('engineer', None), ('helper', 'memory-source-project')}
        receipt = ok(await source_delete(client, space, target, preview, **identity))
        assert receipt['counts']['memory_checkpoints'] == 2
        assert (await memory_read(client, space))['current'] == unrelated
        assert (await memory_read(client, foreign))['current'] == foreign_record
        raw = await query(settings, 'MATCH (c:FuliProjectAgentMemoryCheckpoint) WHERE c.id IN $ids RETURN c.record_json AS record',
                          ids=[first['checkpoint_id'], second['checkpoint_id']])
        assert all(json.loads(row['record'])['memory'] is None for row in raw)


@pytest.mark.asyncio
async def test_memory_writer_waits_for_delete_lock_then_observes_session_fence(monkeypatch):
    from fuli_graph import knowledge_source_delete_mutation as mutation
    async with provider_client(reviewed()) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        session = 'racing-memory-session'
        ok(await memory_write(client, space, 0, session, 'Synthetic first copy'))
        await capture(client, space, session, 'turn', [dict(key='source', name='Synthetic race source', type='ProjectFact')])
        target = client._transport.app.state.store._task_session_id(space, 'codex', session)
        identity = dict(source_application='codex', fuli_session_id=session)
        preview = ok(await source_preview(client, space, target, 'session', **identity))
        entered, release = asyncio.Event(), asyncio.Event()
        real_scrub = mutation.scrub_source_memory
        async def paused(*args):
            entered.set()
            await asyncio.wait_for(release.wait(), 10)
            return await real_scrub(*args)
        monkeypatch.setattr(mutation, 'scrub_source_memory', paused)
        deletion = asyncio.create_task(source_delete(client, space, target, preview, **identity))
        writer = None
        try:
            await asyncio.wait_for(entered.wait(), 10)
            writer = asyncio.create_task(memory_write(client, space, 1, session, 'Synthetic forbidden late copy'))
            await asyncio.sleep(0.05)
            assert not writer.done()
            release.set()
            ok(await asyncio.wait_for(deletion, 10))
            assert (await asyncio.wait_for(writer, 10)).status_code == 410
            memory = await memory_read(client, space)
            assert memory['revision'] == 1 and memory['current']['memory_state'] == 'scrubbed'
        finally:
            release.set()
            await asyncio.gather(deletion, *([writer] if writer else []), return_exceptions=True)


@pytest.mark.asyncio
async def test_knowledge_item_delete_does_not_scrub_session_working_memory():
    async with provider_client(reviewed()) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        own = ok(await memory_write(client, space, 0, 'item-only-session', 'Synthetic independently distilled memory'))
        saved, _ = await capture(client, space, 'item-only-session', 'turn',
            [dict(key='source', name='Synthetic knowledge-only deletion', type='ProjectFact')])
        item = saved['entity_ids'][0]
        preview = ok(await source_preview(client, space, item, 'entity'))
        assert [episode['episode_id'] for episode in preview['removed_episodes']] == [saved['episode_id']]
        receipt = ok(await source_delete(client, space, item, preview))
        assert receipt['memory_scopes'] == [] and receipt['counts']['memory_checkpoints'] == 0
        assert (await memory_read(client, space))['current'] == own


@pytest.mark.asyncio
async def test_later_source_deletion_does_not_overwrite_prior_scrubbed_receipt_identity():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='memory-source-project', allowed_clients=['codex'])
        session, token = 'repeated-source-session', 'fuli-task-' + uuid4().hex
        ok(await client.put('/v1/task-contexts', json=dict(personal_space_id=space,
            personal_project_id='memory-source-project', project_agent_id='engineer', source_application='codex',
            session_id=session, turn_id='turn-one', token=token)))
        first = ok(await memory_write(client, space, 0, session, 'Synthetic original memory', idempotency_key=f'{token}:memory'))
        saved, _ = await capture(client, space, session, 'turn-one',
            [dict(key='first', name='Synthetic first source', type='ProjectFact')])
        preview = ok(await source_preview(client, space, saved['episode_id']))
        original = ok(await source_delete(client, space, saved['episode_id'], preview))
        ok(await memory_write(client, space, 1, session, 'Synthetic new turn memory'))
        await capture(client, space, session, 'turn-two', [dict(key='second', name='Synthetic second source', type='ProjectFact')])
        target = client._transport.app.state.store._task_session_id(space, 'codex', session)
        identity = dict(source_application='codex', fuli_session_id=session)
        preview = ok(await source_preview(client, space, target, 'session', **identity))
        assert preview['agent_memory']['scrubbed'][0]['revisions'] == [2]
        second = ok(await source_delete(client, space, target, preview, **identity))
        history = (await memory_read(client, space))['history']
        assert [row['scrubbed_by'] for row in history] == [second['deletion_id'], original['deletion_id']]
        assert history[1]['checkpoint_id'] == first['checkpoint_id']
        traces = ok(await client.post('/v1/knowledge/hard-deletions', headers=REVIEW, json={'personal_space_id': space}))
        assert [row['memory_scopes'][0]['revisions'] for row in traces] == [[1], [2]]
