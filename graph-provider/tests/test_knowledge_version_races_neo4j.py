"""rec#5 C7/C8 review (dot P1/P2, D-20) against an explicitly disposable Neo4j:
the races between captures, edits and the outdated mark, terminal states that
nothing washes away, and walks that are never cut short. Barriers pause one
writer at a known statement; synthetic data only, public HTTP routes."""

import asyncio
import json
from contextlib import contextmanager
from uuid import uuid4

import pytest

from fuli_graph import store_knowledge
from fuli_graph.runtime import LocalHashEmbedder
from fuli_graph.store_transactions import TransactionQueryDriver
from test_knowledge_versions_neo4j import edit, entry_instructions, mark_outdated
from test_negative_feedback_block_neo4j import query
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, ok, preference, space_with_projects, view

LOCK = '_knowledge_lock'


@contextmanager
def paused_at_lock():
    """Pause the next transaction right after it takes the space's knowledge lock."""
    taken, release = asyncio.Event(), asyncio.Event()
    original = TransactionQueryDriver.execute_query
    armed = {'on': True}

    async def gated(self, statement, **kwargs):
        records = await original(self, statement, **kwargs)
        if armed['on'] and LOCK in statement:
            armed['on'] = False
            taken.set()
            await release.wait()
        return records

    TransactionQueryDriver.execute_query = gated
    try:
        yield taken, release
    finally:
        TransactionQueryDriver.execute_query = original


@contextmanager
def paused_at_embedding(text):
    """Pause a capture while it embeds `text`, before its transaction starts."""
    reached, release = asyncio.Event(), asyncio.Event()
    original = LocalHashEmbedder.create_batch

    async def gated(self, values):
        if text in values:
            reached.set()
            await release.wait()
        return await original(self, values)

    LocalHashEmbedder.create_batch = gated
    try:
        yield reached, release
    finally:
        LocalHashEmbedder.create_batch = original


def commit_request(space_id, entities, *, project=None, key=None):
    return {'space_id': space_id, 'personal_project_id': project, 'episode': {
        'idempotency_key': key or f'race-{uuid4()}', 'session_id': 'synthetic-session', 'name': 'Synthetic turn',
        'source_kind': 'task_remember', 'source_description': 'Synthetic.', 'source_application': 'codex',
        'reference_time': '2026-10-21T00:00:00Z', 'entities': entities}}


async def still_blocked(task, seconds=0.6):
    await asyncio.sleep(seconds)
    return not task.done()


async def confirmed_preference(client, space_id, key, text, **fields):
    item_id = (await commit(client, space_id, [preference(key, text, **fields)]))['entity_ids'][0]
    await confirm(client, space_id, item_id)
    return item_id


def fact(key, text, bases):
    return {'key': key, 'name': text, 'type': 'ProjectFact', 'summary': text, 'derived_from': bases}


@pytest.mark.asyncio
async def test_p1a_a_capture_paused_before_its_write_cannot_conclude_from_a_basis_marked_outdated_meanwhile():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis = await confirmed_preference(client, space_id, 'word', 'Reports in Word')
        with paused_at_embedding('The template is a .docx') as (reached, release):
            capture = asyncio.create_task(client.post('/v1/knowledge/commits', json=commit_request(
                space_id, [fact('template', 'The template is a .docx', [basis])], project='alpha')))
            await asyncio.wait_for(reached.wait(), 5)
            ok(await mark_outdated(client, space_id, basis, version=(await view(client, space_id, basis))['version']))
            release.set()
            response = await capture
        assert response.status_code == 422 and response.json()['detail']['code'] == 'derived_from_not_current'
        rows = await query(settings, '''MATCH (space:FuliSpace {id: $space}) MATCH (item:Entity {fuli_key: 'template', group_id: space.group_id})
            RETURN item.uuid AS id''', space=space_id)
        assert rows == [], 'nothing was written from a basis that went out of date'


