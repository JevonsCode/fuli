"""Atomic task activity, execution audit and terminal evidence writes."""

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_executor_models import (
    ProjectAgentExecutorActualReport,
    ProjectAgentExecutorOutcomeEvidenceCreate,
)
from .project_agent_models import ProjectAgentModelStrategy, ProjectAgentProfile
from .project_agent_task_models import ProjectAgentTaskActivityCreate, ProjectAgentTaskRecord
from .provider_values import now_utc, stable_uuid
from .store_project_agent_task_recruitment import RECRUITMENT_CLAIM_TTL
from .store_transactions import query_store_transaction


TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled"}


class StoreProjectAgentTaskActivity:
    """Persist activity and its derived audit within one request-owned transaction."""

    async def record_project_agent_task_activity(
        self,
        actor: dict,
        request: ProjectAgentTaskActivityCreate,
    ) -> ProjectAgentTaskRecord:
        async with query_store_transaction(self) as scoped:
            return await scoped._record_project_agent_task_activity(actor, request)

    async def _record_project_agent_task_activity(
        self,
        actor: dict,
        request: ProjectAgentTaskActivityCreate,
    ) -> ProjectAgentTaskRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        # Acquire the task's write lock before reading its revision, transition
        # state or idempotency events. A transaction alone permits two concurrent
        # readers to validate the same revision before either obtains a lock.
        await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                  -[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {
                    personal_space_id: $personal_space_id,
                    personal_project_id: $personal_project_id,
                    task_id: $task_id
                  })
            SET task._activity_write_lock = true
            REMOVE task._activity_write_lock
            RETURN task.task_id AS task_id
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            task_id=request.task_id,
        )
        row = await self._find_task_row(request.personal_space_id, request.task_id)
        if not row:
            raise HTTPException(status_code=404, detail='project Agent task not found')
        raw_task = dict(row['task'])
        if raw_task['personal_project_id'] != request.personal_project_id:
            raise HTTPException(status_code=404, detail='project Agent task not found')
        event_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-task-event',
            request.task_id,
            request.idempotency_key,
        )
        payload_hash = self._payload_hash(request)
        existing_event = next(
            (
                dict(value)
                for value in (row.get('event_rows') or [])
                if value
                and (value.get('event_id') or value.get('id')) == event_id
            ),
            None,
        )
        if existing_event:
            if existing_event.get('payload_hash') != payload_hash:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        'task event idempotency key was used with different input'
                    ),
                )
            return self._task_from_row(row)
        self._validate_task_transition(
            raw_task.get('status'),
            request.status,
            has_actual_executor=bool(request.actual_executor_id),
        )
        expected_revision = getattr(request, 'expected_revision', None)
        if expected_revision is None:
            expected_revision = raw_task.get('revision') or 0
        if request.agent_id:
            participant = next(
                (
                    item for item in self._participant_maps(row)
                    if item['agent_id'] == request.agent_id
                ),
                None,
            )
            if not participant:
                raise HTTPException(
                    status_code=409,
                    detail='Agent is not assigned to this task',
                )
            if participant.get('profile_json'):
                profile = ProjectAgentProfile.model_validate_json(
                    participant['profile_json']
                )
                for application in request.reported_client_applications:
                    self._require_agent_client_allowed(
                        {'agent_id': request.agent_id, 'profile': profile},
                        application,
                    )
        now = now_utc()
        terminal_at = now if request.status in TERMINAL_TASK_STATUSES else None
        actual_executor_id = getattr(request, 'actual_executor_id', None)
        matched_executor_rule_id = getattr(request, 'matched_executor_rule_id', None)
        executor_selection_reason = getattr(request, 'executor_selection_reason', None)
        executor_fallback_reason = getattr(request, 'executor_fallback_reason', None)
        executor_blocked_reason = getattr(request, 'executor_blocked_reason', None)
        worker_id = getattr(request, 'worker_id', None)
        worker_label = getattr(request, 'worker_label', None)
        worker_occupation_emoji = request.worker_occupation_emoji
        worker_status = getattr(request, 'worker_status', None)
        evidence_json = {
            key: value.model_dump_json() if value is not None else None
            for key, value in (
                ('token_usage', request.token_usage),
                ('worker_runtime', request.worker_runtime),
            )
        }
        actual_recorder = None
        actual_report = None
        if actual_executor_id:
            actual_recorder = getattr(
                self,
                'record_project_agent_executor_actual',
                None,
            )
            if not callable(actual_recorder):
                raise HTTPException(
                    status_code=503,
                    detail='executor evidence control plane is unavailable',
                )
            strategy = (
                ProjectAgentModelStrategy.model_validate_json(
                    raw_task['effective_model_strategy_json']
                )
                if raw_task.get('effective_model_strategy_json')
                else ProjectAgentModelStrategy()
            )
            actual_report = ProjectAgentExecutorActualReport(
                personal_space_id=request.personal_space_id,
                personal_project_id=request.personal_project_id,
                task_id=request.task_id,
                run_id=event_id,
                agent_id=request.agent_id,
                executor_id=actual_executor_id,
                provider=request.actual_model_provider,
                model=request.actual_model,
                model_strategy=strategy,
                model_strategy_source=(
                    raw_task.get('model_strategy_source') or 'coordinator'
                ),
                matched_rule_id=matched_executor_rule_id,
                fallback_reason=executor_fallback_reason,
                idempotency_key=f'actual:{event_id}',
                occurred_at=now,
                source_application=request.source_application,
                source_session_id=request.source_session_id,
            )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {
                    personal_space_id: $personal_space_id,
                    task_id: $task_id
                  })
            WHERE coalesce(task.revision, 0) = $expected_revision
               OR EXISTS {
                 MATCH (task)-[:HAS_TASK_EVENT]->
                       (:FuliProjectAgentTaskEvent {id: $event_id})
               }
            WITH space, task
            WHERE task.status <> 'awaiting_recruitment'
               OR $status = 'awaiting_recruitment'
               OR task.recruitment_provisioning_claimed_at IS NULL
               OR task.recruitment_provisioning_claimed_at <=
                  $recruitment_claim_expired_before
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            WHERE $agent_id IS NULL OR EXISTS {
              MATCH (task)-[:HAS_PARTICIPANT]->(agent)
            }
            WITH task, agent,
                 task.lead_agent_id IS NULL AND $status = 'running'
                   AS promote_lead
            WHERE NOT promote_lead OR (
              agent IS NOT NULL AND NOT EXISTS {
                MATCH (task)-[existing_lead:HAS_PARTICIPANT]->()
                WHERE existing_lead.role = 'lead'
              }
            )
            MERGE (event:FuliProjectAgentTaskEvent {id: $event_id})
            ON CREATE SET event.event_id = $event_id,
                          event.task_id = $task_id,
                          event.agent_id = $agent_id,
                          event.status = $status,
                          event.actor_kind = $actor_kind,
                          event.summary = $summary,
                          event.payload_hash = $payload_hash,
                          event.source_application = $source_application,
                          event.source_session_id = $source_session_id,
                          event.source_session_url = $source_session_url,
                          event.tools_used = $tools_used,
                          event.actual_model_provider = $actual_model_provider,
                          event.actual_model = $actual_model,
                          event.actual_executor_id = $actual_executor_id,
                          event.matched_executor_rule_id =
                            $matched_executor_rule_id,
                          event.executor_selection_reason =
                            $executor_selection_reason,
                          event.executor_fallback_reason =
                            $executor_fallback_reason,
                          event.executor_blocked_reason =
                            $executor_blocked_reason,
                          event.worker_id = $worker_id,
                          event.worker_label = $worker_label,
                          event.worker_occupation_emoji = $worker_occupation_emoji,
                          event.worker_status = $worker_status,
                          event.token_usage_json = $token_usage_json,
                          event.worker_runtime_json = $worker_runtime_json,
                          event.activity_date = CASE
                            WHEN $terminal_at IS NULL THEN null
                            ELSE date($terminal_at) END,
                          event.created_at = $updated_at
            WITH task, event, agent, promote_lead,
                 event.payload_hash = $payload_hash AS same_payload,
                 coalesce(task.revision, 0) = $expected_revision
                   AS applied_transition
            FOREACH (_ IN CASE
              WHEN same_payload AND applied_transition
              THEN [1] ELSE [] END |
              MERGE (task)-[:HAS_TASK_EVENT]->(event)
            )
            FOREACH (_ IN CASE
              WHEN same_payload AND applied_transition AND agent IS NOT NULL
              THEN [1] ELSE [] END |
              MERGE (event)-[:EVENT_AGENT]->(agent)
            )
            FOREACH (_ IN CASE
              WHEN same_payload AND applied_transition
              THEN [1] ELSE [] END |
              SET task.status = $status,
                  task.result_summary = CASE
                    WHEN $status = 'completed' THEN $summary
                    ELSE task.result_summary END,
                  task.failure_reason = CASE
                    WHEN $status = 'failed' THEN $summary
                    ELSE task.failure_reason END,
                  task.matched_executor_rule_id = CASE
                    WHEN $actual_executor_id IS NULL AND task.actual_run_id IS NULL
                    THEN coalesce($matched_executor_rule_id, task.matched_executor_rule_id)
                    ELSE task.matched_executor_rule_id END,
                  task.executor_selection_reason = coalesce(
                    $executor_selection_reason,
                    task.executor_selection_reason),
                  task.executor_fallback_reason = CASE
                    WHEN $actual_executor_id IS NULL AND task.actual_run_id IS NULL
                    THEN coalesce($executor_fallback_reason, task.executor_fallback_reason)
                    ELSE task.executor_fallback_reason END,
                  task.executor_blocked_reason = coalesce(
                    $executor_blocked_reason,
                    task.executor_blocked_reason),
                  task.completed_at = $terminal_at,
                  task.updated_at = CASE
                    WHEN task.updated_at IS NULL OR task.updated_at < $updated_at
                    THEN $updated_at ELSE task.updated_at END,
                  task.revision = coalesce(task.revision, 0) + 1
            )
            FOREACH (_ IN CASE
              WHEN same_payload AND applied_transition AND agent IS NOT NULL
              THEN [1] ELSE [] END |
              SET task.lead_agent_id = CASE
                WHEN promote_lead
                THEN agent.agent_id ELSE task.lead_agent_id END
            )
            WITH task, event, same_payload, applied_transition, promote_lead
            OPTIONAL MATCH (task)-[participant:HAS_PARTICIPANT]->
                           (participant_agent:FuliProjectAgent)
            FOREACH (_ IN CASE
              WHEN same_payload
                AND applied_transition
                AND participant IS NOT NULL
                AND NOT (coalesce(participant.status, '') IN
                    ['completed', 'failed', 'cancelled'])
                AND (
                  $terminal_at IS NOT NULL
                  OR $agent_id IS NULL
                  OR participant_agent.agent_id = $agent_id
                )
              THEN [1] ELSE [] END |
              SET participant.status = $status,
                  participant.role = CASE
                    WHEN promote_lead
                      AND participant_agent.agent_id = $agent_id
                    THEN 'lead' ELSE participant.role END,
                  participant.updated_at = $updated_at,
                  participant.ended_at = $terminal_at
            )
            RETURN DISTINCT task, event, same_payload, applied_transition
            ''',
            personal_space_id=request.personal_space_id,
            task_id=request.task_id,
            expected_revision=expected_revision,
            event_id=event_id,
            agent_id=request.agent_id,
            status=request.status,
            recruitment_claim_expired_before=now - RECRUITMENT_CLAIM_TTL,
            actor_kind=request.actor_kind,
            summary=request.summary,
            payload_hash=payload_hash,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            source_session_url=request.source_session_url,
            tools_used=request.tools_used,
            actual_model_provider=request.actual_model_provider,
            actual_model=request.actual_model,
            actual_executor_id=actual_executor_id,
            matched_executor_rule_id=matched_executor_rule_id,
            executor_selection_reason=executor_selection_reason,
            executor_fallback_reason=executor_fallback_reason,
            executor_blocked_reason=executor_blocked_reason,
            worker_id=worker_id,
            worker_label=worker_label,
            worker_occupation_emoji=worker_occupation_emoji,
            worker_status=worker_status,
            token_usage_json=evidence_json.get('token_usage'),
            worker_runtime_json=evidence_json.get('worker_runtime'),
            terminal_at=terminal_at,
            updated_at=now,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='task revision is stale or participant is invalid',
            )
        if not records[0]['same_payload']:
            raise HTTPException(
                status_code=409,
                detail='task event idempotency key was used with different input',
            )
        if not records[0].get('applied_transition'):
            return await self.get_project_agent_task(
                actor,
                request.personal_space_id,
                request.task_id,
            )
        if actual_report:
            # This is the sole owner of actual projection fields: an older
            # activity observation must not partially overwrite a newer run.
            await actual_recorder(actor, actual_report)
        evidence_status = (
            request.status
            if request.status in TERMINAL_TASK_STATUSES
            else worker_status
        )
        if (
            evidence_status in TERMINAL_TASK_STATUSES
            and actual_executor_id
            and request.agent_id
        ):
            evidence_recorder = getattr(
                self,
                'record_project_agent_executor_outcome_evidence',
                None,
            )
            if callable(evidence_recorder):
                strategy = (
                    ProjectAgentModelStrategy.model_validate_json(
                        raw_task['effective_model_strategy_json']
                    )
                    if raw_task.get('effective_model_strategy_json')
                    else ProjectAgentModelStrategy()
                )
                await evidence_recorder(
                    actor,
                    ProjectAgentExecutorOutcomeEvidenceCreate(
                        personal_space_id=request.personal_space_id,
                        personal_project_id=request.personal_project_id,
                        work_kind=raw_task['work_kind'],
                        agent_id=request.agent_id,
                        executor_id=actual_executor_id,
                        task_id=request.task_id,
                        run_id=event_id,
                        model_strategy=strategy,
                        evidence_kind='terminal_outcome',
                        source='system_terminal',
                        terminal_outcome=evidence_status,
                        reference_ids=[event_id],
                        idempotency_key=f'terminal:{event_id}',
                        occurred_at=now,
                    ),
                )
        await self._archive_finished_temporary_agent(request, raw_task, now)
        return await self.get_project_agent_task(
            actor,
            request.personal_space_id,
            request.task_id,
        )
