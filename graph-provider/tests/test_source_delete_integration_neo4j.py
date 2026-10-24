"""Source deletion through the production human-review HTTP transaction.

Only synthetic data in an explicitly opted-in disposable Neo4j; no remote or
model calls. The real writers prove the final source fence, not a fake driver.
"""
import json
import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest

from fuli_graph.models import StructuredEpisode
from fuli_graph.provider_values import now_utc
from test_knowledge_hard_delete_neo4j import REVIEW, reviewed, status
from test_models import confirmed_episode
from test_negative_feedback_block_neo4j import query
from test_project_agent_memory_neo4j import provider_client, seed_agent
from test_turn_receipt_neo4j import ok, space_with_projects, view


async def source_preview(client, space, target, kind='episode', **selection):
    return await client.post(f'/v1/knowledge/items/{target}/hard-delete/preview', headers=REVIEW,
        json=dict(personal_space_id=space, item_kind=kind, **selection))


async def source_delete(client, space, target, plan, operation=None, **selection):
    return await client.post(f'/v1/knowledge/items/{target}/hard-delete', headers=REVIEW,
        json=dict(personal_space_id=space, item_kind=plan['item_kind'], preview_id=plan['preview_id'],
                  confirmation='删除', operation_id=operation or str(uuid4()), **selection))


async def capture(client, space, session, turn, entities, **fields):
    episode = StructuredEpisode.model_validate(confirmed_episode(idempotency_key=str(uuid4()),
        source_application='codex', session_id=session, source_turn_id=turn,
        entities=entities, relationships=[], **fields)).model_dump(mode='json')
    return ok(await client.post('/v1/knowledge/commits', json={'space_id': space, 'episode': episode})), episode


