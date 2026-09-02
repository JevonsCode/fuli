"""Staffing combinations over public HTTP and an explicitly disposable Neo4j.

Roles, task history and sessions are synthetic. No model process is started;
these tests prove persisted routing, not product hooks or executor availability.
"""

import asyncio

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client


async def create_scope(client):
    space = await client.post('/v1/spaces', json={
        'name': 'Synthetic staffing combinations', 'kind': 'personal',
    })
    assert space.status_code == 200, space.text
    scope = {'personal_space_id': space.json()['id'],
             'personal_project_id': 'synthetic-staffing'}
    project = await client.put('/v1/personal-projects', json={
        'personal_space_id': scope['personal_space_id'],
        'project_id': scope['personal_project_id'],
        'profile': {'name': 'Synthetic staffing project', 'lifecycle': 'active'},
    })
    assert project.status_code == 200, project.text
    return scope


async def assign_role(client, scope, agent, capabilities, *, work_kind='implementation',
                      profile_capabilities=None):
    # Deliberately create space identity separately: a legacy upsert would copy
    # profile capabilities into the assignment and hide precedence regressions.
    identity = await client.put('/v1/project-agents', json={
        'personal_space_id': scope['personal_space_id'], 'agent_id': agent,
        'profile': {'name': f'Synthetic {agent}', 'responsibility': 'Maintain the sample.',
            'capabilities': capabilities if profile_capabilities is None
                else profile_capabilities,
            'work_kinds': [work_kind], 'allowed_clients': ['codex', 'claude_code', 'cursor'],
            'test_source': 'synthetic_staffing_acceptance', 'cleanup_eligible': True},
    })
    assert identity.status_code == 200, identity.text
    assignment = await client.post('/v1/project-agent-assignments', json={
        **scope, 'agent_id': agent, 'idempotency_key': f'synthetic-assign-{agent}',
        'responsibility': 'Maintain the synthetic project.', 'work_kinds': [work_kind],
        'capabilities': capabilities, 'reason': 'Synthetic persisted staffing acceptance.',
        'source_application': 'codex',
    })
    assert assignment.status_code == 200, assignment.text
    assert assignment.json()['capabilities'] == capabilities


async def resolve_role(client, scope, **changes):
    response = await client.post('/v1/project-agent-context/resolve', json={
        **scope, 'source_application': 'codex', 'work_kind': 'implementation',
        'required_capabilities': ['coding', 'review'], **changes,
    })
    assert response.status_code == 200, response.text
    assert response.json()['worker_started'] is False
    return response.json()


async def begin_session(client, scope, agent):
    response = await client.put('/v1/task-contexts', json={
        **scope, 'project_agent_id': agent, 'source_application': 'codex',
        'session_id': f'synthetic-session-{agent}', 'turn_id': 'synthetic-turn-one',
        'token': f'fuli-task-synthetic-staffing-{agent}',
    })
    assert response.status_code == 200, response.text
    return response.json()


async def submit_task(client, scope, **changes):
    response = await client.post('/v1/project-agent-tasks', json={
        **scope, 'idempotency_key': 'synthetic-staffing-task',
        'title': 'Synthetic staffing history', 'objective': 'Verify persisted role routing.',
        'work_kind': 'implementation', 'source_application': 'codex',
        'required_capabilities': ['coding', 'review'],
        'routing_reason': 'Synthetic staffing acceptance without model execution.', **changes,
    })
    assert response.status_code == 200, response.text
    return response.json()['task']


async def record_history(client, scope, agent, *, work_kind='implementation'):
    task = await submit_task(client, scope, lead_agent_id=agent, work_kind=work_kind,
                             idempotency_key=f'synthetic-history-{agent}')
    # Cancellation is a real terminal record, not invented successful execution.
    terminal = await client.post(f'/v1/project-agent-tasks/{task["task_id"]}/events', json={
        **scope, 'task_id': task['task_id'], 'agent_id': agent,
        'expected_revision': task['revision'], 'status': 'cancelled',
        'idempotency_key': f'synthetic-cancel-{agent}', 'source_application': 'codex',
        'summary': 'Synthetic cancelled history; no executor was started.',
    })
    assert terminal.status_code == 200, terminal.text


