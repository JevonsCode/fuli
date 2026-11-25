"""The entries a host-copy re-review left unregistered, on a disposable Neo4j:
a host keeps another computer's project (alpha) as a read-only copy beside two
projects of its own (local, second) and writes them through each entry.

Each entry writes the host's own projects (the person's batch confirmation,
retrieval terms, a session hint, a coordination binding, a publication draft
and a subscription, an FLA loan, an owner hire, a transcript fallback, a
session migration, a dismissal). A write that would change the copy is
refused; while one of the host's projects is frozen for a move, a write of it
is refused and rolled back, and what it would have changed reads as before;
a write of `global` only still goes through. The copy's summary never changes.
All data is synthetic.
"""
from contextlib import asynccontextmanager, closing
from hashlib import sha256
import sqlite3
from uuid import uuid4

import pytest

from fuli_graph.models import StructuredEpisode
from test_agent_delegations_neo4j import resolve
from test_host_copy_local_entries_neo4j import PERSON, copy_summary, task
from test_host_project_copy_neo4j import registry
from test_models import confirmed_episode
from test_owner_hire_neo4j import PROPOSED, hire
from test_project_agent_memory_neo4j import dismiss_agent, fixture_settings, provider_client, seed_agent
from test_project_freeze_neo4j import make_gates
from test_review_list_batch_confirmation_neo4j import review_batch
from test_scope_export_neo4j import checked, cleanup, export
from test_scope_import_neo4j import OWNER, OTHER, clear, scenario
from test_session_migration_neo4j import held_session, link_task, migrate, preview
from test_turn_receipt_neo4j import commit, view

# Each project's lead first, then its members (their coordination policy).
TEAMS = {'local': ['target-lead', 'engineer'], 'second': ['source-lead', 'specialist', 'helper']}


def fact(key, **fields):
    return {'key': key, 'name': f'Synthetic {key} {uuid4().hex[:6]}', 'type': 'ProjectFact',
            'summary': f'Synthetic {key}.', 'origin_quadrant': 'known_known', **fields}


def gate(root, space, project, state):
    """Freeze (closed, for a move) or reopen one of the host's own projects."""
    directory = root / sha256(space.encode()).hexdigest()
    for name in ('index.sqlite', sha256(project.encode()).hexdigest() + '.sqlite'):
        with closing(sqlite3.connect(directory / name)) as db, db:
            db.execute('UPDATE gates SET state=?, move_id=? WHERE project=?',
                       (state, 'synthetic-move' if state == 'closed' else None, project))


def refused(response, code=None):
    assert response.status_code == 409, response.text
    if code:
        assert response.json()['detail']['code'] == code, response.text


@asynccontextmanager
async def host_beside_copy(tmp_path):
    """The person's graph exports alpha, is emptied and prepared, then runs as
    the host of its two projects holding alpha's import as a copy."""
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        driver, space, group = await scenario(client)
        try:
            image = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            await prepare_teams(client, space)
            file = tmp_path / 'authority.sqlite'
            registry(file, space)
            make_gates(tmp_path, space, [('alpha', 'replica', 1, 'open', None), ('local', 'owner', 1, 'open', None),
                                         ('second', 'owner', 1, 'open', None)])
            trusted = settings.model_copy(update={'project_registry_path': str(file), 'project_registry_version': 11,
                'project_gate_directory': str(tmp_path), 'project_gate_space': space,
                'project_authority_fingerprint': OTHER, 'project_device_fingerprint': OTHER})
            async with provider_client(trusted, token) as (host, _):
                await checked(await host.post('/v1/scopes/import', json=image,
                                              params={'owner': OWNER, 'generation': 1, 'pairing': 'pair'}))
                copied = await copy_summary(host, space)
                assert copied['copiedRecords'] > 0
                yield host, driver, space
                assert await copy_summary(host, space) == copied
        finally:
            await cleanup(driver, space, group)


async def prepare_teams(client, space):
    for project, agents in TEAMS.items():
        for agent in agents:
            await seed_agent(client, space, project=project, agent=agent)
        await checked(await client.put('/v1/project-agent-coordination-policy', json={
            'personal_space_id': space, 'personal_project_id': project,
            'team_lead_agent_id': agents[0], 'team_member_agent_ids': agents[1:]}))
    # What a session saved before it worked in a project waits in its temporary project.
    temporary = await held_session(client, space)
    await commit(client, space, [fact('held-a', content_source='agent_inferred'),
                                 fact('held-b', content_source='agent_inferred')],
                 project=temporary, scope_status='undetermined')