@pytest.mark.asyncio
async def test_episode_selection_retains_multiple_sources_and_holds_unchecked_sole_basis():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        sole = dict(key='sole', name='Synthetic sole conclusion', type='ProjectFact')
        multi = dict(key='multi', name='Synthetic shared conclusion', type='ProjectFact')
        first, _ = await capture(client, space, 'source-session', 'turn-1', [sole, multi])
        other, _ = await capture(client, space, 'other-session', 'turn-2', [multi])
        sole_id, multi_id = first['entity_ids']
        plan = ok(await source_preview(client, space, first['episode_id']))
        assert [item['key'] for item in plan['default_items']] == ['entity:' + sole_id]
        assert [(item['key'], item['source_count'], item['retained_source_count'])
                for item in plan['affected_items']] == [('entity:' + multi_id, 2, 1)]
        selection = dict(exclude=['entity:' + sole_id])
        chosen = ok(await source_preview(client, space, first['episode_id'], **selection))
        assert chosen['preview_id'] != plan['preview_id']
        stale = await source_delete(client, space, first['episode_id'], plan, **selection)
        assert stale.status_code == 409
        done = ok(await source_delete(client, space, first['episode_id'], chosen, **selection))
        assert done['deleted_item_ids'] == [first['episode_id']]
        held = await view(client, space, sole_id)
        retained = await view(client, space, multi_id)
        assert held['basis_review'] == 'changed' and held['unavailable_sources'][0]['episode_id'] == first['episode_id']
        assert retained['basis_review'] is None
        assert [row['episode_id'] for row in retained['evidence']] == [other['episode_id']]
        assert (await status(client, space, first['episode_id'], 'episode')).json()['state'] == 'deleted'


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['episode', 'session'])
async def test_source_delete_refuses_reserved_drafts_then_scrubs_expired_unknown_and_fences_final_writers(kind):
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        await seed_agent(client, space, project='source-project', allowed_clients=['codex'])
        store = client._transport.app.state.store
        session, turn, token = 'synthetic-session', 'turn-1', 'fuli-task-' + uuid4().hex
        begin = dict(personal_space_id=space, personal_project_id='source-project', project_agent_id='engineer',
                     source_application='codex', session_id=session, turn_id=turn, token=token)
        ok(await client.put('/v1/task-contexts', json=begin))
        journal = dict(personal_space_id=space, personal_project_id='source-project', agent_id='engineer',
            source_application='codex', session_id=session, task_context_token=token,
            events=[dict(event_id='event-1', role='user', content='Synthetic private source body')])
        conversation = ok(await client.post('/v1/agent-conversations/append', json=journal))
        saved, episode = await capture(client, space, session, turn,
            [dict(key='erase', name='Synthetic erased item', type='ProjectFact')])
        # The turn is the FLA's work, so no draft is made of it any more (0.20.1) ...
        refused_draft = await client.post('/v1/publication-drafts', json=dict(personal_space_id=space,
            provider_url='https://public.example', target_project_id='synthetic-public', episode=episode))
        assert refused_draft.status_code == 422
        assert refused_draft.json()['detail']['code'] == 'project_agent_knowledge_personal_only'
        # ... but one made before, already reserved for submission, is still erased with its source.
        draft, begun = {'id': 'draft-' + uuid4().hex}, {'submission_id': str(uuid4())}
        await query(settings, '''
            MATCH (space:FuliSpace {id: $space, kind: 'personal'})
            CREATE (space)-[:HAS_PUBLICATION_DRAFT]->(:FuliPublicationDraft {
              id: $id, personal_space_id: $space, target_project_id: 'synthetic-public',
              provider_url: 'https://public.example', status: 'submitting', payload: $payload,
              created_at: $at, submission_id: $submission_id, submission_started_at: $at})
            RETURN $id AS id''', space=space, id=draft['id'], payload=json.dumps(episode), at=now_utc(),
            submission_id=begun['submission_id'])
        decision_url = f'/v1/publication-drafts/{draft["id"]}/decision'
        target = saved['episode_id'] if kind == 'episode' else store._task_session_id(space, 'codex', session)
        identity = {} if kind == 'episode' else dict(source_application='codex', fuli_session_id=session)
        plan = ok(await source_preview(client, space, target, kind, **identity))
        assert plan['drafts']['submitting'] == 1
        refused_operation = str(uuid4())
        refused = await source_delete(client, space, target, plan, operation=refused_operation, **identity)
        assert refused.status_code == 409 and refused.json()['detail']['code'] == 'hard_delete_draft_submitting'
        outcome = ok(await client.post(f'/v1/knowledge/hard-delete-operations/{refused_operation}',
            headers=REVIEW, json={'personal_space_id': space}))
        assert outcome['state'] == 'refused' and outcome['code'] == 'hard_delete_draft_submitting'
        await query(settings, 'MATCH (draft:FuliPublicationDraft {id:$id}) SET draft.submission_started_at=$at',
                    id=draft['id'], at=now_utc() - timedelta(seconds=121))
        expired = ok(await source_preview(client, space, target, kind, **identity))
        assert expired['preview_id'] == plan['preview_id'] and expired['drafts']['unknown'] == 1
        operation = str(uuid4())
        done = ok(await source_delete(client, space, target, expired, operation=operation, **identity))
        assert done['drafts_scrubbed']['unknown'] == 1
        assert done['source_application'] == 'codex' and done['fuli_session_id'] == session
        assert set(done['deleted_item_ids']) == {target, saved['episode_id'], *saved['entity_ids']}
        replay = ok(await source_delete(client, space, target, expired, operation=operation, **identity))
        assert replay == done
        assert ok(await status(client, space, target, kind))['deletion'] == done
        [trace] = await query(settings, 'MATCH (a:FuliKnowledgeAudit {id:$id}) RETURN properties(a) AS a', id=done['deletion_id'])
        assert json.loads(trace['a']['drafts_scrubbed_json']) == done['drafts_scrubbed']
        assert trace['a']['deleted_task_tokens'] == [token]
        assert 'Synthetic' not in str(trace)
        rows = await query(settings, 'MATCH (c:FuliConversation {id:$id}) OPTIONAL MATCH (c)-[:HAS_EVENT]->(e) '
            'RETURN c.summary AS summary, c.digest AS digest, count(e) AS events', id=conversation['conversation_id'])
        assert rows == [dict(summary='', digest='', events=0)]
        raw = ok(await client.get(f'/v1/publication-drafts/{draft["id"]}', params={'personal_space_id': space}))
        assert raw['episode'] is None and raw['status'] == 'source_deleted' and raw['submission_outcome'] == 'unknown'
        late_episode = {**episode, 'idempotency_key': str(uuid4())}
        writes = [
            await client.post('/v1/knowledge/commits', json={'space_id': space, 'episode': late_episode}),
            await client.post('/v1/publication-drafts', json=dict(personal_space_id=space,
                provider_url='https://public.example', target_project_id='another-project', episode=late_episode)),
            await client.post('/v1/agent-conversations/append', json=journal),
            await client.put('/v1/task-contexts', json={**begin, 'token': 'fuli-task-' + uuid4().hex}),
            await client.put(f'/v1/task-contexts/{token}/checkpoint', json=dict(personal_space_id=space,
                source_application='codex', disposition='retain_nothing', reason='Synthetic late result', fingerprint='a' * 64)),
        ]
        assert [(response.status_code, response.json().get('detail')) for response in writes] == [
            (410, {'code': 'source_hard_deleted'})] * len(writes)
        later = await client.put('/v1/task-contexts', json={**begin, 'turn_id': 'turn-2', 'token': 'fuli-task-' + uuid4().hex})
        assert later.status_code == (410 if kind == 'session' else 200), later.text
        recovered = ok(await client.post(decision_url, params={'personal_space_id': space},
            json={'decision': 'reconcile_submit_public', 'submission_id': begun['submission_id'],
                  'lookup_result': {'id': 'synthetic-public-proposal', 'status': 'pending'}}))
        assert recovered['episode'] is None and recovered['status'] == 'source_deleted'