@pytest.mark.asyncio
async def test_project_bound_task_and_activity_reads_do_not_cross_projects():
    """Synthetic two-project acceptance for a project-bound remote read seam."""

    async with provider_client(fixture_settings()) as (client, _):
        project_a = await create_scope(client)
        await assign_role(client, project_a, 'shared-agent', ['coding', 'review'])
        project_b = {**project_a, 'personal_project_id': 'synthetic-staffing-b'}
        created_b = await client.put('/v1/personal-projects', json={
            'personal_space_id': project_b['personal_space_id'],
            'project_id': project_b['personal_project_id'],
            'profile': {'name': 'Synthetic staffing project B', 'lifecycle': 'active'},
        })
        assert created_b.status_code == 200, created_b.text
        assigned_b = await client.post('/v1/project-agent-assignments', json={
            **project_b, 'agent_id': 'shared-agent',
            'idempotency_key': 'synthetic-assign-shared-agent-b',
            'responsibility': 'Maintain synthetic project B.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic cross-project read isolation acceptance.',
            'source_application': 'codex',
        })
        assert assigned_b.status_code == 200, assigned_b.text

        task_b = await submit_task(
            client, project_b, lead_agent_id='shared-agent',
            idempotency_key='synthetic-project-b-task',
        )
        terminal_b = await client.post(
            f'/v1/project-agent-tasks/{task_b["task_id"]}/events',
            json={
                **project_b, 'task_id': task_b['task_id'],
                'agent_id': 'shared-agent', 'expected_revision': task_b['revision'],
                'status': 'cancelled',
                'idempotency_key': 'synthetic-project-b-cancelled',
                'source_application': 'codex',
                'summary': 'Synthetic cancelled task; no executor was started.',
            },
        )
        assert terminal_b.status_code == 200, terminal_b.text

        hidden_task = await client.get(
            f'/v1/project-agent-tasks/{task_b["task_id"]}', params={
                'personal_space_id': project_a['personal_space_id'],
                'personal_project_id': project_a['personal_project_id'],
            },
        )
        assert hidden_task.status_code == 404, hidden_task.text

        activity_a = await client.get('/v1/project-agents/shared-agent/activity', params={
            'personal_space_id': project_a['personal_space_id'],
            'personal_project_id': project_a['personal_project_id'],
            'from': '2020-01-01', 'to': '2100-01-01',
        })
        assert activity_a.status_code == 200, activity_a.text
        assert [task for day in activity_a.json()['days'] for task in day['tasks']] == []

        activity_b = await client.get('/v1/project-agents/shared-agent/activity', params={
            'personal_space_id': project_b['personal_space_id'],
            'personal_project_id': project_b['personal_project_id'],
            'from': '2020-01-01', 'to': '2100-01-01',
        })
        assert activity_b.status_code == 200, activity_b.text
        assert [task['task_id'] for day in activity_b.json()['days']
                for task in day['tasks']] == [task_b['task_id']]


@pytest.mark.asyncio
@pytest.mark.parametrize('source', ['codex', 'claude_code', 'cursor'])
async def test_all_required_capabilities_select_one_lead_in_context_and_task(source):
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'coding-only', ['coding'])
        await assign_role(client, scope, 'review-only', ['review'])
        await assign_role(client, scope, 'fully-qualified', ['coding', 'review'],
                          work_kind='maintenance')
        selected = await resolve_role(client, scope, source_application=source,
                                      required_capabilities=['CODING', 'Review'])
        assert selected['status'] == 'ready'
        assert selected['agent']['agent_id'] == 'fully-qualified'
        assert selected['reason'] == 'exact_capability'
        task = await submit_task(client, scope, source_application=source)
        assert task['lead_agent_id'] == 'fully-qualified'
        assert [(item['agent_id'], item['role']) for item in task['participants']] == [
            ('fully-qualified', 'lead')]
        impossible = await resolve_role(client, scope, source_application=source,
                                        required_capabilities=['coding', 'review', 'absent'])
        assert impossible['status'] == 'unassigned'
        assert impossible['agent'] is None


@pytest.mark.asyncio
async def test_nonempty_assignment_capabilities_override_profile_in_both_directions():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'profile-only-match', ['coding'],
                          profile_capabilities=['coding', 'review'])
        await assign_role(client, scope, 'assignment-match', ['coding', 'review'],
                          profile_capabilities=['coding'])
        selected = await resolve_role(client, scope)
        assert selected['agent']['agent_id'] == 'assignment-match'
        assert selected['agent']['profile']['capabilities'] == ['coding']
        active = [item for item in selected['agent']['assignments'] if item['status'] == 'active']
        assert len(active) == 1
        assert active[0]['capabilities'] == ['coding', 'review']
        task = await submit_task(client, scope)
        assert task['lead_agent_id'] == 'assignment-match'


@pytest.mark.asyncio
async def test_legacy_upsert_reactivates_an_ended_assignment_consistently():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        profile = {
            'name': 'Synthetic legacy role',
            'responsibility': 'Reactivate legacy assignment consistently.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_legacy_assignment_acceptance',
            'cleanup_eligible': True,
        }
        created = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'ended-legacy-role', 'profile': profile,
        })
        assert created.status_code == 200, created.text
        assignment = created.json()['assignments'][0]
        ended = await client.post('/v1/project-agent-assignments/end', json={
            **scope, 'assignment_id': assignment['assignment_id'],
            'expected_revision': assignment['revision'],
            'reason': 'Synthetic terminal assignment state.',
        })
        assert ended.status_code == 200, ended.text
        assert ended.json()['status'] == 'ended'

        replayed = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'ended-legacy-role', 'profile': profile,
        })
        assert replayed.status_code == 200, replayed.text
        assignments = replayed.json()['assignments']
        assert len(assignments) == 1
        assert assignments[0]['status'] == 'active'
        assert assignments[0]['revision'] == ended.json()['revision'] + 1
        assert assignments[0]['ended_at'] is None
        assert assignments[0]['end_reason'] is None
        assert assignments[0]['replaced_by_assignment_id'] is None

        selected = await resolve_role(client, scope)
        assert selected['status'] == 'ready'
        assert selected['agent']['agent_id'] == 'ended-legacy-role'


