"""Freeze existing, exact-parent worker evidence in the task checkpoint."""

import json


TERMINAL_WORKER_STATUSES = {'completed', 'failed', 'cancelled', 'blocked', 'awaiting_review'}


async def lock_checkpoint_context(store, space_id, token):
    # Reuse the session mutex before any read-dependent counter increment.
    # The caller re-reads the current context after this transaction owns it.
    rows, _, _ = await store.runtime.driver.execute_query('''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
          (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(context:FuliTaskContext {token: $token})
        WHERE session.current_token = context.token
        RETURN session.id AS session_id
        ''', space_id=space_id, token=token)
    if rows:
        await store._lock_task_context_session(rows[0]['session_id'])


async def checkpoint_collaboration(store, space_id, record):
    previous = record.get('checkpoint')
    if previous is not None:
        # Historical checkpoints without evidence cannot acquire late workers.
        return previous.get('collaboration', {'version': 1, 'status': 'legacy_unknown',
            'owner': {'agent_id': record.get('project_agent_id'), 'name': None}, 'collaborators': []})
    owner_id = record.get('project_agent_id')
    owners, _, _ = await store.runtime.driver.execute_query('''
        MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
          (owner:FuliProjectAgent {agent_id: $owner_id}) RETURN owner.profile_json AS profile_json
        ''', space_id=space_id, owner_id=owner_id)
    snapshot = {'version': 1, 'status': 'frozen',
        'owner': {'agent_id': owner_id, 'name': _name(owners[0]['profile_json']) if owners else None},
        'collaborators': []}
    if not record.get('personal_project_id') or not owner_id:
        return snapshot
    rows, _, _ = await store.runtime.driver.execute_query('''
        MATCH (parent:FuliTaskContext {token: $token, personal_space_id: $space_id})-
          [:AUTHORIZES_WORKER_RUN]->(run:FuliProjectAgentWorkerRun)
        MATCH (task:FuliProjectAgentTask {personal_space_id: $space_id,
          personal_project_id: $project_id})-[:HAS_WORKER_RUN]->(run)
        MATCH (run)-[:WORKER_AGENT]->(agent:FuliProjectAgent)
        WHERE run.parent_context_id = parent.id AND run.personal_space_id = $space_id
          AND run.personal_project_id = $project_id AND run.task_id = task.task_id
          AND run.agent_id = agent.agent_id AND run.agent_id <> $owner_id
          AND run.state IN ['closed', 'revoked'] AND run.sealed_at IS NOT NULL
          AND run.admitted_at IS NOT NULL AND run.actual_session_id IS NOT NULL
        MATCH (task)-[:HAS_TASK_EVENT]->(event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)
        WHERE event.worker_id = run.worker_id
        OPTIONAL MATCH (task)-[:HAS_EXECUTOR_OBSERVATION]->(observation:FuliProjectAgentExecutorObservation)
        WHERE observation.agent_id = run.agent_id AND observation.run_id IN [run.id, event.event_id]
        RETURN run, agent.profile_json AS profile_json, event,
          task.work_kind AS work_kind,
          collect(DISTINCT observation.observation_id) AS observation_ids
        ORDER BY run.id, event.created_at, event.event_id
        ''', token=record['token'], space_id=space_id,
        project_id=record['personal_project_id'], owner_id=owner_id)
    runs = {}
    for row in rows:
        run, event = dict(row['run']), dict(row['event'])
        try:
            runtime = json.loads(event.get('worker_runtime_json') or 'null')
        except (TypeError, ValueError):
            continue
        if (not isinstance(runtime, dict) or runtime.get('application') != run['target_application']
                or runtime.get('session_id') != run['actual_session_id']
                or event.get('worker_status') not in TERMINAL_WORKER_STATUSES):
            continue
        runs[run['id']] = (run['agent_id'], _profile(row['profile_json']), {
            'run_id': run['id'], 'worker_id': run['worker_id'],
            'task_id': run['task_id'], 'work_kind': row['work_kind'],
            'worker_label': event.get('worker_label'),
            'application': run['target_application'], 'session_id': run['actual_session_id'],
            'session_url': runtime.get('session_url'),
            'status': event['worker_status'], 'event_id': event['event_id'],
            'observation_ids': sorted(row['observation_ids']),
        })
    helpers = {}
    for run_id in sorted(runs):
        agent_id, profile, evidence = runs[run_id]
        helper = helpers.setdefault(agent_id, {'agent_id': agent_id,
            'name': profile.get('display_name') or profile.get('name'),
            'responsibility': profile.get('responsibility'), 'runs': []})
        helper['runs'].append(evidence)
    snapshot['collaborators'] = [helpers[agent_id] for agent_id in sorted(helpers)]
    return snapshot


def _name(profile_json):
    profile = _profile(profile_json)
    return profile.get('display_name') or profile.get('name')


def _profile(profile_json):
    try:
        profile = json.loads(profile_json or '{}')
        if not isinstance(profile, dict):
            return {}
        return profile
    except (TypeError, ValueError):
        return {}
