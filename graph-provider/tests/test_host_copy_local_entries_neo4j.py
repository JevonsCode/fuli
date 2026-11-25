"""A host keeping another computer's project as a copy beside two projects of
its own, on a disposable Neo4j (docs/runner-roles-design.md §12).

Every entry the host-copy review listed writes the host's own two projects:
task activity and completion with executor learning, a session's and the
person's block clears, the person's close, the coordination policy, the
second half of an approved hire, a checkpoint with knowledge usage, vectors.
The copy stays read-only and unchanged. A capture and a checkpoint that
records usage run together and both finish (the process locks keep one order).
All data is synthetic.
"""
import asyncio
from uuid import uuid4

import pytest

from test_agent_collaboration_neo4j import context as verification_context
from test_agent_delegations_neo4j import sealed_worker_run
from test_executor_evidence_neo4j import actual_payload
from test_host_project_copy_neo4j import registry
from test_project_agent_activity_atomicity_neo4j import seed_executor
from test_project_agent_memory_neo4j import FIXTURE_REVIEW_TOKEN, fixture_settings, provider_client, seed_agent
from test_project_freeze_neo4j import make_gates
from test_replica_write_guard_neo4j import episode
from test_scope_export_neo4j import checked, cleanup, export
from test_scope_import_neo4j import OWNER, OTHER, clear, scenario
from test_task_checkpoint_replay_neo4j import checkpoint

PERSON = {'x-fuli-human-review-token': FIXTURE_REVIEW_TOKEN}
MODEL = 'synthetic-embedding-model'


async def task(client, space, project, key, **fields):
    created = await checked(await client.post('/v1/project-agent-tasks', json={
        'personal_space_id': space, 'personal_project_id': project, 'idempotency_key': key,
        'title': f'Synthetic {key}', 'objective': 'Exercise a host write beside a copy.',
        'work_kind': 'implementation', 'lead_agent_id': 'engineer', 'source_application': 'codex',
        'routing_reason': 'Synthetic host-copy acceptance.', **fields}))
    return created['task']


async def report(client, current, status, key, **fields):
    response = await client.post(f'/v1/project-agent-tasks/{current["task_id"]}/events', json={
        'personal_space_id': current['personal_space_id'], 'personal_project_id': current['personal_project_id'],
        'task_id': current['task_id'], 'agent_id': 'engineer', 'expected_revision': current['revision'],
        'idempotency_key': key, 'status': status, 'summary': f'Synthetic {status}.',
        'source_application': 'codex', **fields})
    return await checked(response)


async def copy_summary(client, space):
    return await checked(await client.get('/v1/scopes/replica-summary',
                                          params={'scope': 'project:alpha', 'personal_space_id': space}))