@pytest.mark.asyncio
async def test_profile_upsert_cannot_bypass_the_dedicated_archive_operation():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        profile = {
            'name': 'Synthetic archive boundary role',
            'responsibility': 'Exercise the dedicated archive boundary.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_archive_boundary_acceptance',
            'cleanup_eligible': True,
        }
        created = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'archive-boundary-role', 'profile': profile,
        })
        assert created.status_code == 200, created.text
        active_assignment = created.json()['assignments'][0]

        bypass = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'archive-boundary-role',
            'profile': {**profile, 'status': 'archived'},
        })
        assert bypass.status_code == 422, bypass.text
        assert 'dedicated archive operation' in bypass.text

        unchanged = await client.get(
            '/v1/project-agents/archive-boundary-role', params=scope,
        )
        assert unchanged.status_code == 200, unchanged.text
        assert unchanged.json()['profile']['status'] == 'active'
        assert unchanged.json()['assignments'][0] == active_assignment

        archived = await client.delete(
            '/v1/project-agents/archive-boundary-role',
            params={
                'personal_space_id': scope['personal_space_id'],
                'reason': 'Synthetic dedicated archive acceptance.',
            },
        )
        assert archived.status_code == 200, archived.text
        assert archived.json()['profile']['status'] == 'archived'
        ended_assignment = archived.json()['assignments'][0]
        assert ended_assignment['status'] == 'ended'
        assert ended_assignment['revision'] == active_assignment['revision'] + 1
        assert ended_assignment['end_reason'] == (
            'Synthetic dedicated archive acceptance.'
        )

        restore_bypass = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'archive-boundary-role',
            'profile': profile,
        })
        assert restore_bypass.status_code == 409, restore_bypass.text
        assert 'dedicated restore operation' in restore_bypass.text

        preserved = await client.get(
            '/v1/project-agents/archive-boundary-role',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert preserved.status_code == 200, preserved.text
        assert preserved.json()['profile']['status'] == 'archived'
        assert preserved.json()['assignments'][0] == ended_assignment


@pytest.mark.asyncio
async def test_archive_between_profile_and_legacy_assignment_wins_atomically(
    monkeypatch,
):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    settings = fixture_settings()
    execute_query = Neo4jDriver.execute_query
    legacy_write_reached = asyncio.Event()
    continue_legacy_write = asyncio.Event()
    paused = False

    async def pause_legacy_assignment(driver, query, **kwargs):
        nonlocal paused
        if (
            not paused
            and "assignment.reason = 'legacy project Agent profile'" in query
            and kwargs.get('agent_id') == 'legacy-archive-race-role'
        ):
            paused = True
            legacy_write_reached.set()
            await continue_legacy_write.wait()
        return await execute_query(driver, query, **kwargs)

    async with provider_client(
        settings, raise_app_exceptions=False,
    ) as (client, _):
        scope = await create_scope(client)
        profile = {
            'name': 'Synthetic legacy archive race role',
            'responsibility': 'Exercise profile-to-assignment serialization.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_legacy_archive_race',
            'cleanup_eligible': True,
        }
        created = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'legacy-archive-race-role',
            'profile': profile,
        })
        assert created.status_code == 200, created.text

        with monkeypatch.context() as concurrent:
            concurrent.setattr(
                Neo4jDriver,
                'execute_query',
                pause_legacy_assignment,
            )
            refresh_request = asyncio.create_task(client.put(
                '/v1/project-agents',
                json={
                    **scope,
                    'agent_id': 'legacy-archive-race-role',
                    'profile': {
                        **profile,
                        'responsibility': 'Updated before the archive race.',
                    },
                },
            ))
            await asyncio.wait_for(legacy_write_reached.wait(), timeout=30)
            archived = await client.delete(
                '/v1/project-agents/legacy-archive-race-role',
                params={
                    'personal_space_id': scope['personal_space_id'],
                    'reason': 'Synthetic archive wins before legacy refresh.',
                },
            )
            assert archived.status_code == 200, archived.text
            ended_assignment = archived.json()['assignments'][0]
            continue_legacy_write.set()
            refreshed = await asyncio.wait_for(refresh_request, timeout=30)

        assert refreshed.status_code == 409, refreshed.text
        assert 'dedicated restore operation' in refreshed.text
        preserved = await client.get(
            '/v1/project-agents/legacy-archive-race-role',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert preserved.status_code == 200, preserved.text
        assert preserved.json()['profile']['status'] == 'archived'
        assert preserved.json()['assignments'][0] == ended_assignment


@pytest.mark.asyncio
async def test_archive_after_assignment_authorization_blocks_assignment_create(
    monkeypatch,
):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    settings = fixture_settings()
    execute_query = Neo4jDriver.execute_query
    assignment_write_reached = asyncio.Event()
    continue_assignment_write = asyncio.Event()
    paused = False

    async def pause_assignment_create(driver, query, **kwargs):
        nonlocal paused
        if (
            not paused
            and 'MERGE (assignment:FuliProjectAgentAssignment' in query
            and kwargs.get('reason') == 'Synthetic assignment race.'
        ):
            paused = True
            assignment_write_reached.set()
            await continue_assignment_write.wait()
        return await execute_query(driver, query, **kwargs)

    async with provider_client(
        settings, raise_app_exceptions=False,
    ) as (client, _):
        scope = await create_scope(client)
        identity = await client.put('/v1/project-agents', json={
            'personal_space_id': scope['personal_space_id'],
            'agent_id': 'assignment-create-race-role',
            'profile': {
                'name': 'Synthetic assignment create race role',
                'responsibility': 'Exercise authorization-to-write serialization.',
                'capabilities': ['coding'],
                'work_kinds': ['implementation'],
                'allowed_clients': ['codex'],
                'test_source': 'synthetic_assignment_create_race',
                'cleanup_eligible': True,
            },
        })
        assert identity.status_code == 200, identity.text
        with monkeypatch.context() as concurrent:
            concurrent.setattr(
                Neo4jDriver,
                'execute_query',
                pause_assignment_create,
            )
            assignment_request = asyncio.create_task(client.post(
                '/v1/project-agent-assignments',
                json={
                    **scope,
                    'agent_id': 'assignment-create-race-role',
                    'idempotency_key': 'synthetic-assignment-create-race',
                    'responsibility': 'Own the synthetic race role.',
                    'work_kinds': ['implementation'],
                    'capabilities': ['coding'],
                    'reason': 'Synthetic assignment race.',
                    'source_application': 'codex',
                },
            ))
            await asyncio.wait_for(assignment_write_reached.wait(), timeout=30)
            archived = await client.delete(
                '/v1/project-agents/assignment-create-race-role',
                params={
                    'personal_space_id': scope['personal_space_id'],
                    'reason': 'Synthetic archive wins after authorization.',
                },
            )
            assert archived.status_code == 200, archived.text
            continue_assignment_write.set()
            assignment = await asyncio.wait_for(assignment_request, timeout=30)

        assert assignment.status_code == 409, assignment.text
        assert 'not active' in assignment.text
        preserved = await client.get(
            '/v1/project-agents/assignment-create-race-role',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert preserved.status_code == 200, preserved.text
        assert preserved.json()['profile']['status'] == 'archived'
        assert preserved.json()['assignments'] == []


@pytest.mark.asyncio
async def test_archive_after_replacement_authorization_blocks_assignment_replace(
    monkeypatch,
):
    from graphiti_core.driver.neo4j_driver import Neo4jDriver

    settings = fixture_settings()
    execute_query = Neo4jDriver.execute_query
    replacement_write_reached = asyncio.Event()
    continue_replacement_write = asyncio.Event()
    paused = False

    async def pause_assignment_replace(driver, query, **kwargs):
        nonlocal paused
        if (
            not paused
            and 'MERGE (replacement:FuliProjectAgentAssignment' in query
            and kwargs.get('reason') == 'Synthetic replacement race.'
        ):
            paused = True
            replacement_write_reached.set()
            await continue_replacement_write.wait()
        return await execute_query(driver, query, **kwargs)

    async with provider_client(
        settings, raise_app_exceptions=False,
    ) as (client, _):
        scope = await create_scope(client)
        profile = {
            'responsibility': 'Exercise replacement serialization.',
            'capabilities': ['coding'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_assignment_replace_race',
            'cleanup_eligible': True,
        }
        for agent_id in ('replace-race-original', 'replace-race-target'):
            identity = await client.put('/v1/project-agents', json={
                'personal_space_id': scope['personal_space_id'],
                'agent_id': agent_id,
                'profile': {**profile, 'name': f'Synthetic {agent_id}'},
            })
            assert identity.status_code == 200, identity.text
        original = await client.post('/v1/project-agent-assignments', json={
            **scope,
            'agent_id': 'replace-race-original',
            'idempotency_key': 'synthetic-replace-race-original',
            'responsibility': 'Own the original synthetic role.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding'],
            'reason': 'Synthetic original assignment.',
            'source_application': 'codex',
        })
        assert original.status_code == 200, original.text
        with monkeypatch.context() as concurrent:
            concurrent.setattr(
                Neo4jDriver,
                'execute_query',
                pause_assignment_replace,
            )
            replacement_request = asyncio.create_task(client.post(
                '/v1/project-agent-assignments/replace',
                json={
                    **scope,
                    'assignment_id': original.json()['assignment_id'],
                    'expected_revision': original.json()['revision'],
                    'replacement_agent_id': 'replace-race-target',
                    'idempotency_key': 'synthetic-assignment-replace-race',
                    'responsibility': 'Own the replacement synthetic role.',
                    'work_kinds': ['implementation'],
                    'capabilities': ['coding'],
                    'reason': 'Synthetic replacement race.',
                    'source_application': 'codex',
                },
            ))
            await asyncio.wait_for(replacement_write_reached.wait(), timeout=30)
            archived = await client.delete(
                '/v1/project-agents/replace-race-target',
                params={
                    'personal_space_id': scope['personal_space_id'],
                    'reason': 'Synthetic replacement target archived.',
                },
            )
            assert archived.status_code == 200, archived.text
            continue_replacement_write.set()
            replacement = await asyncio.wait_for(
                replacement_request,
                timeout=30,
            )

        assert replacement.status_code == 409, replacement.text
        assignments = await client.get('/v1/project-agent-assignments', params={
            **scope, 'status': 'active',
        })
        assert assignments.status_code == 200, assignments.text
        assert [item['agent_id'] for item in assignments.json()] == [
            'replace-race-original'
        ]
        target = await client.get(
            '/v1/project-agents/replace-race-target',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert target.status_code == 200, target.text
        assert target.json()['profile']['status'] == 'archived'
        assert target.json()['assignments'] == []


@pytest.mark.asyncio
async def test_test_cleanup_skips_agents_with_nonterminal_work():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(
            client,
            scope,
            'cleanup-boundary-role',
            ['coding', 'review'],
        )
        task = await submit_task(
            client,
            scope,
            lead_agent_id='cleanup-boundary-role',
            idempotency_key='synthetic-cleanup-boundary-task',
        )

        blocked_cleanup = await client.post(
            '/v1/project-agents/test-cleanup',
            params={
                'personal_space_id': scope['personal_space_id'],
                'test_source': 'synthetic_staffing_acceptance',
            },
        )
        assert blocked_cleanup.status_code == 200, blocked_cleanup.text
        assert blocked_cleanup.json()['archived_count'] == 0

        still_active = await client.get(
            '/v1/project-agents/cleanup-boundary-role', params=scope,
        )
        assert still_active.status_code == 200, still_active.text
        assert still_active.json()['profile']['status'] == 'active'
        assert still_active.json()['assignments'][0]['status'] == 'active'

        cancelled = await client.post(
            f'/v1/project-agent-tasks/{task["task_id"]}/events',
            json={
                **scope,
                'task_id': task['task_id'],
                'agent_id': 'cleanup-boundary-role',
                'expected_revision': task['revision'],
                'status': 'cancelled',
                'idempotency_key': 'synthetic-cleanup-boundary-cancel',
                'source_application': 'codex',
                'summary': 'Synthetic cancellation before test cleanup.',
            },
        )
        assert cancelled.status_code == 200, cancelled.text

        allowed_cleanup = await client.post(
            '/v1/project-agents/test-cleanup',
            params={
                'personal_space_id': scope['personal_space_id'],
                'test_source': 'synthetic_staffing_acceptance',
            },
        )
        assert allowed_cleanup.status_code == 200, allowed_cleanup.text
        assert allowed_cleanup.json()['archived_count'] == 1

        archived = await client.get(
            '/v1/project-agents/cleanup-boundary-role',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert archived.status_code == 200, archived.text
        assert archived.json()['profile']['status'] == 'archived'
        assert archived.json()['work_status'] == 'ended'
        assert archived.json()['assignments'][0]['status'] == 'ended'
        assert archived.json()['assignments'][0]['end_reason'] == (
            'test Agent archived'
        )

        replayed_cleanup = await client.post(
            '/v1/project-agents/test-cleanup',
            params={
                'personal_space_id': scope['personal_space_id'],
                'test_source': 'synthetic_staffing_acceptance',
            },
        )
        assert replayed_cleanup.status_code == 200, replayed_cleanup.text
        assert replayed_cleanup.json()['archived_count'] == 0

        replayed_agent = await client.get(
            '/v1/project-agents/cleanup-boundary-role',
            params={'personal_space_id': scope['personal_space_id']},
        )
        assert replayed_agent.status_code == 200, replayed_agent.text
        assert replayed_agent.json()['assignments'] == archived.json()['assignments']


@pytest.mark.asyncio
async def test_inactive_identity_is_reversible_but_never_routable():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        profile = {
            'name': 'Synthetic inactive role',
            'responsibility': 'Retain responsibility while unavailable.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'status': 'inactive',
            'test_source': 'synthetic_inactive_boundary_acceptance',
            'cleanup_eligible': True,
        }
        inactive = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'inactive-boundary-role', 'profile': profile,
        })
        assert inactive.status_code == 200, inactive.text
        assert inactive.json()['profile']['status'] == 'inactive'
        assert inactive.json()['assignments'][0]['status'] == 'active'

        unavailable = await resolve_role(client, scope)
        assert unavailable['status'] == 'unassigned'
        assert unavailable['agent'] is None

        reactivated = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'inactive-boundary-role',
            'profile': {**profile, 'status': 'active'},
        })
        assert reactivated.status_code == 200, reactivated.text
        assert reactivated.json()['profile']['status'] == 'active'
        assert reactivated.json()['assignments'][0]['status'] == 'active'

        available = await resolve_role(client, scope)
        assert available['status'] == 'ready'
        assert available['agent']['agent_id'] == 'inactive-boundary-role'


