"""Task lifecycle shared by independent host-hook and MCP processes.

Session and token nodes are locked in the same order. End-of-task claims bind
an immutable payload fingerprint before side effects; retries can safely resume.
"""

import json

from fastapi import HTTPException
from neo4j.exceptions import ConstraintError

from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .provider_values import now_utc, stable_uuid
from .project_agent_memory_models import ProjectAgentMemoryWrite
from .store_transactions import query_store_transaction
from .task_context_adoption import adopt_task_agent
from .task_context_coordination import bind_coordination_task, task_context_json, task_context_record
from .collaboration_context import read_collaboration_context
from .knowledge_audit import record_knowledge_usage
from .knowledge_usage_models import KnowledgeUsageCreate
from .task_context_auto_close import close_previous_routine_fallback, routine_context_state
from .task_worker_attribution import lock_checkpoint_context, checkpoint_collaboration
from .task_activity_origin import context_activity_origin


class StoreTaskContexts:
    async def adopt_task_context_agent(self, actor, token, request):
        async with query_store_transaction(self) as scoped:
            await bind_coordination_task(scoped, actor, token, request)
            await adopt_task_agent(scoped, actor, token, request)
            return await scoped.get_task_context(actor, request.personal_space_id, token, request.source_application)

    async def bind_task_context_coordination_task(self, actor, token, request):
        return await bind_coordination_task(self, actor, token, request)

    async def begin_task_context(self, actor, request):
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        async with query_store_transaction(self) as scoped:
            session_id = scoped._task_session_id(request.personal_space_id, request.source_application, request.session_id)
            await scoped._lock_task_context_session(session_id)
            await scoped._link_task_context_sessions(request.personal_space_id, [session_id])
            return await scoped._begin_task_context(actor, request)

    async def _lock_task_context_session(self, session_id):
        # One completed query per ID: a batch MERGE can lock Space before the
        # sorted sessions, defeating the apparent ORDER BY in a caller.
        # Lock before the read-dependent increment: its automatic locking can
        # deadlock with a concurrent transaction creating HAS_CONTEXT relations.
        await self.runtime.driver.execute_query('''
            MERGE (session:FuliTaskContextSession {id: $id})
            SET session._fuli_write_lock = true REMOVE session._fuli_write_lock
            WITH session
            SET session.write_serial = coalesce(session.write_serial, 0) + 1
            RETURN session.id AS id
            ''', id=session_id)

    async def _link_task_context_sessions(self, space_id, session_ids):
        # Call only after every involved session is locked. CREATE avoids a
        # relationship MERGE's implicit Space locks during session acquisition.
        await self.runtime.driver.execute_query('''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            UNWIND $session_ids AS session_id
            MATCH (session:FuliTaskContextSession {id: session_id})
            WHERE NOT EXISTS { MATCH (space)-[:HAS_TASK_CONTEXT_SESSION]->(session) }
            CREATE (space)-[:HAS_TASK_CONTEXT_SESSION]->(session)
            RETURN count(session) AS linked
            ''', space_id=space_id, session_ids=session_ids)

    async def _begin_task_context(self, actor, request, *, worker_run_id=None, agent_memory_scope=None):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        if request.personal_project_id:
            await authorize_personal_project(self, actor, space, request.personal_project_id)
        if request.project_agent_id:
            agent = await authorize_project_agent(
                self, actor, space, request.personal_project_id,
                request.project_agent_id, require_active=True, allow_global=True,
            )
            allowed_clients = json.loads(agent['profile_json']).get('allowed_clients', [])
            if request.source_application not in allowed_clients:
                raise HTTPException(status_code=403, detail='Agent is not allowed in this client')
        record = request.model_dump(mode='json')
        origin = await context_activity_origin(self, actor, request, worker_run_id=worker_run_id)
        record['activity_origin'] = origin.model_dump() if origin else None
        record.update(checkpoint=None, created_at=now_utc().isoformat())
        if worker_run_id:
            record['agent_memory_scope'] = agent_memory_scope
        else:
            await close_previous_routine_fallback(self, actor, request)
        try:
            rows, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                      [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession {id: $session_id})
                WITH session
                OPTIONAL MATCH (session)-[:BOUND_WORKER_RUN]->(worker_run:FuliProjectAgentWorkerRun)
                WITH session, worker_run
                WHERE ($worker_run_id IS NULL AND worker_run IS NULL AND NOT EXISTS {
                         MATCH (:FuliProjectAgentWorkerRun {target_application: $application,
                                                           actual_session_id: $actual_session}) })
                   OR (worker_run.id = $worker_run_id AND worker_run.state IN ['sealed', 'admitted']
                       AND worker_run.personal_space_id = $space_id AND worker_run.agent_id = $agent_id
                       AND worker_run.personal_project_id = $project_id
                       AND worker_run.target_application = $application
                       AND worker_run.actual_session_id = $actual_session
                       AND $turn_id = 'worker-run:' + worker_run.id)
                OPTIONAL MATCH (session)-[:HAS_CONTEXT]->(previous:FuliTaskContext)
                WHERE previous.token = session.current_token
                WITH session, previous
                OPTIONAL MATCH (session)-[:HAS_CONTEXT]->(retry:FuliTaskContext)
                WHERE retry.token = $token OR ($turn_id IS NOT NULL AND retry.turn_id = $turn_id)
                WITH session, previous, retry
                ORDER BY CASE WHEN retry.token = $token THEN 0 ELSE 1 END, retry.id
                LIMIT 1
                FOREACH (ignored IN CASE WHEN retry IS NULL THEN [1] ELSE [] END |
                  CREATE (task:FuliTaskContext {id: $context_id, token: $token,
                    turn_id: $turn_id, record_json: $record_json, completed: false,
                    personal_space_id: $space_id, personal_project_id: $project_id,
                    project_agent_id: $agent_id, created_at: $created_at})
                  CREATE (session)-[:HAS_CONTEXT]->(task)
                  SET session.current_token = $token
                )
                WITH session, previous, retry
                MATCH (session)-[:HAS_CONTEXT]->(saved:FuliTaskContext)
                WHERE saved.token = coalesce(retry.token, $token)
                RETURN saved.record_json AS record_json,
                       [(saved)-[:COORDINATES_TASK]->(linked:FuliProjectAgentTask) | linked.task_id] AS coordination_task_ids,
                       saved.token = session.current_token AS is_current,
                       previous IS NOT NULL AND NOT coalesce(previous.completed, false)
                           AND previous.token <> saved.token AS previous_checkpoint_missing
                ''',
                space_id=request.personal_space_id,
                session_id=self._task_session_id(
                    request.personal_space_id, request.source_application, request.session_id,
                ),
                context_id=stable_uuid(request.personal_space_id, request.token),
                token=request.token, turn_id=request.turn_id,
                project_id=request.personal_project_id, agent_id=request.project_agent_id,
                worker_run_id=worker_run_id, application=request.source_application,
                actual_session=request.session_id,
                created_at=now_utc(),
                record_json=json.dumps(record, ensure_ascii=False),
            )
        except ConstraintError as error:
            # Tokens are space-wide handles; never attach one to another session.
            raise HTTPException(status_code=409,
                detail='Task context token is already in use') from error
        if not rows:
            raise HTTPException(409, 'Task session is unavailable for this context entry')
        if not rows[0]['is_current']:
            raise HTTPException(status_code=409, detail='Task turn has been superseded')
        saved = task_context_record(rows[0])
        for field in ('personal_project_id', 'project_agent_id', 'source_application', 'turn_id'):
            if saved[field] != getattr(request, field):
                raise HTTPException(status_code=409, detail='Task turn already has another context')
        if saved.get('preference_scope') != record['preference_scope']:
            raise HTTPException(409, 'Task preference scope is immutable; begin a new task for different dimensions')
        # Retries return the first stored provenance, including legacy unknown.
        # Creation alone derives origin; a fresh proof never backfills old tasks.
        _, routine_eligible = await routine_context_state(self, request.personal_space_id,
            self._task_session_id(request.personal_space_id, request.source_application, request.session_id))
        return {**saved, 'previous_checkpoint_missing': rows[0]['previous_checkpoint_missing'],
                # Admission creates FOR_WORKER_RUN after this call. The sealed
                # identity already rules out routine closure on its first entry.
                'routine_auto_close_eligible': worker_run_id is None and routine_eligible}

    async def current_task_context(self, actor, space_id, session_id, source_application):
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (s:FuliTaskContextSession {id: $id})-[:HAS_CONTEXT]->(t:FuliTaskContext) '
            'WHERE t.token=s.current_token RETURN t.record_json AS record_json, '
            'head([(t)-[:FOR_WORKER_RUN]->(run:FuliProjectAgentWorkerRun) | run.id]) AS worker_run_id, '
            '[(t)-[:COORDINATES_TASK]->(linked:FuliProjectAgentTask) | linked.task_id] AS coordination_task_ids',
            id=self._task_session_id(space_id, source_application, session_id))
        if rows and rows[0].get('worker_run_id'):
            await self.guard_worker_task_context(actor, space_id, json.loads(rows[0]['record_json'])['token'])
        return task_context_record(rows[0]) if rows else None

    async def recent_agent_sessions(self, actor, space_id, agent_id, project_id, limit):
        """The host conversations an Agent most recently worked in, newest first."""
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_TASK_CONTEXT_SESSION]->(:FuliTaskContextSession)-
                  [:HAS_CONTEXT]->(task:FuliTaskContext {project_agent_id: $agent_id})
            WHERE $project_id IS NULL OR task.personal_project_id = $project_id
            RETURN task.record_json AS record_json, task.created_at AS created_at
            ORDER BY task.created_at DESC LIMIT 200
            ''', space_id=space_id, agent_id=agent_id, project_id=project_id, routing_='r',
        )
        sessions = {}
        for row in rows:
            record = json.loads(row['record_json'])
            key = (record['source_application'], record['session_id'])
            if key not in sessions:
                sessions[key] = {
                    'source_application': key[0], 'session_id': key[1],
                    'personal_project_id': record.get('personal_project_id'),
                    'last_active': str(row['created_at']),
                }
        return list(sessions.values())[:limit]

    async def get_task_context(self, actor, space_id, token, source_application):
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession)-
                  [:HAS_CONTEXT]->(task:FuliTaskContext {token: $token})
            WHERE session.current_token = task.token
            RETURN task.record_json AS record_json,
                   head([(task)-[:FOR_WORKER_RUN]->(run:FuliProjectAgentWorkerRun) | run.id]) AS worker_run_id,
                   [(task)-[:COORDINATES_TASK]->(linked:FuliProjectAgentTask) | linked.task_id] AS coordination_task_ids
            ''', space_id=space_id, token=token, routing_='r',
        )
        if not rows:
            raise HTTPException(status_code=404, detail='Task context is unknown or superseded')
        record = task_context_record(rows[0])
        if record['source_application'] != source_application:
            raise HTTPException(status_code=404, detail='Task context not found for this client')
        if rows[0].get('worker_run_id'):
            await self.guard_worker_task_context(actor, space_id, token)
        return record

    async def read_task_preferences(self, actor, token, request):
        record = await self.get_task_context(actor, request.personal_space_id, token, request.source_application)
        if record['session_id'] != request.session_id:
            raise HTTPException(404, 'Task preferences are unavailable for this session')
        scope = record.get('preference_scope')
        if scope is None:
            raise HTTPException(409, 'Task preference scope is unknown; recovery cannot guess legacy dimensions')
        if (record.get('checkpoint') or {}).get('phase') == 'complete':
            raise HTTPException(409, 'Task preference recovery requires an unfinished task')
        if record.get('project_agent_id'):
            space = await self.authorize(actor, request.personal_space_id, 'reader')
            agent = await authorize_project_agent(self, actor, space, record.get('personal_project_id'),
                                                  record['project_agent_id'], require_active=True, allow_global=True)
            if request.source_application not in json.loads(agent['profile_json']).get('allowed_clients', []):
                raise HTTPException(403, 'Agent is not allowed in this client')
        # All applicability dimensions come from the durable task, never the reader.
        preferences = await read_collaboration_context(
            self, actor, request.personal_space_id, record.get('personal_project_id'),
            project_agent_id=record.get('project_agent_id'), session_id=record['session_id'],
            work_kind=scope['work_kind'], workflow=scope['workflow'], complete=True,
        )
        # Recheck current ownership and worker revocation after the source read.
        current = await self.get_task_context(actor, request.personal_space_id, token, request.source_application)
        if current != record:
            raise HTTPException(409, 'Task context changed during preference recovery')
        return {'task_context': record, 'preferences': preferences.model_dump(mode='json')}

    async def checkpoint_task_context(self, actor, token, request):
        # A rejected preparation cannot commit memory. A later host turn may
        # still supersede a successfully prepared context; complete is separate.
        async with query_store_transaction(self) as scoped:
            await scoped.guard_worker_task_context(actor, request.personal_space_id, token, for_write=True)
            record = await scoped._checkpoint_task_context(actor, token, request)
            if request.agent_memory is not None:
                if not record['project_agent_id']:
                    raise HTTPException(status_code=409, detail='Task has no durable Agent memory target')
                memory = await scoped.write_project_agent_memory(actor, ProjectAgentMemoryWrite(
                    personal_space_id=request.personal_space_id,
                    personal_project_id=record['personal_project_id'],
                    agent_id=record['project_agent_id'],
                    expected_revision=request.agent_memory.expected_revision,
                    memory=request.agent_memory.memory,
                    idempotency_key=f'{token}:memory',
                    source_application=record['source_application'],
                    # The client lifecycle session remains stable when entry and
                    # checkpoint hooks use different short-lived MCP processes.
                    source_session_id=record['session_id'],
                ))
                record['agent_memory'] = memory.model_dump(mode='json')
            if request.knowledge_usage is not None:
                result = record['checkpoint'].get('knowledge_usage_result')
                if result is None:
                    result = (await record_knowledge_usage(scoped, actor, KnowledgeUsageCreate(
                        personal_space_id=request.personal_space_id, task_id=token,
                        session_id=record['session_id'], tool_name='checkpoint_task_knowledge',
                        items=request.knowledge_usage,
                    ))).model_dump(mode='json')
                record['checkpoint']['knowledge_usage_result'] = result
                # Persist the receipt with the claim and usage writes. Replays use
                # this result even if the knowledge has since changed generation.
                await scoped.runtime.driver.execute_query('''
                    MATCH (task:FuliTaskContext {personal_space_id: $space_id, token: $token})
                    SET task.knowledge_usage_result_json = $result, task.record_json = $record_json
                    ''', space_id=request.personal_space_id, token=token,
                    result=json.dumps(result, ensure_ascii=False),
                    record_json=task_context_json({key: value for key, value in record.items()
                                                   if key != 'agent_memory'}))
            return record

    async def _checkpoint_task_context(self, actor, token, request):
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        await lock_checkpoint_context(self, request.personal_space_id, token)
        record = await self.get_task_context(
            actor, request.personal_space_id, token, request.source_application,
        )
        if record.get('work_log_required') and request.work_log is None:
            raise HTTPException(422, 'Employee work summary is required before checkpointing')
        if any(item.scope == 'current_project'
               and item.personal_project_id != record.get('personal_project_id')
               for item in request.capture_results or []):
            raise HTTPException(422, 'Capture receipt belongs to another project')
        checkpoint = request.model_dump(mode='json', exclude={
            'personal_space_id', 'source_application', 'agent_memory',
        })
        checkpoint['collaboration'] = await checkpoint_collaboration(self, request.personal_space_id, record)
        if request.capture_results is None:
            checkpoint.pop('capture_results', None)
        if request.knowledge_usage is None:
            checkpoint.pop('knowledge_usage', None)
        # Complete retries must preserve the original completion timestamp/result.
        record['checkpoint'] = checkpoint
        # Bind memory presence independently of the caller's fingerprint. Its
        # content is already immutable under the memory checkpoint's payload hash.
        # The existing checkpoint lets pre-upgrade claims retry without new writes.
        memory_checkpoint_id = None
        if (record['project_agent_id']
                and record.get('agent_memory_scope') != 'task_only'):
            memory_checkpoint_id = stable_uuid(await self._resolved_agent_memory_id(
                request.personal_space_id, record['personal_project_id'],
                record['project_agent_id'],
            ), f'{token}:memory')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession)-
                  [:HAS_CONTEXT]->(task:FuliTaskContext {token: $token})
            SET session.write_serial = coalesce(session.write_serial, 0) + 1
            WITH session, task
            WHERE session.current_token = task.token
            SET task.write_serial = coalesce(task.write_serial, 0) + 1
            WITH task
            OPTIONAL MATCH (memory:FuliProjectAgentMemoryCheckpoint {id: $memory_checkpoint_id})
            WITH task, task.fingerprint IS NULL AS first_claim,
                 coalesce(task.agent_memory_claimed, memory IS NOT NULL) AS memory_claimed
            WITH task, first_claim OR (
              task.fingerprint = $fingerprint AND task.disposition = $disposition
              AND task.reason = $reason
              AND coalesce(task.work_log_json, 'null') = $work_log_json
              AND coalesce(task.knowledge_usage_json, 'null') = $knowledge_usage_json
              AND (NOT $is_prepare OR memory_claimed = $has_agent_memory)
            ) AS matches,
            CASE WHEN first_claim THEN $has_agent_memory ELSE memory_claimed END AS memory_claimed
            FOREACH (ignored IN CASE WHEN matches AND NOT task.completed THEN [1] ELSE [] END |
              SET task.fingerprint = $fingerprint, task.record_json = $record_json,
                  task.agent_memory_claimed = memory_claimed,
                  task.work_log_json = $work_log_json,
                  task.knowledge_usage_json = $knowledge_usage_json,
                  task.completed = $completed, task.disposition = $disposition, task.reason = $reason
            )
            RETURN matches, task.record_json AS record_json,
                   task.knowledge_usage_result_json AS knowledge_usage_result_json,
                   [(task)-[:COORDINATES_TASK]->(linked:FuliProjectAgentTask) | linked.task_id] AS coordination_task_ids
            ''', space_id=request.personal_space_id, token=token,
            fingerprint=request.fingerprint, record_json=task_context_json(record),
            disposition=request.disposition, reason=request.reason,
            completed=request.phase == 'complete',
            is_prepare=request.phase == 'prepare',
            has_agent_memory=request.agent_memory is not None,
            work_log_json=json.dumps(request.work_log.model_dump() if request.work_log else None,
                                     sort_keys=True, ensure_ascii=False),
            memory_checkpoint_id=memory_checkpoint_id,
            knowledge_usage_json=json.dumps(
                [item.model_dump(mode='json') for item in request.knowledge_usage]
                if request.knowledge_usage is not None else None, sort_keys=True, ensure_ascii=False),
        )
        if not rows or not rows[0]['matches']:
            raise HTTPException(status_code=409, detail='Task checkpoint conflicts or was superseded')
        saved = task_context_record(rows[0])
        if rows[0].get('knowledge_usage_result_json'):
            saved['checkpoint']['knowledge_usage_result'] = json.loads(rows[0]['knowledge_usage_result_json'])
        return saved

    async def verify_task_checkpoint(self, actor, space_id, session_id, source_application):
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession {id: $session_id})-
                  [:HAS_CONTEXT]->(task:FuliTaskContext)
            WHERE task.token = session.current_token
            OPTIONAL MATCH (task)-[:FOR_WORKER_RUN]->(run:FuliProjectAgentWorkerRun)
            RETURN task.record_json AS record_json, task.completed AS completed,
                   run.state AS worker_run_state
            ''', space_id=space_id,
            session_id=self._task_session_id(space_id, source_application, session_id),
            routing_='r',
        )
        if not rows:
            return {'status': 'not_started', 'guidance': 'No Fuli context started; do not block.'}
        record = json.loads(rows[0]['record_json'])
        if rows[0]['completed']:
            return {'status': 'checkpointed', 'disposition': record['checkpoint']['disposition']}
        run_state = rows[0].get('worker_run_state')
        if run_state in {'closed', 'revoked'}:
            return {'status': f'worker_run_{run_state}',
                'guidance': f'Worker run is {run_state}; no checkpoint is required. Do not block.'}
        # The proof the next entry uses to close a routine fallback lets the
        # Stop hook close it now, so a one-shot session is not left open.
        _, routine_eligible = await routine_context_state(self, space_id,
            self._task_session_id(space_id, source_application, session_id))
        return {
            'status': 'checkpoint_required', 'decision': 'block',
            'task_context_token': record['token'], 'entry_via': record.get('entry_via', 'tool'),
            'routine_auto_close_eligible': routine_eligible,
            'reason': f'FULI_CHECKPOINT_REQUIRED: {record["token"]} '
                'Before finishing, call checkpoint_task_knowledge using this task_context_token '
                'with capture_candidates or retain_nothing and workLog (summary and truthful status); include agentMemory when durable '
                'role context changed. Never store raw transcripts or credentials.',
        }

    def _task_session_id(self, space_id, source_application, session_id):
        return stable_uuid(self.settings.provider_id, space_id, source_application,
            session_id, 'task-context-session')