@pytest.mark.asyncio
async def test_p1a_a_basis_marked_outdated_while_a_capture_holds_the_lock_also_ends_that_new_conclusion():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis = await confirmed_preference(client, space_id, 'word', 'Reports in Word')
        version = (await view(client, space_id, basis))['version']
        with paused_at_lock() as (taken, release):
            capture = asyncio.create_task(client.post('/v1/knowledge/commits', json=commit_request(
                space_id, [fact('template', 'The template is a .docx', [basis])], project='alpha')))
            await asyncio.wait_for(taken.wait(), 5)
            marking = asyncio.create_task(mark_outdated(client, space_id, basis, version=version))
            assert await still_blocked(marking), 'the outdated mark waits for the capture'
            release.set()
            written = ok(await capture)
            ok(await marking)
        assert (await view(client, space_id, written['entity_ids'][0]))['status'] == 'basis_outdated'


@pytest.mark.asyncio
@pytest.mark.parametrize('across_processes', [False, True])
async def test_p1b_a_capture_and_a_console_reassertion_of_one_version_leave_exactly_one_head(across_processes):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        space_id = await space_with_projects(client, 'alpha')
        words = preference('report', 'Reports in Word', content_source='user_explicit')
        old_id = (await commit(client, space_id, [words]))['entity_ids'][0]
        await confirm(client, space_id, old_id)
        ok(await mark_outdated(client, space_id, old_id, version=(await view(client, space_id, old_id))['version']))
        version = (await view(client, space_id, old_id))['version']
        # A second Provider instance on the same graph stands for another process.
        async with provider_client(settings, token) as (other, _):
            console = other if across_processes else client
            with paused_at_lock() as (taken, release):
                capture = asyncio.create_task(commit(client, space_id, [words], key=f'again-{uuid4()}'))
                await asyncio.wait_for(taken.wait(), 5)
                reassert = asyncio.create_task(edit(console, space_id, old_id, 'Reports in Word', version=version))
                assert await still_blocked(reassert)
                release.set()
                captured = await capture
                lost = await reassert
        head = captured['entity_ids'][0]
        assert lost.status_code == 409, 'the console lost the race and is told so'
        heads = await query(settings, '''
            MATCH (space:FuliSpace {id: $space})
            MATCH (item:Entity {fuli_key: 'report', group_id: space.group_id})
            WHERE item.fuli_replaced_by_item_id IS NULL
            RETURN item.uuid AS id''', space=space_id)
        assert [row['id'] for row in heads] == [head], 'one chain, one head'
        [old] = await query(settings, 'MATCH (item:Entity {uuid: $id}) RETURN item.fuli_replaced_by_item_id AS next',
                            id=old_id)
        assert old['next'] == head
        retried = ok(await edit(client, space_id, head, 'Reports in Word, saved as PDF',
                                version=(await view(client, space_id, head))['version']))
        assert retried['version_item_id']


@pytest.mark.asyncio
async def test_p1b_a_failure_before_the_link_leaves_nothing_half_written_and_a_replay_finds_the_same_version(
        monkeypatch):
    settings = fixture_settings()
    async with provider_client(settings, raise_app_exceptions=False) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        words = preference('report', 'Reports in Word', content_source='user_explicit')
        old_id = (await commit(client, space_id, [words]))['entity_ids'][0]
        await confirm(client, space_id, old_id)
        ok(await mark_outdated(client, space_id, old_id, version=(await view(client, space_id, old_id))['version']))
        key = f'again-{uuid4()}'

        async def broken_link(*_args, **_kwargs):
            raise RuntimeError('synthetic failure before the link')
        monkeypatch.setattr(store_knowledge, 'link_reasserted', broken_link)
        failed = await client.post('/v1/knowledge/commits', json=commit_request(space_id, [words], key=key))
        assert failed.status_code == 500
        count = await query(settings, '''MATCH (space:FuliSpace {id: $space})
            MATCH (item:Entity {fuli_key: 'report', group_id: space.group_id}) RETURN count(item) AS items''',
            space=space_id)
        assert count == [{'items': 1}], 'the new version rolled back with the failed link'
        assert (await view(client, space_id, old_id))['current_item_id'] is None
        monkeypatch.undo()
        first = await commit(client, space_id, [words], key=key)
        replay = await commit(client, space_id, [words], key=key)
        assert replay['status'] == 'duplicate' and replay['entity_ids'] == first['entity_ids']
        assert (await view(client, space_id, old_id))['current_item_id'] == first['entity_ids'][0]