@pytest.mark.asyncio
async def test_legacy_upsert_preserves_an_active_cross_agent_replacement():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        original_profile = {
            'name': 'Synthetic original role',
            'responsibility': 'Hand off this synthetic role.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_replacement_acceptance',
            'cleanup_eligible': True,
        }
        original = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'original-legacy-role',
            'profile': original_profile,
        })
        assert original.status_code == 200, original.text
        original_assignment = original.json()['assignments'][0]

        replacement = await client.put('/v1/project-agents', json={
            'personal_space_id': scope['personal_space_id'],
            'agent_id': 'replacement-role',
            'profile': {
                **original_profile,
                'name': 'Synthetic replacement role',
            },
        })
        assert replacement.status_code == 200, replacement.text
        replace_payload = {
            **scope,
            'assignment_id': original_assignment['assignment_id'],
            'expected_revision': original_assignment['revision'],
            'replacement_agent_id': 'replacement-role',
            'idempotency_key': 'synthetic-cross-agent-replacement',
            'responsibility': 'Own the handed-off synthetic role.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic cross-Agent handoff.',
            'source_application': 'codex',
        }
        replaced = await client.post(
            '/v1/project-agent-assignments/replace', json=replace_payload,
        )
        assert replaced.status_code == 200, replaced.text
        transition = replaced.json()

        refreshed = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'original-legacy-role',
            'profile': original_profile,
        })
        assert refreshed.status_code == 200, refreshed.text
        ended_assignments = refreshed.json()['assignments']
        assert len(ended_assignments) == 1
        assert ended_assignments[0]['status'] == 'ended'
        assert ended_assignments[0]['revision'] == transition['ended']['revision']
        assert (
            ended_assignments[0]['replaced_by_assignment_id']
            == transition['replacement']['assignment_id']
        )

        selected = await resolve_role(client, scope)
        assert selected['status'] == 'ready'
        assert selected['agent']['agent_id'] == 'replacement-role'

        replayed = await client.post(
            '/v1/project-agent-assignments/replace', json=replace_payload,
        )
        assert replayed.status_code == 200, replayed.text
        assert (
            replayed.json()['replacement']['assignment_id']
            == transition['replacement']['assignment_id']
        )

        archived_replacement = await client.delete(
            '/v1/project-agents/replacement-role',
            params={
                'personal_space_id': scope['personal_space_id'],
                'reason': 'Synthetic post-handoff archive.',
            },
        )
        assert archived_replacement.status_code == 200, archived_replacement.text
        archived_assignment = archived_replacement.json()['assignments'][0]
        assert archived_assignment['status'] == 'ended'

        replayed_after_archive = await client.post(
            '/v1/project-agent-assignments/replace', json=replace_payload,
        )
        assert replayed_after_archive.status_code == 200, replayed_after_archive.text
        assert replayed_after_archive.json()['ended'] == transition['ended']
        assert (
            replayed_after_archive.json()['replacement']
            == archived_assignment
        )