@pytest.mark.asyncio
async def test_capture_that_started_before_source_delete_cannot_write_after_it(monkeypatch):
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        saved, episode = await capture(client, space, 'late-session', 'late-turn',
            [dict(key='original', name='Synthetic original', type='ProjectFact')])
        store = client._transport.app.state.store
        entered, release = asyncio.Event(), asyncio.Event()
        original = store.runtime.embedder.create_batch
        async def held_embed(texts):
            entered.set()
            await asyncio.wait_for(release.wait(), timeout=20)
            return await original(texts)
        monkeypatch.setattr(store.runtime.embedder, 'create_batch', held_embed)
        late = asyncio.create_task(client.post('/v1/knowledge/commits', json={'space_id': space,
            'episode': {**episode, 'idempotency_key': str(uuid4())}}))
        try:
            await asyncio.wait_for(entered.wait(), timeout=10)
            plan = ok(await source_preview(client, space, saved['episode_id']))
            ok(await source_delete(client, space, saved['episode_id'], plan))
        finally:
            release.set()
        result = await asyncio.wait_for(late, timeout=10)
        assert result.status_code == 410 and result.json()['detail']['code'] == 'source_hard_deleted'
        assert await query(settings, 'MATCH (e:Entity {uuid:$id}) RETURN e', id=saved['entity_ids'][0]) == []


