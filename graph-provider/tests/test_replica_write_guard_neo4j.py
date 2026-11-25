"""A follower's writes never change its read-only copy of `global`
(docs/runner-roles-design.md §12, "Write refusal"), on a disposable Neo4j
through the full Provider app, with the guard checking every write (STRICT).

The host is played first in the same graph (its space exported, then removed),
the follower after it under the same space ID, as test_follower_space_neo4j.py
does. Every refusal is checked to have written nothing: the copy's digest is
the same before and after. Synthetic data only; each test removes its space
(past the guard: a test's cleanup deletes copies).

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1.
"""
import json
from uuid import uuid4

import pytest
from fastapi import HTTPException

from fuli_graph.provider_values import graphiti_group_id
from test_follower_space_neo4j import (  # noqa: F401
    alone, follower_settings, host_global, no_personal_space, strict, take_space,
)
from test_project_agent_memory_neo4j import (
    FIXTURE_REVIEW_TOKEN, fixture_settings, provider_client, write_payload,
)
from test_scope_export_neo4j import checked, cleanup
from test_scope_import_neo4j import held, import_envelope, scenario

REVIEW = {'x-fuli-human-review-token': FIXTURE_REVIEW_TOKEN}
LOCAL = 'synthetic-local'
BASIS = {'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.', 'proposed_by': {'kind': 'user'},
         'confirmed_by': {'kind': 'user'}, 'confirmed_at': '2026-11-01T00:00:00Z'}


def episode(key, *, habit=False):
    entity = {'key': key, 'name': f'Synthetic {key}', 'type': 'PersonalPreference' if habit else 'ProjectFact',
              'summary': f'Synthetic {key} summary.', 'confirmation_status': 'confirmed', 'confirmation_basis': BASIS}
    if habit:
        entity['profile_aspect'] = 'taste'
    return {'idempotency_key': f'synthetic-{key}-{uuid4()}', 'session_id': 'synthetic-session',
            'name': f'Synthetic {key}', 'source_kind': 'task_remember', 'source_application': 'codex',
            'source_turn_id': f'turn-{key}', 'source_description': 'Synthetic capture.',
            'reference_time': '2026-11-20T00:00:00Z', 'entities': [entity]}


async def writes(client, space, habit, *, project=None):
    """The same writes of `global`, each a response: what a follower refuses and its host makes."""
    return {
        'revise a habit': await client.patch(f'/v1/knowledge/items/{habit}', json={
            'personal_space_id': space, 'item_kind': 'entity', 'action': 'invalidate',
            'reason': 'Synthetic change.', 'operation_actor': 'human'}),
        'rename an FLA': await client.put('/v1/project-agents/scope-writer/name', json={
            'personal_space_id': space, 'display_name': f'Synthetic renamed {uuid4().hex[:6]}'}),
        "write an FLA's global memory": await client.put('/v1/project-agents/scope-lead/memory', json=write_payload(
            space, personal_project_id=None, agent_id='scope-lead', expected_revision=1,
            idempotency_key=f'global-{uuid4()}')),
        'save a global habit': await client.post('/v1/knowledge/commits', json={
            'space_id': space, 'episode': episode('global-habit', habit=True)}),
    }