@pytest.mark.asyncio
async def test_legacy_upsert_preserves_an_explicit_cross_agent_replacement():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        profile = {
            'name': 'Synthetic explicit original role',
            'responsibility': 'Hand off an explicit assignment.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_explicit_replacement_acceptance',
            'cleanup_eligible': True,
        }
        for agent_id, name in (
            ('explicit-original-role', 'Synthetic explicit original role'),
            ('explicit-replacement-role', 'Synthetic explicit replacement role'),
        ):
            identity = await client.put('/v1/project-agents', json={
                'personal_space_id': scope['personal_space_id'],
                'agent_id': agent_id,
                'profile': {**profile, 'name': name},
            })
            assert identity.status_code == 200, identity.text

        original = await client.post('/v1/project-agent-assignments', json={
            **scope,
            'agent_id': 'explicit-original-role',
            'idempotency_key': 'synthetic-explicit-original-assignment',
            'responsibility': 'Own the explicit synthetic role.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic explicit assignment.',
            'source_application': 'codex',
        })
        assert original.status_code == 200, original.text
        replace_payload = {
            **scope,
            'assignment_id': original.json()['assignment_id'],
            'expected_revision': original.json()['revision'],
            'replacement_agent_id': 'explicit-replacement-role',
            'idempotency_key': 'synthetic-explicit-cross-agent-replacement',
            'responsibility': 'Own the handed-off explicit role.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic explicit cross-Agent handoff.',
            'source_application': 'codex',
        }
        replaced = await client.post(
            '/v1/project-agent-assignments/replace', json=replace_payload,
        )
        assert replaced.status_code == 200, replaced.text
        transition = replaced.json()

        refreshed = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'explicit-original-role',
            'profile': profile,
        })
        assert refreshed.status_code == 200, refreshed.text
        assignments = refreshed.json()['assignments']
        assert len(assignments) == 1
        assert assignments[0]['assignment_id'] == original.json()['assignment_id']
        assert assignments[0]['status'] == 'ended'
        assert assignments[0]['revision'] == transition['ended']['revision']
        assert (
            assignments[0]['replaced_by_assignment_id']
            == transition['replacement']['assignment_id']
        )

        selected = await resolve_role(client, scope)
        assert selected['status'] == 'ready'
        assert selected['agent']['agent_id'] == 'explicit-replacement-role'

        replayed = await client.post(
            '/v1/project-agent-assignments/replace', json=replace_payload,
        )
        assert replayed.status_code == 200, replayed.text
        assert (
            replayed.json()['replacement']['assignment_id']
            == transition['replacement']['assignment_id']
        )