@pytest.mark.asyncio
async def test_real_hr_migration_keeps_old_journal_in_inventory_with_exact_turn_and_space_boundaries():
    from test_system_hr_identity_neo4j import _seed_fixture, LEGACY_HR, CANONICAL_HR
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        fixture = await _seed_fixture(settings, space)
        project = fixture['project_id']
        async def write_event(space_id, project_id, session, turn, source='codex'):
            token = 'fuli-task-' + uuid4().hex
            ok(await client.put('/v1/task-contexts', json=dict(personal_space_id=space_id,
                personal_project_id=project_id, project_agent_id=LEGACY_HR, source_application=source,
                session_id=session, turn_id=turn, token=token)))
            result = ok(await client.post('/v1/agent-conversations/append', json=dict(personal_space_id=space_id,
                personal_project_id=project_id, agent_id=LEGACY_HR, source_application=source, session_id=session,
                task_context_token=token, events=[dict(event_id=turn, role='user', content='Synthetic old HR journal')])) )
            return token, result['conversation_id']
        token, conversation = await write_event(space, project, 'same-session', 'turn-1')
        await write_event(space, project, 'same-session', 'turn-2')
        await write_event(space, project, 'different-session', 'turn-1')
        await write_event(space, project, 'same-session', 'turn-1', 'claude_code')
        other_space = await space_with_projects(client)
        other_fixture = await _seed_fixture(settings, other_space)
        _, other_conversation = await write_event(other_space, other_fixture['project_id'], 'same-session', 'turn-1')
        saved, _ = await capture(client, space, 'same-session', 'turn-1',
            [dict(key='old-source', name='Synthetic legacy source', type='ProjectFact')])
        ok(await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space}))
        [task] = await query(settings, 'MATCH (t:FuliTaskContext {personal_space_id:$space,token:$token}) '
            'RETURN t.project_agent_id AS agent, t.record_json AS record', space=space, token=token)
        assert task['agent'] == CANONICAL_HR and json.loads(task['record'])['project_agent_id'] == LEGACY_HR
        episode_plan = ok(await source_preview(client, space, saved['episode_id']))
        assert episode_plan['counts']['conversation_events'] == 1
        store = client._transport.app.state.store
        target = store._task_session_id(space, 'codex', 'same-session')
        identity = dict(source_application='codex', fuli_session_id='same-session')
        session_plan = ok(await source_preview(client, space, target, 'session', **identity))
        assert session_plan['counts']['conversation_events'] == 2
        ok(await source_delete(client, space, saved['episode_id'], episode_plan))
        assert (await query(settings, 'MATCH (:FuliConversation {id:$id})-[:HAS_EVENT]->(e) RETURN count(e) AS count',
                            id=conversation))[0]['count'] == 1
        assert (await query(settings, 'MATCH (:FuliConversation {id:$id})-[:HAS_EVENT]->(e) RETURN count(e) AS count',
                            id=other_conversation))[0]['count'] == 1


@pytest.mark.asyncio
async def test_episode_only_session_status_is_present_without_task_shell_and_deleted_after_commit():
    async with provider_client(reviewed()) as (client, _):
        space = await space_with_projects(client)
        await capture(client, space, 'episode-only-session', 'turn',
            [dict(key='item', name='Synthetic episode-only session', type='ProjectFact')])
        store = client._transport.app.state.store
        target = store._task_session_id(space, 'codex', 'episode-only-session')
        assert ok(await status(client, space, target, 'session'))['state'] == 'present'
        identity = dict(source_application='codex', fuli_session_id='episode-only-session')
        plan = ok(await source_preview(client, space, target, 'session', **identity))
        ok(await source_delete(client, space, target, plan, **identity))
        assert ok(await status(client, space, target, 'session'))['state'] == 'deleted'


@pytest.mark.asyncio
async def test_session_public_only_draft_is_warned_and_scrubbed_without_a_local_episode():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        store = client._transport.app.state.store
        episode = StructuredEpisode.model_validate(confirmed_episode(idempotency_key=str(uuid4()),
            source_application='codex', session_id='public-only-session', source_turn_id='public-only-turn')).model_dump(mode='json')
        draft = ok(await client.post('/v1/publication-drafts', json=dict(personal_space_id=space,
            provider_url='https://public.example', target_project_id='public-only-project', episode=episode)))
        endpoint = f'/v1/publication-drafts/{draft["id"]}/decision'
        begun = ok(await client.post(endpoint, params={'personal_space_id': space}, json={'decision': 'begin_submit_public'}))
        ok(await client.post(endpoint, params={'personal_space_id': space}, json=dict(decision='submit_public',
            submission_id=begun['submission_id'], shared_proposal_id='existing-remote-proposal')))
        target = store._task_session_id(space, 'codex', episode['session_id'])
        identity = dict(source_application='codex', fuli_session_id=episode['session_id'])
        plan = ok(await source_preview(client, space, target, 'session', **identity))
        assert plan['removed_episodes'] == [] and plan['default_items'] == []
        assert plan['publications'][0]['proposal_id'] == 'existing-remote-proposal'
        assert plan['drafts']['submitted'] == 1
        done = ok(await source_delete(client, space, target, plan, **identity))
        assert done['deleted_item_ids'] == [target] and done['drafts_scrubbed']['submitted'] == 1
        row = ok(await client.get(f'/v1/publication-drafts/{draft["id"]}', params={'personal_space_id': space}))
        assert row['episode'] is None and row['status'] == 'submitted'
        assert row['shared_proposal_id'] == 'existing-remote-proposal'