async def begin(host, space, project, agent, session, **fields):
    token = f'fuli-task-{uuid4().hex}'
    await checked(await host.put('/v1/task-contexts', json={
        'personal_space_id': space, 'personal_project_id': project, 'project_agent_id': agent,
        'session_id': session, 'source_application': 'codex', 'token': token, **fields}))
    return token


async def task_context(host, space, token):
    return await checked(await host.get(f'/v1/task-contexts/{token}', params={
        'personal_space_id': space, 'source_application': 'codex'}))


@pytest.mark.asyncio
async def test_host_confirms_and_indexes_its_items_beside_a_copy(tmp_path):
    async with host_beside_copy(tmp_path) as (host, driver, space):
        copy_item = space + '-fact'

        # The person confirms pending items of the host's project at once; a copy's item is refused.
        local_items = (await commit(host, space, [fact(f'pending-{index}') for index in range(3)],
                                    project='local'))['entity_ids']
        [second_item] = (await commit(host, space, [fact('pending-second')], project='second'))['entity_ids']
        confirmed = await checked(await host.post('/v1/knowledge/batch-confirmations',
                                                  json=review_batch(space, local_items[:2])))
        assert confirmed['confirmed_count'] == 2
        refused(await host.post('/v1/knowledge/batch-confirmations', json=review_batch(space, [copy_item])),
                'replica_read_only')

        # Retrieval terms are written on the host's items and skipped on the copy's.
        candidates = await checked(await host.post('/v1/retrieval/candidates', json={
            'personal_space_id': space, 'personal_project_id': 'local'}))
        hashes = {row['item_id']: row['hash'] for row in candidates['items']}
        assert copy_item not in hashes
        terms = await checked(await host.post('/v1/retrieval/terms', json={'personal_space_id': space, 'items': [
            {'item_kind': 'entity', 'item_id': local_items[0], 'hash': hashes[local_items[0]],
             'terms': ['synthetic alias']},
            {'item_kind': 'entity', 'item_id': copy_item, 'hash': 'a' * 64, 'terms': ['copied alias']}]}))
        assert terms == {'written': 1, 'skipped': [copy_item]}

        gate(tmp_path, space, 'second', 'closed')
        refused(await host.post('/v1/knowledge/batch-confirmations',
                                json=review_batch(space, [local_items[2], second_item])), 'replica_read_only')
        assert (await view(host, space, local_items[2]))['confirmation_status'] == 'pending'
        refused(await host.post('/v1/retrieval/terms', json={'personal_space_id': space, 'items': [
            {'item_kind': 'entity', 'item_id': local_items[1], 'hash': hashes[local_items[1]],
             'terms': ['frozen alias']}]}), 'project_scope_unknown')
        rows, _, _ = await driver.execute_query('MATCH (e:Entity {uuid: $id}) RETURN e.fuli_retrieval_terms AS terms',
                                                id=local_items[1], routing_='r')
        assert rows[0]['terms'] is None

        gate(tmp_path, space, 'second', 'open')

        retried = await checked(await host.post('/v1/knowledge/batch-confirmations',
                                                json=review_batch(space, [local_items[2], second_item])))
        assert retried['confirmed_count'] == 2


@pytest.mark.asyncio
async def test_host_stop_hook_and_delegation_use_local_records_beside_a_copy(tmp_path):
    async with host_beside_copy(tmp_path) as (host, _, space):
        scope = {'personal_space_id': space, 'personal_project_id': 'local'}
        session = 'synthetic-stop-session'
        entered = await begin(host, space, 'local', 'target-lead', session, entry_via='tool')
        stop = await checked(await host.get('/v1/task-context-sessions/checkpoint', params={
            'personal_space_id': space, 'session_id': session, 'source_application': 'codex'}))
        assert stop['status'] == 'checkpoint_required' and stop['task_context_token'] == entered
        assert stop['routine_auto_close_eligible'] is True

        authority = '/v1/project-agent-context/remote-origin-authority'
        first = await checked(await host.get(authority, params={'personal_space_id': space}))
        assert first['algorithm'] == 'Ed25519' and first['public_key']
        assert await checked(await host.get(authority, params={'personal_space_id': space})) == first

        issue = '/v1/project-agent-context/owner-delegations'
        request = {**scope, 'agent_id': 'engineer', 'target_application': 'codex'}
        grant = await checked(await host.post(issue, json=request))
        receiver = 'synthetic-receiver'
        restored = await resolve(host, scope, grant['token'], receiver, agent_id='engineer')
        assert restored['status'] == 'ready' and restored['agent']['agent_id'] == 'engineer'
        check = {'personal_space_id': space, 'token': grant['token'], 'session_id': receiver}
        assert (await checked(await host.post('/v1/project-agent-context/delegations/verify', json=check)))['redeemed']
        gate(tmp_path, space, 'local', 'closed')
        refused(await host.post(issue, json=request), 'project_write_blocked')
        assert (await checked(await host.post('/v1/project-agent-context/delegations/revoke', json=check)))['revoked']