@pytest.mark.asyncio
async def test_a_host_writes_its_two_projects_beside_a_copy_through_every_listed_entry(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        driver, space, group = await scenario(client)
        try:
            image = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            for project in ('local', 'second'):
                await seed_agent(client, space, project=project)
            await seed_executor(client, space)
            await checked(await client.post('/v1/project-agents/system-hr', params={'personal_space_id': space}))
            first = await task(client, space, 'local', 'host-local-task')
            other = await task(client, space, 'second', 'host-second-task')
            verify_scope = {'personal_space_id': space, 'personal_project_id': 'second'}
            artifact_task = await task(client, space, 'second', 'verified-artifact', verification_required=True)
            ctx = await verification_context(client, verify_scope, 'engineer', 'synthetic-verification-session')
            actual = actual_payload(verify_scope, artifact_task, artifact_revision='first-revision')
            await checked(await client.post('/v1/project-agent-executor-actuals', json=actual))
            attempt = {**verify_scope, 'task_id': artifact_task['task_id'], 'artifact_revision': 'first-revision',
                       'task_context_token': ctx['token'], 'source_application': 'codex', 'attempt_id': 'paired-attempt',
                       'outcome': 'pass', 'evidence_refs': ['synthetic:verified'], 'executor_id': actual['executor_id'],
                       'provider': actual['provider'], 'model': actual['model'], 'run_id': actual['run_id']}
            own_item = str(uuid4())
            await driver.execute_query('''
                MATCH (space:FuliSpace {id: $space})
                CREATE (:Entity {uuid: $item, group_id: space.group_id, name: 'Synthetic host rule',
                  summary: 'Kept by the host itself.', fuli_usage_generation: 1, fuli_confirmation_status: 'pending'})
                ''', space=space, item=own_item)
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
                verification = await checked(await host.post('/v1/agent-verification/record', json=attempt))
                assert verification['attempt_count'] == 1

                # Progress, a block its own session ends, and completion with executor evidence.
                first = await report(host, first, 'running', 'local-running')
                first = await report(host, first, 'blocked', 'local-blocked', source_session_id='block-session')
                cleared = await checked(await host.post('/v1/project-agent-task-blockers/clear', json={
                    'personal_space_id': space, 'source_application': 'codex',
                    'source_session_id': 'block-session', 'cause': 'session_activity'}))
                assert cleared['cleared_task_ids'] == [first['task_id']]
                first = await checked(await host.get(f'/v1/project-agent-tasks/{first["task_id"]}',
                                                     params={'personal_space_id': space, 'personal_project_id': 'local'}))
                done = await report(host, first, 'cancelled', 'local-terminal', worker_id='synthetic-host-worker',
                                    worker_status='cancelled', actual_executor_id='synthetic-executor',
                                    actual_model_provider='synthetic', actual_model='synthetic-model')
                assert done['status'] == 'cancelled'
                evidence, _, _ = await driver.execute_query('''
                    MATCH (:FuliProjectAgentTask {task_id: $task})-[:HAS_EXECUTOR_OUTCOME_EVIDENCE]->(evidence)
                    RETURN count(evidence) AS count''', task=first['task_id'], routing_='r')
                assert evidence[0]['count'] >= 1

                # The person ends a block, then closes the task, in the second project.
                other = await report(host, other, 'running', 'second-running')
                other = await report(host, other, 'blocked', 'second-blocked', source_session_id='second-session')
                unblocked = await checked(await host.post(f'/v1/project-agent-tasks/{other["task_id"]}/blocker/clear',
                    json={'personal_space_id': space, 'personal_project_id': 'second'}, headers=PERSON))
                assert unblocked['status'] == 'running'
                closed = await checked(await host.post(f'/v1/project-agent-tasks/{other["task_id"]}/close', json={
                    'personal_space_id': space, 'personal_project_id': 'second', 'status': 'completed',
                    'summary': 'The person accepted the synthetic result.'}, headers=PERSON))
                assert closed['status'] == 'completed'

                # A coordination policy of the host's project; the copy's stays its owner's.
                policy = {'personal_space_id': space, 'personal_project_id': 'second',
                          'ask_before_recruitment': True, 'auto_reuse_previous_agent': True}
                await checked(await host.put('/v1/project-agent-coordination-policy', json=policy))
                refused = await host.put('/v1/project-agent-coordination-policy',
                                         json={**policy, 'personal_project_id': 'alpha'})
                assert refused.status_code == 409, refused.text
                assert refused.json()['detail']['code'] == 'project_write_blocked'

                # A hire the person approves: its second half activates the task.
                submitted = await checked(await host.post('/v1/project-agent-tasks', json={
                    'personal_space_id': space, 'personal_project_id': 'second',
                    'idempotency_key': 'host-second-hire', 'title': 'Synthetic hire',
                    'objective': 'Hire beside a copy.', 'work_kind': 'verification', 'source_application': 'codex',
                    'staffing_intent': 'new_durable', 'routing_reason': 'Synthetic acceptance.'}))
                recruitment = submitted['recruitment']
                assert recruitment['status'] == 'awaiting_confirmation'
                await checked(await host.post(
                    f'/v1/project-agent-recruitments/{recruitment["recruitment_id"]}/decision', json={
                        'personal_space_id': space, 'personal_project_id': 'second',
                        'recruitment_id': recruitment['recruitment_id'], 'decision': 'approve',
                        'expected_revision': recruitment['revision'], 'reason': 'Synthetic approval.'}))
                hired = await checked(await host.get(f'/v1/project-agent-tasks/{submitted["task"]["task_id"]}',
                                                     params={'personal_space_id': space, 'personal_project_id': 'second'}))
                assert hired['status'] != 'awaiting_recruitment'
                assert hired['lead_agent_id'] == recruitment['proposed_agent_id']

                # A checkpoint records its use of the host's item; the copy's is its owner's.
                context = {'personal_space_id': space, 'personal_project_id': 'local', 'project_agent_id': 'engineer',
                           'session_id': f'synthetic-{uuid4()}', 'source_application': 'codex',
                           'token': f'fuli-task-{uuid4()}', 'turn_id': 'first-turn'}
                await checked(await host.put('/v1/task-contexts', json=context))
                usage = [{'item_id': own_item, 'item_kind': 'entity', 'use_kind': 'applied'},
                         {'item_id': space + '-fact', 'item_kind': 'entity', 'use_kind': 'cited'}]
                saved = await checked(await host.put(f'/v1/task-contexts/{context["token"]}/checkpoint',
                                                     json=checkpoint(context, knowledge_usage=usage)))
                result = saved['checkpoint']['knowledge_usage_result']
                assert (result['recorded_count'], result['held_by_owner_count']) == (1, 1)

                # Vectors are derived: the host's items and the copy's both get them.
                pending = await checked(await host.post('/v1/semantic/pending', json={
                    'personal_space_id': space, 'model': MODEL, 'limit': 64}))
                assert pending['items']
                vector = [1.0] + [0.0] * 39
                written = await checked(await host.post('/v1/semantic/vectors', json={
                    'personal_space_id': space, 'model': MODEL, 'items': [
                        {'item_kind': row['item_kind'], 'item_id': row['item_id'], 'hash': row['hash'],
                         'vector': vector} for row in pending['items']]}))
                assert written == {'written': len(pending['items']), 'skipped': []}

                assert await copy_summary(host, space) == copied
        finally:
            await cleanup(driver, space, group)


@pytest.mark.asyncio
async def test_a_capture_and_a_checkpoint_recording_usage_finish_together_beside_a_copy(tmp_path):
    settings = fixture_settings()
    async with provider_client(settings) as (client, token):
        driver, space, group = await scenario(client)
        try:
            image = await export(client, space, 'project:alpha')
            await clear(driver, space, group)
            await seed_agent(client, space, project='local')
            scope = {'personal_space_id': space, 'personal_project_id': 'local'}
            _, _, worker_headers, run, session = await sealed_worker_run(client, scope)
            admitted = await checked(await client.post(run + '/contexts', json=session, headers=worker_headers))
            worker_token = admitted['task_context']['token']
            own_item = str(uuid4())
            await driver.execute_query('''
                MATCH (space:FuliSpace {id: $space})
                CREATE (:Entity {uuid: $item, group_id: space.group_id, name: 'Synthetic concurrent rule',
                  fuli_usage_generation: 1, fuli_confirmation_status: 'pending'})
                ''', space=space, item=own_item)
            file = tmp_path / 'authority.sqlite'
            registry(file, space)
            make_gates(tmp_path, space, [('alpha', 'replica', 1, 'open', None), ('local', 'owner', 1, 'open', None)])
            trusted = settings.model_copy(update={'project_registry_path': str(file), 'project_registry_version': 11,
                'project_gate_directory': str(tmp_path), 'project_gate_space': space,
                'project_authority_fingerprint': OTHER, 'project_device_fingerprint': OTHER})
            async with provider_client(trusted, token) as (host, _):
                await checked(await host.post('/v1/scopes/import', json=image,
                                              params={'owner': OWNER, 'generation': 1, 'pairing': 'pair'}))
                contexts = []
                for turn in range(3):
                    context = {'personal_space_id': space, 'personal_project_id': 'local',
                               'project_agent_id': 'engineer', 'session_id': f'synthetic-{uuid4()}',
                               'source_application': 'codex', 'token': f'fuli-task-{uuid4()}', 'turn_id': f'turn-{turn}'}
                    await checked(await host.put('/v1/task-contexts', json=context))
                    contexts.append(context)
                usage = [{'item_id': own_item, 'item_kind': 'entity', 'use_kind': 'applied'}]
                calls = []
                for turn, context in enumerate(contexts):
                    calls.append(host.put(f'/v1/task-contexts/{context["token"]}/checkpoint',
                                          json=checkpoint(context, knowledge_usage=usage)))
                    calls.append(host.post('/v1/knowledge/commits', json={
                        'space_id': space, 'personal_project_id': 'local', 'episode': episode(f'concurrent-{turn}')}))
                worker_checkpoint = checkpoint(scope, fingerprint='e' * 64, knowledge_usage=usage,
                    work_log={'status': 'completed', 'summary': 'Verified worker capture.'})
                calls.append(host.put(f'/v1/task-contexts/{worker_token}/checkpoint', json=worker_checkpoint))
                responses = await asyncio.wait_for(asyncio.gather(*calls), 90)
                assert [response.status_code for response in responses] == [200] * len(calls), [
                    response.text for response in responses if response.status_code != 200]
                await checked(await host.put(f'/v1/task-contexts/{worker_token}/checkpoint',
                                             json={**worker_checkpoint, 'phase': 'complete'}))
        finally:
            await cleanup(driver, space, group)