@pytest.mark.asyncio
async def test_a_follower_refuses_every_write_of_its_copy_and_writes_nothing(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    habit = f'{space_id}-pref-global'
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            await import_envelope(client, envelope)
            digest = (await held(client, space_id, 'global'))['digest']
            health = await checked(await client.get('/health'))
            assert health['replicaWriteGuard']['checks'] == 'every_write'

            async def refused(response, what):
                assert response.status_code == 409, (what, response.text)
                detail = response.json()['detail']
                assert detail['code'] == 'replica_read_only', (what, detail)
                assert (await held(client, space_id, 'global'))['digest'] == digest, what
                return detail

            for what, response in (await writes(client, space_id, habit)).items():
                detail = await refused(response, what)
                assert 'owner' in detail and detail['scopes'] == ['global'], what
            assert (await refused(await client.patch(f'/v1/knowledge/items/{habit}', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'invalidate',
                'reason': 'Synthetic change.', 'operation_actor': 'human'}), 'revise'))['owner'] == 'a' * 64
            # When a habit of the copy applies (#1107) is the host's to say, like its content.
            await refused(await client.patch(f'/v1/knowledge/items/{habit}', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'update',
                'applies_when': 'Synthetic case.', 'reason': 'Synthetic case.', 'operation_actor': 'human'}),
                'say when a habit applies')
            plan = await checked(await client.post(f'/v1/knowledge/items/{habit}/hard-delete/preview',
                                                   json={'personal_space_id': space_id, 'item_kind': 'entity'},
                                                   headers=REVIEW))
            await refused(await client.post(f'/v1/knowledge/items/{habit}/hard-delete', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'preview_id': plan['preview_id'],
                'confirmation': '删除'}, headers=REVIEW), 'delete a habit')
            await refused(await client.post('/v1/knowledge/batch-confirmations', json={
                'personal_space_id': space_id, 'group_kind': 'source', 'group_value': 'synthetic-source',
                'reason': 'Synthetic review.', 'operation_actor': 'human',
                'confirmer': {'kind': 'user', 'label': 'Synthetic user'},
                'items': [{'item_id': habit, 'item_kind': 'entity', 'existence_reason': 'Synthetic.',
                           'quadrant_reason': 'Synthetic.', 'proposed_by': {'kind': 'agent', 'label': 'Codex'}}]}),
                'review a habit')
            # A write no entry refuses: rolled back by the guard at its commit.
            store = client._transport.app.state.store
            with pytest.raises(HTTPException) as caught:
                await store.runtime.driver.execute_query(
                    "MATCH (habit:Entity {uuid: $uuid}) SET habit.name = 'Changed here'", uuid=habit)
            assert caught.value.detail['record'] == f'Entity:{habit}'
            assert (await held(client, space_id, 'global'))['digest'] == digest
            again = await import_envelope(client, envelope)
            assert again['nodes']['created'] == again['nodes']['updated'] == again['nodes']['deleted'] == 0
            assert again['relationships']['created'] == again['relationships']['updated'] == 0
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_followers_own_project_writes_beside_the_copy_and_the_copy_stays(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    habit = f'{space_id}-pref-global'
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            await import_envelope(client, envelope)
            digest = (await held(client, space_id, 'global'))['digest']
            await checked(await client.put('/v1/personal-projects', json={
                'personal_space_id': space_id, 'project_id': LOCAL,
                'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'A project of the follower.'}}))
            # Project knowledge and a project habit.
            await checked(await client.post('/v1/knowledge/commits', json={
                'space_id': space_id, 'personal_project_id': LOCAL, 'episode': episode('local-fact')}))
            await checked(await client.post('/v1/knowledge/commits', json={
                'space_id': space_id, 'personal_project_id': LOCAL, 'episode': episode('local-habit', habit=True)}))
            # A copied FLA staffed on this computer's project, and its memory of that project.
            await checked(await client.post('/v1/project-agent-assignments', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'agent_id': 'scope-lead',
                'idempotency_key': f'assign-{uuid4()}', 'responsibility': 'Keep the sample.',
                'work_kinds': ['implementation'], 'capabilities': ['coding'], 'reason': 'Synthetic staffing.'}))
            await checked(await client.put('/v1/project-agents/scope-lead/memory', json=write_payload(
                space_id, personal_project_id=LOCAL, agent_id='scope-lead', idempotency_key=f'local-{uuid4()}')))
            # A task of the project that used the host's habit: the checkpoint succeeds, the use is not recorded here.
            context = {'personal_space_id': space_id, 'personal_project_id': LOCAL, 'project_agent_id': 'scope-lead',
                       'session_id': f'synthetic-{uuid4()}', 'source_application': 'codex',
                       'token': f'fuli-task-{uuid4()}', 'turn_id': 'first-turn'}
            await checked(await client.put('/v1/task-contexts', json=context))
            saved = await checked(await client.put(f'/v1/task-contexts/{context["token"]}/checkpoint', json={
                'personal_space_id': space_id, 'source_application': 'codex', 'phase': 'prepare',
                'disposition': 'retain_nothing', 'reason': 'Synthetic checkpoint.', 'fingerprint': 'a' * 64,
                'agent_memory': {'expected_revision': 1, 'memory': {'summary': 'Synthetic local memory.'}},
                'knowledge_usage': [{'item_id': habit, 'item_kind': 'entity', 'use_kind': 'applied'}]}))
            usage = saved['checkpoint']['knowledge_usage_result']
            assert (usage['recorded_count'], usage['held_by_owner_count']) == (0, 1)
            assert '有 1 条属于主机的条目' in usage['held_by_owner_note']
            assert usage['items'][0]['confirmation_status'] == 'confirmed', 'never changed here'
            # Who saw it: the owner records it; here it is skipped without a word.
            views = await checked(await client.post('/v1/knowledge/agent-views', json={
                'personal_space_id': space_id, 'tool_name': 'synthetic_tool',
                'items': [{'item_id': habit, 'item_kind': 'entity'}]}))
            assert views['recorded_count'] == 0
            # Retrieval terms are the owner's to make: the copy is neither offered nor written.
            candidates = await checked(await client.post('/v1/retrieval/candidates', json={
                'personal_space_id': space_id}))
            assert habit not in {item['item_id'] for item in candidates['items']}
            terms = await checked(await client.post('/v1/retrieval/terms', json={
                'personal_space_id': space_id, 'items': [{'item_kind': 'entity', 'item_id': habit,
                                                          'hash': 'a' * 64, 'terms': ['synthetic'],
                                                          'context': 'Synthetic.'}]}))
            assert terms['skipped'] == [habit]
            assert (await held(client, space_id, 'global'))['digest'] == digest
            # A derived value this computer computes for itself may land on a copy (the guard checks every
            # write here, and lets it through).
            pending = await checked(await client.post('/v1/semantic/pending', json={
                'personal_space_id': space_id, 'model': 'synthetic-model'}))
            row = next(item for item in pending['items'] if item['item_id'] == habit)
            written = await checked(await client.post('/v1/semantic/vectors', json={
                'personal_space_id': space_id, 'model': 'synthetic-model', 'items': [
                    {'item_kind': 'entity', 'item_id': habit, 'hash': row['hash'], 'vector': [1.0, 0.0, 0.0]}]}))
            assert written['skipped'] == []
            records, _, _ = await driver.execute_query(
                'MATCH (habit:Entity {uuid: $uuid}) RETURN habit.fuli_semantic_model AS model', uuid=habit)
            assert records[0]['model'] == 'synthetic-model'
            again = await import_envelope(client, envelope)
            assert again['nodes']['created'] == again['nodes']['deleted'] == 0
            assert again['relationships']['created'] == again['relationships']['updated'] == 0
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_graph_whose_global_is_its_own_makes_the_same_writes(alone, strict):  # noqa: F811
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
        try:
            health = await checked(await client.get('/health'))
            assert health['replicaWriteGuard'] == {'holdsCopies': False, 'checks': 'none'}
            for what, response in (await writes(client, space, f'{space}-pref-global')).items():
                assert response.status_code == 200, (what, response.text)
            assert json.dumps(await checked(await client.get('/v1/project-agents', params={
                'personal_space_id': space}))).count('Synthetic renamed') == 1
        finally:
            await cleanup(driver, space, group)


async def personal_tag(client, space):
    """A tag of the host's personal vocabulary, so the follower's copy has one."""
    return (await checked(await client.post('/v1/knowledge-tags/create', json={
        'personal_space_id': space, 'name': 'Synthetic language', 'namespace': 'personal',
        'reason': 'Synthetic tag.'})))['tag']['id']


@pytest.mark.asyncio
async def test_a_follower_refuses_the_other_writes_of_global_and_aliases_its_own_project_tags(alone, strict):  # noqa: F811
    """A topic's decline, publication drafts, subscriptions and an alias of a personal tag are
    `global` by their nature: refused up front, nothing written. A tag of the follower's own
    project takes an alias as before."""
    settings = fixture_settings()
    space_id, envelope = await host_global(settings, seed=personal_tag)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    tag_id = next(entry['properties']['id'] for entry in envelope['nodes'] if entry['id'].startswith('FuliKnowledgeTag:')
                  and entry['properties'].get('namespace_kind') == 'personal')
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            await import_envelope(client, envelope)
            await checked(await client.put('/v1/personal-projects', json={
                'personal_space_id': space_id, 'project_id': LOCAL,
                'profile': {'name': 'Synthetic local', 'lifecycle': 'active', 'purpose': 'A project of the follower.'}}))
            digest = (await held(client, space_id, 'global'))['digest']
            for what, response in {
                'decline a conversation topic': await client.post('/v1/conversation-triage/decline', json={
                    'personal_space_id': space_id, 'topic': 'Synthetic topic'}),
                'draft a publication': await client.post('/v1/publication-drafts', json={
                    'personal_space_id': space_id, 'target_project_id': 'synthetic-team',
                    'provider_url': 'https://provider.example.test', 'episode': episode('publication')}),
                'subscribe': await client.post('/v1/subscriptions', json={
                    'personal_space_id': space_id, 'project_id': 'synthetic-team',
                    'provider_url': 'https://provider.example.test', 'project_name': 'Synthetic team'}),
                'unsubscribe': await client.delete('/v1/subscriptions/synthetic-team', params={
                    'personal_space_id': space_id, 'provider_url': 'https://provider.example.test'}),
                'alias a personal tag': await client.post('/v1/knowledge-tags/aliases', json={
                    'personal_space_id': space_id, 'tag_id': tag_id, 'alias': 'Synthetic tongue',
                    'reason': 'Synthetic alias.'}),
            }.items():
                assert response.status_code == 409, (what, response.text)
                assert response.json()['detail']['code'] == 'replica_read_only', what
                assert (await held(client, space_id, 'global'))['digest'] == digest, what
            records, _, _ = await driver.execute_query('''
                RETURN COUNT { (:FuliConversationTopicDecline {space_id: $space}) } AS declines,
                       COUNT { (:FuliPublicationDraft {personal_space_id: $space}) } AS drafts,
                       COUNT { (:FuliSpace {id: $space})-[:SUBSCRIBES_TO]->() } AS subscriptions''', space=space_id)
            assert dict(records[0]) == {'declines': 0, 'drafts': 0, 'subscriptions': 0}
            # Judged apart from the copied personal tag, whose word it shares.
            created = await checked(await client.post('/v1/knowledge-tags/create', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'name': 'Synthetic module',
                'namespace': 'project', 'reason': 'Synthetic tag.', 'distinct_from': [tag_id]}))
            assert created['outcome'] == 'created', created
            project_tag = created['tag']
            aliased = await checked(await client.post('/v1/knowledge-tags/aliases', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'tag_id': project_tag['id'],
                'alias': 'Synthetic component', 'reason': 'Synthetic alias.'}))
            assert aliased['outcome'] in {'added', 'proposed'}
            assert (await held(client, space_id, 'global'))['digest'] == digest
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_graph_whose_global_is_its_own_declines_drafts_subscribes_and_aliases(alone, strict):  # noqa: F811
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
        try:
            tag_id = await personal_tag(client, space)
            for what, response in {
                'subscribe': await client.post('/v1/subscriptions', json={
                    'personal_space_id': space, 'project_id': 'synthetic-team',
                    'provider_url': 'https://provider.example.test', 'project_name': 'Synthetic team'}),
                'unsubscribe': await client.delete('/v1/subscriptions/synthetic-team', params={
                    'personal_space_id': space, 'provider_url': 'https://provider.example.test'}),
                'alias a personal tag': await client.post('/v1/knowledge-tags/aliases', json={
                    'personal_space_id': space, 'tag_id': tag_id, 'alias': 'Synthetic tongue',
                    'reason': 'Synthetic alias.'}),
            }.items():
                assert response.status_code == 200, (what, response.text)
            declined = await client.post('/v1/conversation-triage/decline', json={
                'personal_space_id': space, 'topic': 'Synthetic topic'})
            assert declined.status_code == 404, 'no such open topic: past the refusal, as before'
        finally:
            await cleanup(driver, space, group)