@pytest.mark.asyncio
async def test_host_manages_session_hints_bindings_and_a_cross_project_loan(tmp_path):
    async with host_beside_copy(tmp_path) as (host, driver, space):
        # A session hint is claimed once; a lead binds its coordination task.
        lead = await begin(host, space, 'local', 'target-lead', 'host-lead-session')
        hint = {'personal_space_id': space, 'source_application': 'codex', 'operation': 'project_candidate'}
        claim = f'/v1/task-contexts/{lead}/session-hints/claim'
        assert (await checked(await host.post(claim, json=hint)))['claimed'] is True
        assert (await checked(await host.post(claim, json=hint)))['claimed'] is False
        bound = (await task(host, space, 'local', 'host-bound-task', lead_agent_id='target-lead'))['task_id']
        unbound = (await task(host, space, 'local', 'host-unbound-task', lead_agent_id='target-lead'))['task_id']
        binding = f'/v1/task-contexts/{lead}/coordination-tasks'
        bind = {'personal_space_id': space, 'personal_project_id': 'local', 'source_application': 'codex'}
        linked = await checked(await host.put(binding, json={**bind, 'task_id': bound}))
        assert linked['coordination_task_ids'] == [bound]

        # A specialist of the second project is lent to the first; nothing is borrowed from the copy.
        source = await begin(host, space, 'second', 'source-lead', 'host-source-session')
        loan = {'personal_space_id': space, 'task_context_token': lead, 'source_application': 'codex',
                'source_project_id': 'second', 'specialist_id': 'specialist', 'target_task_id': bound,
                'objective': 'Build the synthetic page', 'idempotency_key': 'host-loan'}
        requested = await checked(await host.post('/v1/agent-loans/request', json=loan))
        refused(await host.post('/v1/agent-loans/request', json={
            **loan, 'source_project_id': 'alpha', 'idempotency_key': 'loan-from-copy'}), 'project_write_blocked')
        approved = await checked(await host.post('/v1/agent-loans/decide', json={
            'personal_space_id': space, 'task_context_token': source, 'source_application': 'codex',
            'loan_id': requested['loan_id'], 'decision': 'approve'}))
        assert approved['status'] == 'approved' and approved['assignment_id']
        loans = await checked(await host.post('/v1/agent-loans/query', json={
            'personal_space_id': space, 'personal_project_id': 'local'}))
        assert [row['loan_id'] for row in loans['loans']] == [requested['loan_id']]

        gate(tmp_path, space, 'local', 'closed')
        refused(await host.post(claim, json={**hint, 'operation': 'board_match'}), 'project_write_blocked')
        refused(await host.put(binding, json={**bind, 'task_id': unbound}), 'project_write_blocked')

        gate(tmp_path, space, 'local', 'open')

        assert (await checked(await host.post(claim, json={**hint, 'operation': 'board_match', 'peek': True})))[
            'available'] is True
        assert (await task_context(host, space, lead))['coordination_task_ids'] == [bound]

        # The loaned task ends: the loan closes with it, in both projects.
        await checked(await host.post(f'/v1/project-agent-tasks/{bound}/events', json={
            'personal_space_id': space, 'personal_project_id': 'local', 'task_id': bound,
            'idempotency_key': 'host-loan-task-cancelled', 'status': 'cancelled', 'summary': 'Synthetic end.',
            'source_application': 'codex'}))
        loans = await checked(await host.post('/v1/agent-loans/query', json={
            'personal_space_id': space, 'personal_project_id': 'second'}))
        assert [row['status'] for row in loans['loans']] == ['closed']