@pytest.mark.asyncio
@pytest.mark.parametrize('ending', ['mark_outdated', 'supersede'])
async def test_p1c_a_deactivation_cannot_wash_away_an_end_so_a_restore_stays_refused(ending):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        item_id = await confirmed_preference(client, space_id, 'tone', 'Keep a calm tone')
        version = (await view(client, space_id, item_id))['version']
        if ending == 'mark_outdated':
            ok(await mark_outdated(client, space_id, item_id, version=version))
        else:
            ok(await edit(client, space_id, item_id, 'Keep a calm, direct tone', version=version))
        for action in ['invalidate', 'restore']:
            response = await client.patch(f'/v1/knowledge/items/{item_id}', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'action': action, 'reason': 'Synthetic.',
                'operation_actor': 'human', 'expected_version': (await view(client, space_id, item_id))['version']})
            assert response.status_code == 409, action
            assert response.json()['detail']['code'] == (
                'lifecycle_final' if action == 'invalidate' else 'reassert_as_new_version')
        assert (await view(client, space_id, item_id))['status'] == (
            'outdated' if ending == 'mark_outdated' else 'superseded')


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['entity', 'relationship'])
async def test_p2a_an_outdated_version_re_asserted_since_cannot_be_edited_through_its_old_link(kind):
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        if kind == 'entity':
            item_id = await confirmed_preference(client, space_id, 'report', 'Reports in Word')
        else:
            saved = await commit(client, space_id, [{'key': 'w', 'name': 'Writer', 'type': 'Person'},
                                                    {'key': 'f', 'name': 'Format', 'type': 'Format'}],
                                 relationships=[{'key': 'p', 'source': 'w', 'target': 'f', 'type': 'PREFERS',
                                                 'fact': 'Reports in Word', 'profile_aspect': 'taste'}])
            item_id = saved['relationship_ids'][0]
            await confirm(client, space_id, item_id, kind)
        ok(await mark_outdated(client, space_id, item_id, kind=kind,
                               version=(await view(client, space_id, item_id, kind))['version']))
        head = ok(await edit(client, space_id, item_id, 'Reports in Word', kind=kind,
                             version=(await view(client, space_id, item_id, kind))['version']))['version_item_id']
        old = await view(client, space_id, item_id, kind)
        assert old['status'] == 'outdated'
        refused = await edit(client, space_id, item_id, 'Rewritten through the old link', kind=kind,
                             version=old['version'])
        assert refused.status_code == 409
        assert refused.json()['detail'] == {'code': 'superseded', 'current_item_id': head,
                                            'message': 'a newer version replaced this knowledge; edit the current version'}
        assert (await view(client, space_id, item_id, kind))['content'] == 'Reports in Word'


@pytest.mark.asyncio
async def test_p2b_an_outdated_basis_ends_a_chain_of_nine_conclusions():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        basis = await confirmed_preference(client, space_id, 'word', 'Reports in Word')
        chain, previous = [], basis
        for level in range(9):
            previous = (await commit(client, space_id, [fact(f'level-{level}', f'Conclusion {level}', [previous])],
                                     project='alpha'))['entity_ids'][0]
            chain.append(previous)
        marked = ok(await mark_outdated(client, space_id, basis, version=(await view(client, space_id, basis))['version']))
        assert marked['dependents_outdated'] == 9
        assert [(await view(client, space_id, item))['status'] for item in chain] == ['basis_outdated'] * 9