@pytest.mark.asyncio
async def test_legacy_upsert_preserves_a_transitive_handoff_chain():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        profile = {
            'name': 'Synthetic chain role',
            'responsibility': 'Preserve transitive handoff history.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_handoff_chain_acceptance',
            'cleanup_eligible': True,
        }
        for agent_id in ('chain-original', 'chain-middle', 'chain-current'):
            identity = await client.put('/v1/project-agents', json={
                'personal_space_id': scope['personal_space_id'],
                'agent_id': agent_id,
                'profile': {**profile, 'name': f'Synthetic {agent_id}'},
            })
            assert identity.status_code == 200, identity.text

        original = await client.post('/v1/project-agent-assignments', json={
            **scope,
            'agent_id': 'chain-original',
            'idempotency_key': 'synthetic-chain-original-assignment',
            'responsibility': 'Own the first chain step.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic chain origin.',
            'source_application': 'codex',
        })
        assert original.status_code == 200, original.text
        first_payload = {
            **scope,
            'assignment_id': original.json()['assignment_id'],
            'expected_revision': original.json()['revision'],
            'replacement_agent_id': 'chain-middle',
            'idempotency_key': 'synthetic-chain-first-handoff',
            'responsibility': 'Own the middle chain step.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic first chain handoff.',
            'source_application': 'codex',
        }
        first = await client.post(
            '/v1/project-agent-assignments/replace', json=first_payload,
        )
        assert first.status_code == 200, first.text
        middle = first.json()['replacement']
        second_payload = {
            **scope,
            'assignment_id': middle['assignment_id'],
            'expected_revision': middle['revision'],
            'replacement_agent_id': 'chain-current',
            'idempotency_key': 'synthetic-chain-second-handoff',
            'responsibility': 'Own the current chain step.',
            'work_kinds': ['implementation'],
            'capabilities': ['coding', 'review'],
            'reason': 'Synthetic second chain handoff.',
            'source_application': 'codex',
        }
        second = await client.post(
            '/v1/project-agent-assignments/replace', json=second_payload,
        )
        assert second.status_code == 200, second.text

        refreshed = await client.put('/v1/project-agents', json={
            **scope, 'agent_id': 'chain-original', 'profile': profile,
        })
        assert refreshed.status_code == 200, refreshed.text
        assignments = refreshed.json()['assignments']
        assert len(assignments) == 1
        assert assignments[0]['assignment_id'] == original.json()['assignment_id']
        assert assignments[0]['status'] == 'ended'
        assert (
            assignments[0]['replaced_by_assignment_id']
            == middle['assignment_id']
        )

        selected = await resolve_role(client, scope)
        assert selected['agent']['agent_id'] == 'chain-current'
        for payload, transition in (
            (first_payload, first.json()),
            (second_payload, second.json()),
        ):
            replayed = await client.post(
                '/v1/project-agent-assignments/replace', json=payload,
            )
            assert replayed.status_code == 200, replayed.text
            assert (
                replayed.json()['replacement']['assignment_id']
                == transition['replacement']['assignment_id']
            )


