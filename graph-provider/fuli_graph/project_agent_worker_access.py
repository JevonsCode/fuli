"""Current project/participant/executor authority for worker admission.

All writes lock session IDs (including a new seal target), then contexts, task,
sorted Agent IDs, assignments, executor/permission, policy, and finally run.
The existing TaskContext checkpoint joins that same transaction and lock order.
No run lock is taken before a session lock, and no permission is granted here.
"""

import json
from hmac import compare_digest

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_delegations import token_hash
from .project_agent_hierarchy import validate_worker_reporting
from .project_agent_executor_models import project_agent_model_strategy_key
from .project_agent_models import ProjectAgentExecutorPolicy, ProjectAgentModelStrategy, ProjectAgentProfile
from .provider_values import native_datetime, now_utc


async def worker_scope(store, actor, scope):
    store._require_personal()
    space = await store.authorize(actor, scope.personal_space_id, 'maintainer')
    await authorize_personal_project(store, actor, space, scope.personal_project_id)


def strict_worker_policy(value, model, *, optional=False):
    """Unlike routing's tolerant readers, admission must fail closed on corruption."""
    if value is None:
        return None if optional else model()
    try:
        return model.model_validate_json(value) if isinstance(value, str) else model.model_validate(value)
    except (TypeError, ValueError) as error:
        raise HTTPException(409, 'Stored worker authority policy or strategy is invalid') from error


def authority_value(raw, *keys):
    return next((raw[key] for key in keys if raw.get(key) is not None), None)


def require_capability(run, capability):
    value = capability.get_secret_value() if capability is not None else ''
    if not (32 <= len(value) <= 128) or not compare_digest(
            token_hash(value), run.get('runtime_capability_hash', '')):
        raise HTTPException(403, 'Worker runtime capability is invalid')


async def load_worker_run(store, scope, run_id):
    rows, _, _ = await store.runtime.driver.execute_query('''
        MATCH (parent:FuliTaskContext)-[:AUTHORIZES_WORKER_RUN]->
          (run:FuliProjectAgentWorkerRun {id: $run_id, personal_space_id: $space_id,
                                        personal_project_id: $project_id})
        MATCH (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(parent)
        RETURN run, parent, session
        ''', run_id=run_id, space_id=scope.personal_space_id, project_id=scope.personal_project_id)
    if not rows:
        raise HTTPException(404, 'Worker run not found in this project')
    return {key: dict(rows[0][key]) for key in ('run', 'parent', 'session')}


async def lock_worker_scope(store, scope, data, *, proposed_session=None):
    run, parent = data['run'], data['parent']
    params = {'space_id': scope.personal_space_id, 'project_id': scope.personal_project_id,
              'parent_id': parent['id'], 'task_id': run['task_id'], 'agent_id': run['agent_id'],
              'executor_id': run['executor_id'], 'run_id': run.get('id')}
    sessions = {data['session']['id']}
    actual_session = proposed_session or run.get('actual_session_id')
    if actual_session:
        sessions.add(store._task_session_id(scope.personal_space_id, run['target_application'], actual_session))
    params['session_ids'] = sorted(sessions)
    for session_id in params['session_ids']:
        await store._lock_task_context_session(session_id)
    await store._link_task_context_sessions(scope.personal_space_id, params['session_ids'])
    await store.runtime.driver.execute_query('''
        MATCH (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(context:FuliTaskContext)
        WHERE session.id IN $session_ids AND (context.id = $parent_id OR EXISTS {
          MATCH (context)-[:FOR_WORKER_RUN]->(:FuliProjectAgentWorkerRun {id: $run_id}) })
        WITH context ORDER BY context.id
        SET context.write_serial = coalesce(context.write_serial, 0) + 1
        RETURN count(context) AS locked
        ''', **params)
    await store.runtime.driver.execute_query('''
        MATCH (task:FuliProjectAgentTask {task_id: $task_id, personal_space_id: $space_id,
                                        personal_project_id: $project_id})
        SET task._worker_write_lock = true REMOVE task._worker_write_lock
        RETURN count(task) AS locked
        ''', **params)
    await store.runtime.driver.execute_query('''
        MATCH (parent:FuliTaskContext {id: $parent_id})
        MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
        WHERE agent.agent_id IN [parent.project_agent_id, $agent_id]
        WITH agent ORDER BY agent.agent_id
        SET agent._worker_write_lock = true REMOVE agent._worker_write_lock
        RETURN count(agent) AS locked
        ''', **params)
    await store.runtime.driver.execute_query('''
        MATCH (parent:FuliTaskContext {id: $parent_id})
        MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
          (:FuliPersonalProject {project_id: $project_id})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
          (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(agent:FuliProjectAgent)
        WHERE agent.agent_id IN [parent.project_agent_id, $agent_id]
        WITH assignment ORDER BY assignment.assignment_id
        SET assignment._worker_write_lock = true REMOVE assignment._worker_write_lock
        RETURN count(assignment) AS locked
        ''', **params)
    await store.runtime.driver.execute_query('''
        MATCH (:FuliSpace {id: $space_id})-[permission:HAS_EXECUTOR_PERMISSION]->
          (executor:FuliProjectAgentExecutor {executor_id: $executor_id})
        SET executor._worker_write_lock = true REMOVE executor._worker_write_lock
        WITH permission
        SET permission._worker_write_lock = true REMOVE permission._worker_write_lock
        RETURN count(permission) AS locked
        ''', **params)
    await store.runtime.driver.execute_query('''
        MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
          (:FuliPersonalProject {project_id: $project_id})-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->
          (policy:FuliProjectAgentCoordinationPolicy)
        SET policy._fuli_write_lock = true REMOVE policy._fuli_write_lock
        RETURN count(policy) AS locked
        ''', **params)
    if run.get('id'):
        rows, _, _ = await store.runtime.driver.execute_query('''
            MATCH (run:FuliProjectAgentWorkerRun {id: $run_id})
            SET run.write_serial = coalesce(run.write_serial, 0) + 1 RETURN run
            ''', **params)
        if not rows:
            raise HTTPException(409, 'Worker run is unavailable')
        data['run'] = dict(rows[0]['run'])
    return params