@pytest.mark.asyncio
async def test_p2b_thirty_four_versions_keep_one_lineage_and_a_conclusion_on_the_first_still_follows():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        first = await confirmed_preference(client, space_id, 'tone', 'Tone 0')
        conclusion = (await commit(client, space_id, [fact('reply', 'Replies follow the tone', [first])],
                                   project='alpha'))['entity_ids'][0]
        head = first
        for number in range(1, 34):
            response = await client.patch(f'/v1/knowledge/items/{head}', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'action': 'update', 'reason': 'Synthetic.',
                'operation_actor': 'human', 'name': f'Tone {number}', 'summary': f'Tone {number}',
                'basis_meaning': 'wording_only',
                'expected_version': (await view(client, space_id, head))['version']})
            head = ok(response)['version_item_id']
        current = await view(client, space_id, head)
        assert len(current['versions']) == 34
        assert (await view(client, space_id, first))['current_item_id'] == head
        ok(await mark_outdated(client, space_id, head, version=current['version']))
        assert (await view(client, space_id, conclusion))['status'] == 'basis_outdated'


@pytest.mark.asyncio
async def test_an_edited_global_assertion_keeps_resting_on_its_decisions_sources():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        sources = []
        for project in ['alpha', 'beta']:
            source_id = (await commit(client, space_id, [preference('docs', 'Docs in Markdown')],
                                      project=project))['entity_ids'][0]
            await confirm(client, space_id, source_id)
            sources.append({'item_id': source_id, 'item_kind': 'entity', 'project_id': project})
        assertion = await confirmed_preference(client, space_id, 'docs-global', 'Docs in Markdown everywhere')
        event_id = str(uuid4())
        await query(settings, '''
            CREATE (:FuliPersonalGlobalPreferenceDecision {space_id: $space, candidate_id: $candidate,
              decision: 'approved', global_assertion_id: $assertion, current_event_id: $event})
            CREATE (:FuliPersonalGlobalPreferenceDecisionEvent {space_id: $space, id: $event,
              candidate_id: $candidate, global_assertion_id: $assertion, source_items_json: $sources})
            ''', space=space_id, candidate=f'candidate-{uuid4()}', assertion=assertion, event=event_id,
            sources=json.dumps(sources))
        edited = ok(await edit(client, space_id, assertion, 'Docs in Markdown in every project',
                               version=(await view(client, space_id, assertion))['version']))['version_item_id']
        assert {basis['item_id'] for basis in (await view(client, space_id, edited))['bases']} == {
            source['item_id'] for source in sources}
        first = sources[0]['item_id']
        ok(await mark_outdated(client, space_id, first, version=(await view(client, space_id, first))['version']))
        assert (await view(client, space_id, edited))['status'] == 'basis_outdated'
        assert edited not in await applied(client, space_id, 'beta')


@pytest.mark.asyncio
async def test_a_current_relationship_on_a_replaced_endpoint_is_still_found_and_read():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        saved = await commit(client, space_id, [{'key': 'svc', 'name': 'Billing service', 'type': 'System'},
                                                {'key': 'port', 'name': 'Port', 'type': 'Setting'}], project='alpha',
                             relationships=[{'key': 'listens', 'source': 'svc', 'target': 'port', 'type': 'LISTENS_ON',
                                             'fact': 'Billing service listens on 9090'}])
        service, edge_id = saved['entity_ids'][0], saved['relationship_ids'][0]
        await confirm(client, space_id, service)
        ok(await edit(client, space_id, service, 'Billing API', version=(await view(client, space_id, service))['version']))
        relation = await view(client, space_id, edge_id, 'relationship')
        assert (relation['status'], relation['content']) == ('current', 'Billing service listens on 9090')
        found = ok(await client.post('/v1/search', json={
            'space_ids': [space_id], 'query': 'Billing service listens on 9090', 'limit': 20,
            'personal_project_ids': ['alpha'], 'active_personal_project_id': 'alpha', 'include_pending': True}))
        assert edge_id in json.dumps(found)
        graph = ok(await client.get(f'/v1/spaces/{space_id}/graph', params={'limit': 500}))
        [edge] = [edge for edge in graph['edges'] if edge['id'] == edge_id]
        nodes = {node['id']: node for node in graph['nodes']}
        assert edge['source'] == service and nodes[service]['version_status'] == 'superseded'
        assert nodes[service]['replaced_by_item_id'] in nodes, 'the console can show it on the current version'