@pytest.mark.asyncio
async def test_active_legacy_refresh_ignores_an_unrelated_handoff_history():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        initial_profile = {
            'name': 'Synthetic refresh role',
            'responsibility': 'Initial active legacy responsibility.',
            'capabilities': ['coding', 'review'],
            'work_kinds': ['implementation'],
            'allowed_clients': ['codex'],
            'test_source': 'synthetic_active_refresh_acceptance',
            'cleanup_eligible': True,
        }
        original = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'active-legacy-with-history',
            'profile': initial_profile,
        })
        assert original.status_code == 200, original.text
        legacy_id = original.json()['assignments'][0]['assignment_id']

        explicit = await client.post('/v1/project-agent-assignments', json={
            **scope,
            'agent_id': 'active-legacy-with-history',
            'idempotency_key': 'synthetic-refresh-explicit-assignment',
            'responsibility': 'Separate explicit role to hand off.',
            'work_kinds': ['review'],
            'capabilities': ['review'],
            'reason': 'Synthetic separate role.',
            'source_application': 'codex',
        })
        assert explicit.status_code == 200, explicit.text
        replacement = await client.put('/v1/project-agents', json={
            'personal_space_id': scope['personal_space_id'],
            'agent_id': 'refresh-history-replacement',
            'profile': {
                **initial_profile,
                'name': 'Synthetic refresh history replacement',
            },
        })
        assert replacement.status_code == 200, replacement.text
        handed_off = await client.post(
            '/v1/project-agent-assignments/replace', json={
                **scope,
                'assignment_id': explicit.json()['assignment_id'],
                'expected_revision': explicit.json()['revision'],
                'replacement_agent_id': 'refresh-history-replacement',
                'idempotency_key': 'synthetic-refresh-history-handoff',
                'responsibility': 'Own the separate handed-off role.',
                'work_kinds': ['review'],
                'capabilities': ['review'],
                'reason': 'Synthetic separate-role handoff.',
                'source_application': 'codex',
            },
        )
        assert handed_off.status_code == 200, handed_off.text

        updated_profile = {
            **initial_profile,
            'responsibility': 'Updated active legacy responsibility.',
            'capabilities': ['coding', 'review', 'refresh'],
        }
        refreshed = await client.put('/v1/project-agents', json={
            **scope,
            'agent_id': 'active-legacy-with-history',
            'profile': updated_profile,
        })
        assert refreshed.status_code == 200, refreshed.text
        active = [
            item for item in refreshed.json()['assignments']
            if item['assignment_id'] == legacy_id
        ][0]
        assert active['status'] == 'active'
        assert active['responsibility'] == updated_profile['responsibility']
        assert active['capabilities'] == updated_profile['capabilities']


@pytest.mark.asyncio
async def test_empty_assignment_retains_documented_profile_fallback():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'profile-fallback', [],
                          profile_capabilities=['coding', 'review'])
        selected = await resolve_role(client, scope)
        assert selected['agent']['agent_id'] == 'profile-fallback'
        assert selected['agent']['assignments'][0]['capabilities'] == []