async def validate_worker_authority(store, scope, data):
    run = data['run']
    if run.get('retry_of_run_id'):
        previous = await load_worker_run(store, scope, run['retry_of_run_id'])
        if previous['run']['state'] != 'closed' or (run.get('id') and previous['run'].get('retry_run_id') not in {None, run['id']}):
            raise HTTPException(409, 'Worker retry predecessor has been stopped or superseded')
    rows, _, _ = await store.runtime.driver.execute_query('''
        MATCH (space:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
          (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(parent:FuliTaskContext {id: $parent_id})
        MATCH (parent)-[:COORDINATES_TASK]->(task:FuliProjectAgentTask {
          task_id: $task_id, personal_space_id: $space_id, personal_project_id: $project_id})
        OPTIONAL MATCH (parent)-[:FOR_WORKER_RUN]->(parent_run:FuliProjectAgentWorkerRun)
        WITH space, session, parent, task, parent_run
        WHERE parent_run IS NULL OR parent_run.state = 'admitted'
        MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(owner:FuliProjectAgent)
        WHERE owner.agent_id = parent.project_agent_id
        MATCH (task)-[participant:HAS_PARTICIPANT]->(agent:FuliProjectAgent {agent_id: $agent_id})
        MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
        MATCH (space)-[:CONTAINS_PROJECT]->(project:FuliPersonalProject {project_id: $project_id})
        MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(agent)
        MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(owner_assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(owner)
        MATCH (space)-[permission:HAS_EXECUTOR_PERMISSION]->(executor:FuliProjectAgentExecutor {executor_id: $executor_id})
        OPTIONAL MATCH (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
        RETURN parent, session, task, owner, agent, participant, executor, permission, policy,
               collect(DISTINCT assignment) AS assignments,
               collect(DISTINCT owner_assignment) AS owner_assignments
        ''', space_id=scope.personal_space_id, project_id=scope.personal_project_id,
        parent_id=data['parent']['id'], task_id=run['task_id'], agent_id=run['agent_id'],
        executor_id=run['executor_id'])
    if not rows:
        raise HTTPException(409, 'Worker parent, participant or executor authority is unavailable')
    row = rows[0]
    parent, session, task, owner, agent = (dict(row[key]) for key in ('parent', 'session', 'task', 'owner', 'agent'))
    admitted = run.get('admitted_at') is not None
    if not admitted and (session.get('current_token') != parent['token']
                         or parent.get('fingerprint') or parent.get('completed')):
        raise HTTPException(409, 'Worker bootstrap requires its current unfinished parent task')
    if task.get('status') not in {'queued', 'running'}:
        raise HTTPException(409, 'Coordination task is not executable')
    owner_profile = strict_worker_policy(owner['profile_json'], ProjectAgentProfile).model_dump(mode='json')
    agent_profile = strict_worker_policy(agent['profile_json'], ProjectAgentProfile).model_dump(mode='json')
    policy = dict(row.get('policy') or {})
    validate_worker_reporting(policy, scope, run, task, owner['agent_id'], agent['agent_id'])
    if owner['agent_id'] not in {task.get('coordinator_agent_id'), task.get('lead_agent_id'), policy.get('team_lead_agent_id')}:
        raise HTTPException(403, 'Parent owner is not a current coordinator or responsible lead')
    parent_record = json.loads(parent['record_json'])
    if (owner.get('status') != 'active' or parent_record['source_application'] != run['source_application']
            or run['source_application'] not in owner_profile.get('allowed_clients', [])
            or not any(item.get('status') == 'active' for item in row['owner_assignments'])):
        raise HTTPException(403, 'Parent owner authority is unavailable')
    sub_lead = any(group.get('lead_agent_id') == agent['agent_id']
                   for group in json.loads(policy.get('sub_teams_json') or '[]'))
    assignments = [dict(item) for item in row['assignments'] if item.get('status') == 'active'
                   and (task['work_kind'] in (item.get('work_kinds') or [])
                        or sub_lead and task['work_kind'] == 'delegation')]
    if (agent.get('status') != 'active' or run['target_application'] not in agent_profile.get('allowed_clients', [])
            or not assignments or row['participant'].get('status') not in {'queued', 'running', 'paused'}):
        raise HTTPException(403, 'Worker participant assignment or client access is unavailable')
    if agent.get('memory_scope') == 'task_only' and agent.get('temporary_task_id') != run['task_id']:
        raise HTTPException(409, 'Temporary worker belongs to another coordination task')
    strategy = strict_worker_policy(run['model_strategy_json'], ProjectAgentModelStrategy)
    assignment = sorted(assignments, key=lambda item: item['assignment_id'])[0]
    agent_strategy = strict_worker_policy(authority_value(agent, 'default_model_strategy', 'default_model_strategy_json')
        if authority_value(agent, 'default_model_strategy', 'default_model_strategy_json') is not None
        else agent_profile.get('default_model_strategy'), ProjectAgentModelStrategy)
    assignment_strategy = strict_worker_policy(assignment.get('model_strategy_json'), ProjectAgentModelStrategy, optional=True)
    task_strategy = strict_worker_policy(task.get('task_model_strategy_override_json'), ProjectAgentModelStrategy, optional=True)
    expected = task_strategy or assignment_strategy or agent_strategy
    if expected.mode == 'adaptive':
        expected = expected.model_copy(update={'mode': {'simple': 'fast', 'standard': 'balanced', 'complex': 'deep'}[task['complexity']]})
    if project_agent_model_strategy_key(strategy) != project_agent_model_strategy_key(expected):
        raise HTTPException(409, 'Worker model strategy does not match current task and participant authority')
    agent_policy = strict_worker_policy(authority_value(agent, 'executor_policy', 'executor_policy_json')
        if authority_value(agent, 'executor_policy', 'executor_policy_json') is not None
        else agent_profile.get('executor_policy'), ProjectAgentExecutorPolicy)
    assignment_policy = strict_worker_policy(authority_value(assignment, 'executor_policy', 'executor_policy_json'),
                                            ProjectAgentExecutorPolicy, optional=True)
    override = strict_worker_policy(task.get('task_executor_policy_override_json'), ProjectAgentExecutorPolicy, optional=True)
    executor_policy = (agent_policy if agent_policy.mode == 'locked' else
                       override or assignment_policy or agent_policy)
    if executor_policy.mode == 'locked' and run['executor_id'] not in executor_policy.locked_executor_ids:
        raise HTTPException(409, 'Worker executor is outside this participant allow-list')
    executor = store._executor_from_row(row, scope.personal_space_id)
    reason = store._executor_unavailable_reason(executor, task.get('executor_capability_hints') or [], strategy)
    chosen = [item for item in executor.available_models if item.provider == run['provider'] and item.model == run['model']]
    if reason or not store._select_model(chosen, strategy):
        raise HTTPException(409, 'Worker target executor or exact model is unavailable for this strategy')
    data.update(parent=parent, session=session, task=task, agent=agent)


def require_open_worker_run(run, *, bootstrap=True):
    if run['state'] in {'closed', 'revoked'}:
        raise HTTPException(409, 'Worker run is closed or revoked')
    if bootstrap and not run.get('admitted_at'):
        expires = native_datetime(run['bootstrap_expires_at'])
        if expires <= now_utc():
            raise HTTPException(409, 'Worker bootstrap expired; revoke this run and prepare a new attempt')
