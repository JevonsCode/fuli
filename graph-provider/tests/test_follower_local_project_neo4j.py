"""A follower works in a project of its own beside its read-only copy of
`global` (docs/runner-roles-design.md §11 3b/3c, §12), on a disposable Neo4j
through the full Provider app with the replica guard checking every write
(STRICT): the ordinary work of such a project succeeds, and after every step
the copy is as it was imported (its summary digest).

The host is played first in the same graph, the follower after it under the
same space ID (test_follower_space_neo4j.py). Synthetic data only.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1.
"""
from uuid import uuid4

import pytest

from fuli_graph.fixed_roles import SYSTEM_COORDINATOR_AGENT_ID
from fuli_graph.provider_values import graphiti_group_id
from test_ai_review_neo4j import _commit_project_entity, _read_candidate, _revise_summary, _start_tonborg_review
from test_follower_space_neo4j import (  # noqa: F401
    HABIT, alone, follower_settings, host_global, no_personal_space, strict,
)
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_replica_recruitment_owner_neo4j import (
    LOCAL, ON_OWNER, copy_digest, follower_with_local_project, staff_lead, verify_and_finish,
)
from test_replica_write_guard_neo4j import REVIEW, episode, personal_tag
from test_scope_export_neo4j import checked, cleanup


@pytest.mark.asyncio
async def test_a_followers_own_project_works_and_its_copy_of_global_stays(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings, seed=personal_tag)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    tag_id = next(entry['properties']['id'] for entry in envelope['nodes'] if entry['id'].startswith('FuliKnowledgeTag:')
                  and entry['properties'].get('namespace_kind') == 'personal')
    suffix = uuid4().hex[:8]
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await follower_with_local_project(client, settings, space_id, envelope)
            digest = await copy_digest(client, space_id)

            async def unchanged(step):
                assert await copy_digest(client, space_id) == digest, step

            # Task entry: the host's habit, and the host's FLA staffed on this project.
            entry = await checked(await client.get('/v1/collaboration-preferences', params={
                'personal_space_id': space_id, 'personal_project_id': LOCAL}))
            assert HABIT in str(entry)
            # With no lead yet, the entry hires one: it waits for the host to make it.
            staffed = await staff_lead(client, space_id)
            assert (staffed['status'], staffed['reason']) == ('unassigned', ON_OWNER)
            await unchanged('a lead the project hires')
            await checked(await client.post('/v1/project-agent-assignments', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'agent_id': 'scope-lead',
                'idempotency_key': f'assign-{suffix}', 'responsibility': 'Keep the sample.',
                'work_kinds': ['implementation'], 'capabilities': ['coding'], 'reason': 'Synthetic staffing.'}))
            # The project's own lead, kept in the project's own policy.
            await checked(await client.put('/v1/project-agent-coordination-policy', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'team_lead_agent_id': 'scope-lead'}))
            resolved = await checked(await client.post('/v1/project-agent-context/resolve', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'source_application': 'codex'}))
            assert resolved['agent']['agent_id'] == 'scope-lead'
            await unchanged('task entry')

            # A project item tagged with a tag of the host's personal vocabulary.
            item = await _commit_project_entity(client, space_id, LOCAL, f'local-{suffix}',
                                                name='Synthetic local fact', summary='The sample keeps a ledger.')
            tagged = await checked(await client.post('/v1/knowledge-tags/attach', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL, 'tag_id': tag_id,
                'item_kind': 'entity', 'item_id': item}))
            assert tagged['outcome'] == 'attached'
            await unchanged('tag a project item')

            # The project item revised, confirmed by the person, then deleted for good.
            revised = await _revise_summary(client, space_id, LOCAL, item, 'The sample keeps two ledgers.',
                                            'Synthetic correction.')
            item = revised.get('version_item_id') or item
            await checked(await client.post('/v1/knowledge/batch-confirmations', json={
                'personal_space_id': space_id, 'group_kind': 'review', 'group_value': 'pending',
                'reason': 'Synthetic review.', 'operation_actor': 'human',
                'confirmer': {'kind': 'user', 'label': 'Synthetic user'},
                'items': [{'item_id': item, 'item_kind': 'entity', 'existence_reason': 'Synthetic.',
                           'quadrant_reason': 'Synthetic.', 'proposed_by': {'kind': 'agent', 'label': 'Codex'}}]}))
            await unchanged('revise and confirm a project item')

            # Project knowledge that builds on the host's habit: a capture restating it lands on its own records.
            restated = episode(f'restated-{suffix}', habit=True)
            restated['entities'][0]['name'] = HABIT
            await checked(await client.post('/v1/knowledge/commits', json={
                'space_id': space_id, 'personal_project_id': LOCAL, 'episode': restated}))
            await unchanged('a project capture restating a global habit')

            # One Tonborg judgment: the host's Tonborg reviews a pending item of this project.
            pending = await _commit_project_entity(client, space_id, LOCAL, f'review-{suffix}',
                                                   name='Synthetic pending fact', summary='The sample needs a check.')
            run = await _start_tonborg_review(client, space_id, LOCAL)
            candidate = await _read_candidate(client, space_id, run['review_id'], pending)
            await checked(await client.post('/v1/knowledge/reviews/progress', json={
                'personal_space_id': space_id, 'review_id': run['review_id'],
                'candidate_key': candidate['candidate_key'], 'outcome': 'ai_reviewed',
                'ai_review_evidence_token': candidate['ai_review_evidence_token'], 'confirm_as_agent': True,
                'ai_assessment': {'outcome': 'approve', 'summary': 'The synthetic statement holds.',
                                  'evidence': ['The current entity content is the reviewed statement.'],
                                  'confidence': 0.9, 'model': 'synthetic-review-model'}}))
            await unchanged('a Tonborg judgment')

            plan = await checked(await client.post(f'/v1/knowledge/items/{item}/hard-delete/preview', json={
                'personal_space_id': space_id, 'item_kind': 'entity'}, headers=REVIEW))
            await checked(await client.post(f'/v1/knowledge/items/{item}/hard-delete', json={
                'personal_space_id': space_id, 'item_kind': 'entity', 'preview_id': plan['preview_id'],
                'confirmation': '删除'}, headers=REVIEW))
            await unchanged('hard-delete a project item')

            # A task Jefa (the host's) coordinates, worked by the host's FLA, from queued to review
            # (an Agent's own completion waits for a verified revision).
            routed = await checked(await client.post('/v1/project-agent-tasks', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL,
                'idempotency_key': f'jefa-task-{suffix}', 'title': 'Synthetic ledger check',
                'objective': 'Check the synthetic ledger.', 'work_kind': 'implementation',
                'source_application': 'codex', 'coordinator_agent_id': SYSTEM_COORDINATOR_AGENT_ID,
                'routing_reason': 'Synthetic acceptance.'}))
            task = routed['task']
            assert task['coordinator_agent_id'] == SYSTEM_COORDINATOR_AGENT_ID
            assert routed['assigned_agent']['agent_id'] == 'scope-lead'
            for status in ('running', 'awaiting_review'):
                task = await checked(await client.post(f"/v1/project-agent-tasks/{task['task_id']}/events", json={
                    'personal_space_id': space_id, 'personal_project_id': LOCAL, 'task_id': task['task_id'],
                    'idempotency_key': f'jefa-task-{suffix}:{status}', 'status': status,
                    'summary': f'Synthetic {status}.', 'agent_id': 'scope-lead', 'source_application': 'codex'}))
            assert task['status'] == 'awaiting_review'
            await verify_and_finish(client, {'personal_space_id': space_id, 'personal_project_id': LOCAL}, task)
            await unchanged('a verified and completed task Jefa coordinates')

            # A task that needs a new FLA waits for the host to make it.
            hire = await checked(await client.post('/v1/project-agent-tasks', json={
                'personal_space_id': space_id, 'personal_project_id': LOCAL,
                'idempotency_key': f'hire-{suffix}', 'title': 'Synthetic new specialist',
                'objective': 'Hire a specialist for the sample.', 'work_kind': 'verification',
                'source_application': 'codex', 'staffing_intent': 'new_durable',
                'routing_reason': 'Synthetic acceptance.'}))
            waiting = hire['recruitment']
            assert (waiting['status'], waiting['reason_code']) == ('blocked', ON_OWNER)
            assert hire['task']['status'] == 'awaiting_recruitment'
            await unchanged('a task that needs a new FLA')
        finally:
            await cleanup(driver.maintenance(), space_id, group)