@pytest.mark.asyncio
async def test_live_load_precedes_history_and_history_breaks_equal_load_ties():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'first-assigned', ['coding', 'review'])
        await assign_role(client, scope, 'previous-owner', ['coding', 'review'])
        assert (await resolve_role(client, scope))['agent']['agent_id'] == 'first-assigned'
        await record_history(client, scope, 'previous-owner')
        with_history = await resolve_role(client, scope)
        assert with_history['agent']['agent_id'] == 'previous-owner'
        assert with_history['reason'] == 'project_continuity'
        assert 'exact work kind: implementation' in with_history['match_basis']
        assert any('selected active task count: 0' in item for item in with_history['match_basis'])
        await begin_session(client, scope, 'previous-owner')
        assert (await resolve_role(client, scope))['agent']['agent_id'] == 'first-assigned'
        await begin_session(client, scope, 'first-assigned')
        tied = await resolve_role(client, scope)
        assert tied['agent']['agent_id'] == 'previous-owner'
        assert tied['reason'] == 'project_continuity'


@pytest.mark.asyncio
async def test_work_kind_fit_precedes_lower_load_and_other_work_history():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'generalist', ['coding', 'review'],
                          work_kind='maintenance')
        await assign_role(client, scope, 'specialist', ['coding', 'review'])
        await record_history(client, scope, 'generalist', work_kind='maintenance')
        await begin_session(client, scope, 'specialist')
        selected = await resolve_role(client, scope)
        assert selected['agent']['agent_id'] == 'specialist'
        assert selected['reason'] == 'exact_work_kind'
        assert any('selected active task count: 1' in item for item in selected['match_basis'])


@pytest.mark.asyncio
async def test_nonsemantic_defaults_report_their_actual_candidate_count_and_work_kind_gap():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'first-role', ['coding'])
        single = await resolve_role(client, scope, required_capabilities=[], work_kind='unmatched-kind')
        assert single['reason'] == 'sole_active_assignment'
        assert any('no exact work-kind match: unmatched-kind' in item for item in single['match_basis'])
        assert any('continuity only' in item for item in single['match_basis'])
        await assign_role(client, scope, 'second-role', ['coding'])
        multiple = await resolve_role(client, scope, required_capabilities=[], work_kind='project_context')
        assert multiple['reason'] == 'project_default'
        assert any('2 eligible project roles' in item for item in multiple['match_basis'])
        assert any('continuity only' in item for item in multiple['match_basis'])
        assert not any('one available project role' in item for item in multiple['match_basis'])


@pytest.mark.asyncio
async def test_explicit_role_and_active_owner_do_not_silently_switch_identity():
    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await assign_role(client, scope, 'existing-owner', ['coding'])
        await assign_role(client, scope, 'qualified-reviewer', ['coding', 'review'])
        automatic = await resolve_role(client, scope)
        assert automatic['agent']['agent_id'] == 'qualified-reviewer'
        await begin_session(client, scope, 'existing-owner')
        resumed = await resolve_role(client, scope, session_id='synthetic-session-existing-owner',
                                     turn_id='synthetic-turn-one')
        assert resumed['agent']['agent_id'] == 'existing-owner'
        assert resumed['reason'] == 'active_task_owner'
        explicit = await resolve_role(client, scope, agent_id='existing-owner')
        assert explicit['agent']['agent_id'] == 'existing-owner'
        assert explicit['reason'] == 'explicit_agent'
        reassigned = await resolve_role(client, scope,
            session_id='synthetic-session-existing-owner', agent_id='qualified-reviewer')
        assert reassigned['agent']['agent_id'] == 'qualified-reviewer'
        assert reassigned['reason'] == 'explicit_agent'
        # Another client does not inherit the first client's active task owner.
        other = await resolve_role(client, scope, source_application='cursor',
                                   session_id='synthetic-session-existing-owner')
        assert other['agent']['agent_id'] == 'qualified-reviewer'


@pytest.mark.asyncio
async def test_successful_history_precedes_a_more_recent_failed_lead():
    from test_project_agent_activity_atomicity_neo4j import seed_executor

    async with provider_client(fixture_settings()) as (client, _):
        scope = await create_scope(client)
        await seed_executor(client, scope['personal_space_id'])
        for agent, outcome in [('successful-owner', 'completed'), ('recent-failure', 'failed')]:
            await assign_role(client, scope, agent, ['coding', 'review'])
            task = await submit_task(client, scope, lead_agent_id=agent,
                                     idempotency_key=f'synthetic-outcome-{agent}')
            for status in ['running', outcome]:
                activity = await client.post(
                    f'/v1/project-agent-tasks/{task["task_id"]}/events', json={
                        **scope, 'task_id': task['task_id'], 'agent_id': agent,
                        'expected_revision': task['revision'], 'status': status,
                        'idempotency_key': f'synthetic-{agent}-{status}',
                        'source_application': 'codex',
                        'summary': 'Synthetic reported outcome, not real model execution.',
                        'actual_executor_id': 'synthetic-executor',
                        'actual_model_provider': 'synthetic', 'actual_model': 'synthetic-model',
                    })
                assert activity.status_code == 200, activity.text
                task = activity.json()
            assert task['status'] == outcome
        selected = await resolve_role(client, scope)
        assert selected['agent']['agent_id'] == 'successful-owner'
        assert selected['reason'] == 'project_continuity'
        assert selected['match_basis'] == [
            'last successful project lead continuity: 1 prior task(s), 1 completed',
            'exact work kind: implementation',
            'selected active task count: 0; work-kind fit and load precede history']
