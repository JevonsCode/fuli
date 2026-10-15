"""Durable admission identity, not a scheduler or evidence of worker execution."""

import json
from datetime import timedelta
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

from .project_agent_worker_access import (
    load_worker_run, lock_worker_scope, require_capability, require_open_worker_run,
    validate_worker_authority, worker_scope,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_transactions import query_store_transaction
from .task_context_models import TaskContextBegin


def worker_run_view(run, own_context_token=None):
    view = {'run_id': run['id'], 'state': run['state'],
        **{key: run.get(key) for key in ('personal_space_id', 'personal_project_id',
            'parent_context_id', 'task_id', 'agent_id', 'worker_id', 'executor_id', 'target_application',
            'actual_session_id', 'created_at', 'bootstrap_expires_at', 'claimed_at',
            'sealed_at', 'admitted_at', 'closed_at', 'revoked_at')},
        'requested_model_provider': run['provider'], 'requested_model': run['model'],
        'requested_model_strategy': json.loads(run['model_strategy_json']),
        'own_context_token': own_context_token}
    for key in ('created_at', 'bootstrap_expires_at', 'claimed_at', 'sealed_at', 'admitted_at', 'closed_at', 'revoked_at'):
        view[key] = native_datetime(run[key]).isoformat() if run.get(key) is not None else None
    return view


async def checked_worker_run(store, actor, scope, run_id, capability, *, proposed_session=None):
    await worker_scope(store, actor, scope)
    data = await load_worker_run(store, scope, run_id)
    require_capability(data['run'], capability)
    await lock_worker_scope(store, scope, data, proposed_session=proposed_session)
    require_open_worker_run(data['run'])
    await validate_worker_authority(store, scope, data)
    return data


class StoreProjectAgentWorkerRuns:
    async def prepare_project_agent_worker_run(self, actor, request):
        await worker_scope(self, actor, request)
        run_id = stable_uuid(self.settings.provider_id, request.personal_space_id,
                             request.personal_project_id, 'worker-run', request.idempotency_key)
        payload_hash = sha256(json.dumps(request.model_dump(mode='json'),
            sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        # A lost prepare response must not mint new launch authority, including
        # after the parent has advanced or this attempt has ended.
        existing, _, _ = await self.runtime.driver.execute_query('''
            MATCH (run:FuliProjectAgentWorkerRun {id: $run_id}) RETURN run
            ''', run_id=run_id)
        if existing:
            run = dict(existing[0]['run'])
            if run['payload_hash'] != payload_hash:
                raise HTTPException(409, 'Worker run idempotency key has different input')
            return worker_run_view(run)
        async with query_store_transaction(self) as scoped:
            rows, _, _ = await scoped.runtime.driver.execute_query('''
                MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->
                  (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(parent:FuliTaskContext {token: $token})
                WHERE parent.personal_project_id = $project_id
                RETURN parent, session
                ''', space_id=request.personal_space_id, project_id=request.personal_project_id,
                token=request.task_context_token)
            if not rows:
                raise HTTPException(409, 'Worker parent context is unavailable in this project')
            fields = request.model_dump(mode='json', exclude={
                'task_context_token', 'model_strategy', 'bootstrap_lifetime_seconds'})
            fields.update(payload_hash=payload_hash, model_strategy_json=request.model_strategy.model_dump_json())
            data = {'run': fields, 'parent': dict(rows[0]['parent']), 'session': dict(rows[0]['session'])}
            await lock_worker_scope(scoped, request, data)
            await validate_worker_authority(scoped, request, data)
            timestamp = now_utc()
            fields.update(id=run_id, parent_context_id=data['parent']['id'], state='prepared', created_at=timestamp,
                          bootstrap_expires_at=timestamp + timedelta(seconds=request.bootstrap_lifetime_seconds))
            try:
                saved, _, _ = await scoped.runtime.driver.execute_query('''
                    MATCH (parent:FuliTaskContext {id: $parent_id})
                    MATCH (task:FuliProjectAgentTask {task_id: $task_id, personal_space_id: $space_id})
                    MATCH (:FuliSpace {id: $space_id})-[:HAS_PROJECT_AGENT_IDENTITY]->
                      (agent:FuliProjectAgent {agent_id: $agent_id})
                    MERGE (run:FuliProjectAgentWorkerRun {id: $run_id})
                    ON CREATE SET run += $fields
                    WITH parent, task, agent, run WHERE run.payload_hash = $payload_hash
                    MERGE (parent)-[:AUTHORIZES_WORKER_RUN]->(run)
                    MERGE (task)-[:HAS_WORKER_RUN]->(run)
                    MERGE (run)-[:WORKER_AGENT]->(agent)
                    RETURN run
                    ''', run_id=run_id, parent_id=data['parent']['id'], task_id=request.task_id,
                    space_id=request.personal_space_id, agent_id=request.agent_id,
                    fields=fields, payload_hash=payload_hash)
            except ConstraintError as error:
                raise HTTPException(409, 'Worker runtime capability is already assigned to another run') from error
            if not saved:
                raise HTTPException(409, 'Worker run idempotency key has different input')
            return worker_run_view(dict(saved[0]['run']))

    async def claim_project_agent_worker_start(self, actor, run_id, request, capability):
        async with query_store_transaction(self) as scoped:
            data = await checked_worker_run(scoped, actor, request, run_id, capability)
            run = data['run']
            claimed = run['state'] == 'prepared'
            if claimed:
                rows, _, _ = await scoped.runtime.driver.execute_query('''
                    MATCH (run:FuliProjectAgentWorkerRun {id: $run_id})
                    WHERE run.state = 'prepared'
                    SET run.state = 'claimed', run.claimed_at = datetime() RETURN run
                    ''', run_id=run_id)
                run = dict(rows[0]['run'])
            return {**worker_run_view(run), 'start_claimed': claimed}

    async def seal_project_agent_worker_session(self, actor, run_id, request, capability):
        async with query_store_transaction(self) as scoped:
            data = await checked_worker_run(scoped, actor, request, run_id, capability,
                                            proposed_session=request.session_id)
            run = data['run']
            if request.source_application != run['target_application']:
                raise HTTPException(409, 'Worker session belongs to another client')
            if run.get('actual_session_id'):
                if run['actual_session_id'] != request.session_id:
                    raise HTTPException(409, 'Worker session is immutable; a restart requires a new run')
                return worker_run_view(run)
            if run['state'] != 'claimed':
                raise HTTPException(409, 'Worker start must be claimed before sealing its session')
            session_id = scoped._task_session_id(request.personal_space_id, request.source_application, request.session_id)
            try:
                rows, _, _ = await scoped.runtime.driver.execute_query('''
                    MATCH (session:FuliTaskContextSession {id: $session_id})
                    MATCH (run:FuliProjectAgentWorkerRun {id: $run_id})
                    WHERE NOT EXISTS { MATCH (session)-[:HAS_CONTEXT]->(:FuliTaskContext) }
                      AND NOT EXISTS { MATCH (session)-[:BOUND_WORKER_RUN]->(:FuliProjectAgentWorkerRun) }
                    SET run.actual_session_id = $actual_session, run.state = 'sealed', run.sealed_at = datetime()
                    CREATE (session)-[:BOUND_WORKER_RUN]->(run)
                    RETURN run
                    ''', session_id=session_id, run_id=run_id, actual_session=request.session_id)
            except ConstraintError as error:
                raise HTTPException(409, 'Worker session is already assigned to another run') from error
            if not rows:
                raise HTTPException(409, 'Worker sealing requires a new session without an existing task context')
            return worker_run_view(dict(rows[0]['run']))

    async def admit_project_agent_worker_context(self, actor, run_id, request, capability):
        async with query_store_transaction(self) as scoped:
            data = await checked_worker_run(scoped, actor, request, run_id, capability)
            run = data['run']
            if (run['state'] not in {'sealed', 'admitted'} or request.source_application != run['target_application']
                    or request.session_id != run.get('actual_session_id')):
                raise HTTPException(409, 'Worker admission requires the exact sealed client and session')
            agent = data['agent']
            task_only = agent.get('memory_scope') == 'task_only'
            memory = None if task_only else await scoped.get_project_agent_memory(
                actor, request.personal_space_id, request.personal_project_id, run['agent_id'])
            own = await scoped._begin_task_context(actor, TaskContextBegin(
                personal_space_id=request.personal_space_id, personal_project_id=request.personal_project_id,
                project_agent_id=run['agent_id'], source_application=run['target_application'],
                session_id=request.session_id, source_session_id=request.session_id,
                token='fuli-task-' + str(uuid4()), turn_id='worker-run:' + run_id,
                memory_revision=memory.revision if memory else None, work_log_required=True,
            ), worker_run_id=run_id, agent_memory_scope='task_only' if task_only else 'reviewed_agent')
            rows, _, _ = await scoped.runtime.driver.execute_query('''
                MATCH (run:FuliProjectAgentWorkerRun {id: $run_id}), (context:FuliTaskContext {token: $token})
                MERGE (context)-[:FOR_WORKER_RUN]->(run)
                SET run.state = 'admitted', run.admitted_at = coalesce(run.admitted_at, datetime()) RETURN run
                ''', run_id=run_id, token=own['token'])
            return {**worker_run_view(dict(rows[0]['run']), own['token']), 'task_context': own}

    async def get_project_agent_worker_run(self, actor, run_id, request, capability):
        await worker_scope(self, actor, request)
        data = await load_worker_run(self, request, run_id)
        require_capability(data['run'], capability)
        rows, _, _ = await self.runtime.driver.execute_query('''
            OPTIONAL MATCH (context:FuliTaskContext)-[:FOR_WORKER_RUN]->(run:FuliProjectAgentWorkerRun {id: $run_id})
            RETURN context.token AS token
            ''', run_id=run_id)
        return worker_run_view(data['run'], rows[0]['token'] if rows else None)

    async def close_project_agent_worker_run(self, actor, run_id, request, capability=None, *, revoke=False):
        async with query_store_transaction(self) as scoped:
            await worker_scope(scoped, actor, request)
            data = await load_worker_run(scoped, request, run_id)
            if not revoke:
                require_capability(data['run'], capability)
            await lock_worker_scope(scoped, request, data)
            state = 'revoked' if revoke else 'closed'
            rows, _, _ = await scoped.runtime.driver.execute_query('''
                MATCH (run:FuliProjectAgentWorkerRun {id: $run_id})
                FOREACH (_ IN CASE WHEN run.state IN ['closed', 'revoked'] THEN [] ELSE [1] END |
                  SET run.state = $state, run.close_reason = $reason, run.closed_at = datetime())
                FOREACH (_ IN CASE WHEN $state = 'revoked' AND run.revoked_at IS NULL THEN [1] ELSE [] END |
                  SET run.state = 'revoked', run.revoked_at = datetime())
                RETURN run
                ''', run_id=run_id, state=state, reason=request.reason)
            return worker_run_view(dict(rows[0]['run']))

    async def guard_worker_task_context(self, actor, space_id, token, *, for_write=False):
        rows, _, _ = await self.runtime.driver.execute_query('''
            MATCH (context:FuliTaskContext {token: $token, personal_space_id: $space_id})-
              [:FOR_WORKER_RUN]->(run:FuliProjectAgentWorkerRun)
            RETURN run.id AS run_id, run.personal_project_id AS project_id
            ''', space_id=space_id, token=token)
        if not rows:
            return
        scope = SimpleNamespace(personal_space_id=space_id, personal_project_id=rows[0]['project_id'])
        async with query_store_transaction(self) as scoped:
            await worker_scope(scoped, actor, scope)
            data = await load_worker_run(scoped, scope, rows[0]['run_id'])
            if for_write:
                await lock_worker_scope(scoped, scope, data)
            require_open_worker_run(data['run'])
            if data['run']['state'] != 'admitted':
                raise HTTPException(409, 'Worker context has not been admitted')
            await validate_worker_authority(scoped, scope, data)