@pytest.mark.asyncio
async def test_host_updates_its_roster_and_publications_beside_a_frozen_project(tmp_path):
    async with host_beside_copy(tmp_path) as (host, driver, space):
        # The owner of `global` makes a follower's recruited FLA once.
        made = await checked(await host.post('/v1/project-agents/owner-hire', json=hire(space)))
        assert made['outcome'] == 'created'
        refused(await host.post('/v1/project-agents/owner-hire', json=hire(space, recruitment_id='synthetic-other')),
                'agent_id_taken')

        gate(tmp_path, space, 'second', 'closed')

        refused(await dismiss_agent(host, space, 'helper'), 'replica_read_only')
        helper = await checked(await host.get('/v1/project-agents/helper', params={'personal_space_id': space}))
        assert helper['profile']['status'] == 'active'
        draft = await checked(await host.post('/v1/publication-drafts', headers=PERSON, json={
            'personal_space_id': space, 'target_project_id': 'synthetic-team', 'provider_url': 'https://public.example',
            'episode': StructuredEpisode.model_validate(confirmed_episode(
                idempotency_key=str(uuid4()), source_application='codex', source_turn_id='synthetic-turn',
            )).model_dump(mode='json')}))
        ignored = await checked(await host.post(f'/v1/publication-drafts/{draft["id"]}/decision', headers=PERSON,
                                                params={'personal_space_id': space}, json={'decision': 'ignore'}))
        assert ignored['status'] == 'ignored'
        team = {'project_id': 'synthetic-team', 'provider_url': 'https://public.example'}
        await checked(await host.post('/v1/subscriptions', json={
            'personal_space_id': space, **team, 'project_name': 'Synthetic team'}))
        removed = await checked(await host.delete('/v1/subscriptions/synthetic-team', params={
            'personal_space_id': space, 'provider_url': team['provider_url']}))
        assert removed['deleted'] is True
        gate(tmp_path, space, 'second', 'open')

        await checked(await dismiss_agent(host, space, 'helper'))

        assert (await checked(await host.get(f'/v1/project-agents/{PROPOSED}',
                                             params={'personal_space_id': space})))['agent_id'] == PROPOSED


@pytest.mark.asyncio
async def test_host_recovers_its_transcript_and_migrates_a_session_beside_a_copy(tmp_path):
    async with host_beside_copy(tmp_path) as (host, driver, space):
        # A fallback boundary moves the transcript cursor of the host's project.
        journal = {'personal_space_id': space, 'personal_project_id': 'local', 'agent_id': 'engineer',
                   'source_application': 'codex', 'session_id': 'host-fallback-session'}
        older = await begin(host, space, 'local', 'engineer', journal['session_id'], entry_via='hook')
        await checked(await host.post('/v1/agent-conversations/boundary', json={
            **journal, 'task_context_token': older, 'expected_cursor': 0, 'cursor': 10, 'initialize_cursor': True}))
        newer = await begin(host, space, 'local', 'engineer', journal['session_id'], entry_via='tool')
        recovered = await checked(await host.post('/v1/agent-conversations/boundary', json={
            **journal, 'task_context_token': newer, 'expected_cursor': 10, 'cursor': 100, 'fallback_recovery': True}))
        assert recovered['status'] == 'saved'
        latest = await begin(host, space, 'local', 'engineer', journal['session_id'], entry_via='tool')
        fallback = {**journal, 'task_context_token': latest, 'expected_cursor': 100, 'cursor': 200,
                    'fallback_recovery': True}

        # A session's held items move into the project it now works in.
        await link_task(host, space, 'local')
        offer = await preview(host, space, 'local')
        assert offer['held_count'] == 2
        await checked(await migrate(host, space, 'local', offer['items'][:1], headers=PERSON))

        gate(tmp_path, space, 'local', 'closed')

        refused(await host.post('/v1/agent-conversations/boundary', json=fallback), 'project_write_blocked')
        refused(await migrate(host, space, 'local', offer['items'][1:], headers=PERSON), 'replica_read_only')
        history = await checked(await host.post('/v1/agent-conversations/query', json={
            **journal, 'mode': 'events', 'conversation_id': recovered['conversation_id']}))
        assert len(history['events']) == 1
        listed = await checked(await host.post('/v1/agent-conversations/query', json={
            **journal, 'mode': 'list', 'with_progress': True}))
        assert recovered['conversation_id'] in [row['id'] for row in listed['conversations']]
        gate(tmp_path, space, 'local', 'open')

        session = await checked(await host.post('/v1/agent-conversations/query', json={**journal, 'mode': 'session'}))
        assert session['cursor'] == 100
        assert (await preview(host, space, 'local'))['held_count'] == 1
        assert (await checked(await host.post('/v1/agent-conversations/boundary', json=fallback)))['status'] == 'saved'
