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


class StoreTaskContexts:
    async def begin_task_context(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        if request.personal_project_id:
            await authorize_personal_project(self, actor, space, request.personal_project_id)
        if request.project_agent_id:
            agent = await authorize_project_agent(
                self, actor, space, request.personal_project_id,
                request.project_agent_id, require_active=True,
            )
            allowed_clients = json.loads(agent['profile_json']).get('allowed_clients', [])
            if request.source_application not in allowed_clients:
                raise HTTPException(status_code=403, detail='Agent is not allowed in this client')
        record = request.model_dump(mode='json')
        record.update(checkpoint=None, created_at=now_utc().isoformat())
        try:
            rows, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
                MERGE (session:FuliTaskContextSession {id: $session_id})
                SET session.write_serial = coalesce(session.write_serial, 0) + 1
                MERGE (space)-[:HAS_TASK_CONTEXT_SESSION]->(session)
                WITH session
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
                created_at=now_utc(),
                record_json=json.dumps(record, ensure_ascii=False),
            )
        except ConstraintError as error:
            # Tokens are space-wide handles; never attach one to another session.
            raise HTTPException(status_code=409,
                detail='Task context token is already in use') from error
        if not rows[0]['is_current']:
            raise HTTPException(status_code=409, detail='Task turn has been superseded')
        saved = json.loads(rows[0]['record_json'])
        for field in ('personal_project_id', 'project_agent_id', 'source_application', 'turn_id'):
            if saved[field] != getattr(request, field):
                raise HTTPException(status_code=409, detail='Task turn already has another context')
        return {**saved, 'previous_checkpoint_missing': rows[0]['previous_checkpoint_missing']}

    async def get_task_context(self, actor, space_id, token, source_application):
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession)-
                  [:HAS_CONTEXT]->(task:FuliTaskContext {token: $token})
            WHERE session.current_token = task.token
            RETURN task.record_json AS record_json
            ''', space_id=space_id, token=token, routing_='r',
        )
        if not rows:
            raise HTTPException(status_code=404, detail='Task context is unknown or superseded')
        record = json.loads(rows[0]['record_json'])
        if record['source_application'] != source_application:
            raise HTTPException(status_code=404, detail='Task context not found for this client')
        return record

    async def checkpoint_task_context(self, actor, token, request):
        if request.agent_memory is None:
            return await self._checkpoint_task_context(actor, token, request)
        # A rejected preparation cannot commit memory. A later host turn may
        # still supersede a successfully prepared context; complete is separate.
        async with query_store_transaction(self) as scoped:
            record = await scoped._checkpoint_task_context(actor, token, request)
            if not record['project_agent_id'] or not record['personal_project_id']:
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
            return {**record, 'agent_memory': memory.model_dump(mode='json')}

    async def _checkpoint_task_context(self, actor, token, request):
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        record = await self.get_task_context(
            actor, request.personal_space_id, token, request.source_application,
        )
        checkpoint = request.model_dump(mode='json', exclude={
            'personal_space_id', 'source_application', 'agent_memory',
        })
        # Complete retries must preserve the original completion timestamp/result.
        record['checkpoint'] = checkpoint
        # Bind memory presence independently of the caller's fingerprint. Its
        # content is already immutable under the memory checkpoint's payload hash.
        # The existing checkpoint lets pre-upgrade claims retry without new writes.
        memory_checkpoint_id = None
        if record['project_agent_id'] and record['personal_project_id']:
            memory_checkpoint_id = stable_uuid(self._agent_memory_id(
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
              AND (NOT $is_prepare OR memory_claimed = $has_agent_memory)
            ) AS matches,
            CASE WHEN first_claim THEN $has_agent_memory ELSE memory_claimed END AS memory_claimed
            FOREACH (ignored IN CASE WHEN matches AND NOT task.completed THEN [1] ELSE [] END |
              SET task.fingerprint = $fingerprint, task.record_json = $record_json,
                  task.agent_memory_claimed = memory_claimed,
                  task.completed = $completed, task.disposition = $disposition, task.reason = $reason
            )
            RETURN matches, task.record_json AS record_json
            ''', space_id=request.personal_space_id, token=token,
            fingerprint=request.fingerprint, record_json=json.dumps(record, ensure_ascii=False),
            disposition=request.disposition, reason=request.reason,
            completed=request.phase == 'complete',
            is_prepare=request.phase == 'prepare',
            has_agent_memory=request.agent_memory is not None,
            memory_checkpoint_id=memory_checkpoint_id,
        )
        if not rows or not rows[0]['matches']:
            raise HTTPException(status_code=409, detail='Task checkpoint conflicts or was superseded')
        return json.loads(rows[0]['record_json'])

    async def verify_task_checkpoint(self, actor, space_id, session_id, source_application):
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession {id: $session_id})-
                  [:HAS_CONTEXT]->(task:FuliTaskContext)
            WHERE task.token = session.current_token
            RETURN task.record_json AS record_json, task.completed AS completed
            ''', space_id=space_id,
            session_id=self._task_session_id(space_id, source_application, session_id),
            routing_='r',
        )
        if not rows:
            return {'status': 'not_started', 'guidance': 'No Fuli context started; do not block.'}
        record = json.loads(rows[0]['record_json'])
        if rows[0]['completed']:
            return {'status': 'checkpointed', 'disposition': record['checkpoint']['disposition']}
        return {
            'status': 'checkpoint_required', 'decision': 'block',
            'task_context_token': record['token'],
            'reason': f'FULI_CHECKPOINT_REQUIRED: {record["token"]} '
                'Before finishing, call checkpoint_task_knowledge using this task_context_token '
                'with capture_candidates or retain_nothing; include agentMemory when durable '
                'role context changed. Never store raw transcripts or credentials.',
        }

    def _task_session_id(self, space_id, source_application, session_id):
        return stable_uuid(self.settings.provider_id, space_id, source_application,
            session_id, 'task-context-session')