@pytest.mark.asyncio
async def test_selecting_affected_items_rebinds_dependency_plan_and_deletes_attached_relationships():
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        entities = [dict(key=key, name='Synthetic ' + key, type='ProjectFact') for key in ('basis', 'shared')]
        episode = StructuredEpisode.model_validate(confirmed_episode(idempotency_key=str(uuid4()),
            source_application='codex', session_id='source-session', source_turn_id='source-turn', entities=entities,
            relationships=[dict(key='edge', source='basis', target='shared', type='RELATED_TO', fact='Synthetic relation')])).model_dump(mode='json')
        saved = ok(await client.post('/v1/knowledge/commits', json={'space_id': space, 'episode': episode}))
        basis, shared = saved['entity_ids']
        await capture(client, space, 'another-session', 'another-turn', [entities[1]])
        derived, _ = await capture(client, space, 'another-session', 'derived-turn',
            [dict(key='derived', name='Synthetic derived', type='ProjectFact', derived_from=[basis])])
        conclusion = derived['entity_ids'][0]
        plan = ok(await source_preview(client, space, saved['episode_id']))
        assert {row['key'] for row in plan['default_items']} == {'entity:' + basis, 'relationship:' + saved['relationship_ids'][0]}
        assert {row['key'] for row in plan['affected_items']} == {'entity:' + shared, 'entity:' + conclusion}
        invalid = await source_preview(client, space, saved['episode_id'], exclude=['relationship:' + saved['relationship_ids'][0]])
        assert invalid.status_code == 422
        selection = dict(include=['entity:' + shared, 'entity:' + conclusion])
        chosen = ok(await source_preview(client, space, saved['episode_id'], **selection))
        assert chosen['preview_id'] != plan['preview_id'] and all(row['selected'] for row in chosen['affected_items'])
        done = ok(await source_delete(client, space, saved['episode_id'], chosen, **selection))
        assert {basis, shared, conclusion, saved['relationship_ids'][0]} <= set(done['deleted_item_ids'])
        for item in (basis, shared, conclusion):
            assert (await status(client, space, item)).json()['state'] == 'deleted'


@pytest.mark.asyncio
async def test_submission_waits_for_source_delete_commit_before_reading_its_terminal_draft(monkeypatch):
    from fuli_graph import knowledge_hard_delete
    settings = reviewed()
    async with provider_client(settings) as (client, _):
        space = await space_with_projects(client)
        saved, episode = await capture(client, space, 'serialized-session', 'serialized-turn',
            [dict(key='basis', name='Synthetic serialized basis', type='ProjectFact')])
        draft = ok(await client.post('/v1/publication-drafts', json=dict(personal_space_id=space,
            provider_url='https://public.example', target_project_id='public-project', episode=episode)))
        plan = ok(await source_preview(client, space, saved['episode_id']))
        erased, release = asyncio.Event(), asyncio.Event()
        original = knowledge_hard_delete._write_trace
        async def held_trace(*args):
            erased.set()
            await asyncio.wait_for(release.wait(), timeout=20)
            return await original(*args)
        monkeypatch.setattr(knowledge_hard_delete, '_write_trace', held_trace)
        deleting = asyncio.create_task(source_delete(client, space, saved['episode_id'], plan))
        await asyncio.wait_for(erased.wait(), timeout=10)
        submitting = asyncio.create_task(client.post(f'/v1/publication-drafts/{draft["id"]}/decision',
            params={'personal_space_id': space}, json={'decision': 'begin_submit_public'}))
        try:
            # It cannot reserve from the still-visible pending draft while the
            # delete owns the shared Neo4j knowledge-space lock.
            await asyncio.sleep(0.1)
            assert not submitting.done()
        finally:
            release.set()
        ok(await asyncio.wait_for(deleting, timeout=10))
        assert (await asyncio.wait_for(submitting, timeout=10)).status_code == 409
