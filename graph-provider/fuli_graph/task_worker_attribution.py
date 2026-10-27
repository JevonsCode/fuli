"""Freeze existing, exact-parent worker evidence in the task checkpoint.

Two kinds of evidence name a collaborator: a WorkerRun this context authorized
(a launched worker session), or a worker this context's own session ran itself
and reported on a task the context coordinates. Evidence of the second kind has
no run ID.
"""

import json

from .project_agent_names import agent_display_name


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
        'owner': _owner(owner_id, _profile(owners[0]['profile_json']) if owners else None),
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
    # A launched worker is proven by its WorkerRun; a worker this session ran
    # itself (a host subagent) by its own terminal event on a coordinated task.
    runs = await _host_worker_evidence(store, space_id, record, owner_id)
    for row in rows:
        run, event = dict(row['run']), dict(row['event'])
        runtime = _runtime(event)
        if (runtime is None or runtime.get('application') != run['target_application']
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
            'name': _name(agent_id, profile),
            'responsibility': profile.get('responsibility'), 'runs': []})
        helper['runs'].append(evidence)
    snapshot['collaborators'] = [helpers[agent_id] for agent_id in sorted(helpers)]
    return snapshot


async def _host_worker_evidence(store, space_id, record, owner_id):
    """Latest terminal events of workers this context's own session ran itself.

    Only a task this context coordinates, only a participating Agent other than
    the owner, only events reported from this context's client session, and
    never a worker ID that belongs to a WorkerRun: a launched worker is proven
    by its run alone, so a second parent cannot borrow its evidence.
    """
    sessions = sorted({value for value in (record.get('session_id'), record.get('source_session_id')) if value})
    if not sessions or not record.get('source_application'):
        return {}
    rows, _, _ = await store.runtime.driver.execute_query('''
        MATCH (parent:FuliTaskContext {token: $token, personal_space_id: $space_id})-[:COORDINATES_TASK]->
          (task:FuliProjectAgentTask {personal_space_id: $space_id, personal_project_id: $project_id})
        MATCH (task)-[:HAS_TASK_EVENT]->(event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent:FuliProjectAgent)
        WHERE agent.agent_id <> $owner_id AND event.worker_id IS NOT NULL
          AND event.worker_status IN $terminal
          AND event.source_application = $application AND event.source_session_id IN $sessions
          AND EXISTS { MATCH (task)-[:HAS_PARTICIPANT]->(agent) }
          AND NOT EXISTS { MATCH (task)-[:HAS_WORKER_RUN]->(run:FuliProjectAgentWorkerRun)
                           WHERE run.worker_id = event.worker_id }
        WITH task, agent, event ORDER BY event.created_at DESC, event.event_id DESC
        WITH task, agent, event.worker_id AS worker_id, collect(event)[0] AS event
        RETURN task.task_id AS task_id, task.work_kind AS work_kind, agent.agent_id AS agent_id,
          agent.profile_json AS profile_json, event
        ORDER BY task_id, worker_id
        ''', token=record['token'], space_id=space_id, project_id=record['personal_project_id'],
        owner_id=owner_id, terminal=sorted(TERMINAL_WORKER_STATUSES),
        application=record['source_application'], sessions=sessions)
    evidence = {}
    for row in rows:
        event = dict(row['event'])
        runtime = _runtime(event) or {}
        evidence[f"host:{row['task_id']}:{event['worker_id']}"] = (
            row['agent_id'], _profile(row['profile_json']), {
                'run_id': None, 'worker_id': event['worker_id'],
                'task_id': row['task_id'], 'work_kind': row['work_kind'],
                'worker_label': event.get('worker_label'),
                'application': runtime.get('application') or event.get('source_application'),
                'session_id': runtime.get('session_id'), 'session_url': runtime.get('session_url'),
                'status': event['worker_status'], 'event_id': event['event_id'],
                'observation_ids': [],
            })
    return evidence


def _runtime(event):
    try:
        runtime = json.loads(event.get('worker_runtime_json') or 'null')
    except (TypeError, ValueError):
        return None
    return runtime if isinstance(runtime, dict) else None


# The owner's person name and its role title, shown as "name [role]".
def _owner(agent_id, profile):
    if profile is None:
        return {'agent_id': agent_id, 'name': None}
    return {'agent_id': agent_id, 'name': _name(agent_id, profile), 'role': profile.get('name') or None}


# The same name the Agent APIs show: a role-like profile name gets its nickname.
def _name(agent_id, profile):
    return agent_display_name(agent_id, profile.get('name') or '', profile.get('display_name')) or None


def _profile(profile_json):
    try:
        profile = json.loads(profile_json or '{}')
        if not isinstance(profile, dict):
            return {}
        return profile
    except (TypeError, ValueError):
        return {}
