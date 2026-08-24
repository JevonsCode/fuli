import json
from collections import defaultdict
from datetime import date

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .project_agent_executor_models import (
    ProjectAgentExecutorActualReport,
    ProjectAgentExecutorOutcomeEvidenceCreate,
)
from .project_agent_models import (
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
)
from .project_agent_task_models import (
    ProjectAgentActivityDay,
    ProjectAgentActivityResult,
    ProjectAgentActivityTask,
    ProjectAgentRoutingDecisionRecord,
    ProjectAgentTaskActivityCreate,
    ProjectAgentTaskRecord,
    ProjectAgentTaskRouteResult,
    ProjectAgentTaskSubmit,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_project_agents import SYSTEM_COORDINATOR_AGENT_ID
from .store_project_agent_task_reads import StoreProjectAgentTaskReads
from .store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
from .store_project_agent_task_staffing import StoreProjectAgentTaskStaffing
from .store_project_agent_coordination_policy import (
    StoreProjectAgentCoordinationPolicy,
)


TERMINAL_TASK_STATUSES = {'completed', 'failed', 'cancelled'}


class StoreProjectAgentTasks(
    StoreProjectAgentCoordinationPolicy,
    StoreProjectAgentTaskRecruitment,
    StoreProjectAgentTaskReads,
    # Keep the pre-existing base order ahead of the extracted implementation.
    StoreProjectAgentTaskStaffing,
):
    """Durable task, routing, recruitment, and verified activity control plane.

    This is deliberately not a worker or scheduler. Registered clients submit
    tasks and append truthful state events to the same persistent Agent/task
    history. No task is shown as running until a client records that event.
    """

    async def submit_project_agent_task(
        self,
        actor: dict,
        request: ProjectAgentTaskSubmit,
    ) -> ProjectAgentTaskRouteResult:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        task_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-task',
            request.idempotency_key,
        )
        payload_hash = self._payload_hash(request)
        existing = await self._find_task_row(request.personal_space_id, task_id)
        if existing:
            raw = dict(existing['task'])
            if raw.get('payload_hash') != payload_hash:
                raise HTTPException(
                    status_code=409,
                    detail='task idempotency key was used with different input',
                )
            task = self._task_from_row(existing)
            recruitment = await self._task_recruitment(
                request.personal_space_id,
                task.task_id,
            )
            assigned_agent = await self._route_assigned_agent(
                actor,
                request,
                task,
            )
            return self._route_result(
                task,
                recruitment,
                assigned_agent=assigned_agent,
            )

        coordinator = await self.ensure_system_project_coordinator(
            actor,
            request.personal_space_id,
        )
        coordinator_agent_id = request.coordinator_agent_id or coordinator.agent_id
        if request.coordinator_agent_id:
            await authorize_project_agent(
                self,
                actor,
                space,
                request.personal_project_id,
                request.coordinator_agent_id,
                require_active=True,
                allow_unassigned=True,
            )

        complexity, complexity_basis = self._assess_complexity(request)
        selected, candidates, reason, match_basis = await self._select_agents(
            actor,
            space,
            request,
        )
        lead = selected[0] if selected else None
        participants = []
        if lead:
            participants.append({
                'agent_id': lead['agent_id'],
                'role': 'lead',
                'assignment_summary': lead.get('responsibility'),
            })
        for collaborator in await self._explicit_collaborators(actor, space, request):
            if not any(item['agent_id'] == collaborator['agent_id'] for item in participants):
                participants.append({
                    'agent_id': collaborator['agent_id'],
                    'role': 'collaborator',
                    'assignment_summary': collaborator.get('responsibility'),
                })
        parallel_candidates = []
        auto_collaborators = []
        if (
            request.parallel_plan.enabled
            and request.staffing_intent != 'unassigned'
        ):
            parallel_candidates = await self._parallel_staffing_candidates(
                request,
                candidates,
                participants,
            )
            candidate_ids = {item['agent_id'] for item in candidates}
            candidates.extend(
                item
                for item in parallel_candidates
                if item['agent_id'] not in candidate_ids
            )
            auto_collaborators = self._add_parallel_collaborators(
                request.parallel_plan,
                participants,
                parallel_candidates,
            )
            if auto_collaborators:
                match_basis = list(match_basis)
                match_basis.append(
                    'parallel auto-staffing: added '
                    f'{len(auto_collaborators)} collaborator(s) from '
                    'qualified durable Agent candidates'
                )

        model_strategy, model_source = self._effective_model_strategy(
            request,
            lead,
            coordinator.profile.default_model_strategy,
        )
        recruitment = None
        routing_outcome = 'assigned_existing' if lead else 'unassigned'
        task_status = 'queued' if lead else 'blocked'
        if request.staffing_intent == 'unassigned':
            reason = 'explicit_unassigned'
            routing_outcome = 'unassigned'
            task_status = 'blocked'
        elif reason == 'manual_agent_selection':
            routing_outcome = 'unassigned'
            task_status = 'blocked'
        elif not lead or request.staffing_intent in {'new_durable', 'temporary'}:
            recruitment, recruited = await self._open_recruitment(
                actor,
                space,
                request,
                task_id,
                coordinator_agent_id,
                reason,
            )
            if recruited:
                lead = recruited
                if not any(
                    item['agent_id'] == recruited['agent_id']
                    for item in participants
                ):
                    participants.insert(0, {
                        'agent_id': recruited['agent_id'],
                        'role': 'lead',
                        'assignment_summary': recruited.get('responsibility'),
                    })
                routing_outcome = 'recruited'
                task_status = 'queued'
                reason = (
                    'explicit_temporary_agent'
                    if request.staffing_intent == 'temporary'
                    else 'explicit_new_agent'
                    if request.staffing_intent == 'new_durable'
                    else 'no_match'
                )
                match_basis = [
                    'HR recruitment recorded before Agent creation',
                    *(
                        [
                            'parallel auto-staffing: added '
                            f'{len(auto_collaborators)} collaborator(s) from '
                            'qualified durable Agent candidates'
                        ]
                        if auto_collaborators
                        else []
                    ),
                ]
                model_strategy, model_source = self._effective_model_strategy(
                    request,
                    recruited,
                    coordinator.profile.default_model_strategy,
                )
            elif recruitment and recruitment.status == 'awaiting_confirmation':
                routing_outcome = 'recruitment_required'
                task_status = 'awaiting_recruitment'
            else:
                routing_outcome = 'blocked'
                task_status = 'blocked'
                reason = 'hr_unavailable'
        self._verify_parallel_plan(request.parallel_plan, participants)

        executor_decision = await self._resolve_executor_if_available(
            actor,
            request,
            lead,
            model_strategy,
            model_source,
            task_id,
        )
        if lead and executor_decision and self._executor_decision_blocked(executor_decision):
            routing_outcome = 'blocked'
            task_status = 'blocked'

        decision_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-routing-decision',
            task_id,
        )
        now = now_utc()
        decision = ProjectAgentRoutingDecisionRecord(
            decision_id=decision_id,
            task_id=task_id,
            coordinator_agent_id=coordinator_agent_id,
            complexity=complexity,
            complexity_basis=complexity_basis,
            selected_model_strategy=model_strategy,
            model_strategy_source=model_source,
            outcome=routing_outcome,
            reason=reason,
            match_basis=match_basis,
            candidate_agent_ids=[item['agent_id'] for item in candidates],
            parallel_plan=request.parallel_plan,
            created_at=now,
            **self._decision_executor_fields(executor_decision),
        )
        routing_explanation = self._routing_explanation(
            reason,
            match_basis,
            executor_decision,
        )
        await self._persist_task(
            request,
            task_id=task_id,
            payload_hash=payload_hash,
            coordinator_agent_id=coordinator_agent_id,
            lead_agent_id=lead['agent_id'] if lead else None,
            status=task_status,
            routing_outcome=routing_outcome,
            routing_reason=reason,
            routing_explanation=routing_explanation,
            match_basis=match_basis,
            complexity=complexity,
            complexity_basis=complexity_basis,
            model_strategy=model_strategy,
            model_source=model_source,
            participants=participants,
            decision=decision,
            recruitment=recruitment,
            executor_decision=executor_decision,
            created_at=now,
        )
        task = await self.get_project_agent_task(
            actor,
            request.personal_space_id,
            task_id,
        )
        assigned_agent = await self._route_assigned_agent(
            actor,
            request,
            task,
        )
        return self._route_result(
            task,
            recruitment,
            assigned_agent=assigned_agent,
        )

    async def get_project_agent_task(
        self,
        actor: dict,
        personal_space_id: str,
        task_id: str,
    ) -> ProjectAgentTaskRecord:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        row = await self._find_task_row(personal_space_id, task_id)
        if not row:
            raise HTTPException(status_code=404, detail='project Agent task not found')
        task = dict(row['task'])
        await authorize_personal_project(
            self,
            actor,
            space,
            task['personal_project_id'],
        )
        return self._task_from_row(row)

    async def list_project_agent_tasks(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        personal_project_id: str | None = None,
        agent_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[ProjectAgentTaskRecord]:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                personal_project_id,
            )
        records, _, _ = await self.runtime.driver.execute_query(
            self._task_read_query(
                '''
                WHERE ($personal_project_id IS NULL
                       OR task.personal_project_id = $personal_project_id)
                  AND ($status IS NULL OR task.status = $status)
                  AND ($agent_id IS NULL OR EXISTS {
                    MATCH (task)-[:HAS_PARTICIPANT]->
                          (:FuliProjectAgent {agent_id: $agent_id})
                  })
                '''
            ) + '\nORDER BY task.updated_at DESC, task.task_id LIMIT $limit',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            status=status,
            limit=limit,
            routing_='r',
        )
        return [self._task_from_row(row) for row in records]

    async def record_project_agent_task_activity(
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
            expected_revision = raw_task.get('revision', 0)
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
                self._require_agent_client_allowed(
                    {
                        'agent_id': request.agent_id,
                        'profile': ProjectAgentProfile.model_validate_json(
                            participant['profile_json']
                        ),
                    },
                    request.source_application,
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
        worker_occupation_emoji = getattr(
            request,
            'worker_occupation_emoji',
            None,
        )
        worker_status = getattr(request, 'worker_status', None)
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
            WHERE task.revision = $expected_revision
               OR EXISTS {
                 MATCH (task)-[:HAS_TASK_EVENT]->
                       (:FuliProjectAgentTaskEvent {id: $event_id})
               }
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            WHERE $agent_id IS NULL OR EXISTS {
              MATCH (task)-[:HAS_PARTICIPANT]->(agent)
            }
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
                          event.activity_date = CASE
                            WHEN $terminal_at IS NULL THEN null
                            ELSE date($terminal_at) END,
                          event.created_at = $updated_at
            WITH task, event, agent,
                 event.payload_hash = $payload_hash AS same_payload,
                 task.revision = $expected_revision AS applied_transition
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
                  task.actual_executor_id = coalesce(
                    $actual_executor_id, task.actual_executor_id),
                  task.actual_model_provider = coalesce(
                    $actual_model_provider, task.actual_model_provider),
                  task.actual_model = coalesce($actual_model, task.actual_model),
                  task.matched_executor_rule_id = coalesce(
                    $matched_executor_rule_id,
                    task.matched_executor_rule_id),
                  task.executor_selection_reason = coalesce(
                    $executor_selection_reason,
                    task.executor_selection_reason),
                  task.executor_fallback_reason = coalesce(
                    $executor_fallback_reason,
                    task.executor_fallback_reason),
                  task.executor_blocked_reason = coalesce(
                    $executor_blocked_reason,
                    task.executor_blocked_reason),
                  task.completed_at = $terminal_at,
                  task.updated_at = $updated_at,
                  task.revision = task.revision + 1
            )
            FOREACH (_ IN CASE
              WHEN same_payload AND applied_transition AND agent IS NOT NULL
              THEN [1] ELSE [] END |
              SET task.lead_agent_id = CASE
                WHEN task.lead_agent_id IS NULL AND $status = 'running'
                THEN agent.agent_id ELSE task.lead_agent_id END
            )
            WITH task, event, same_payload, applied_transition
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
            actor_kind=request.actor_kind,
            summary=request.summary,
            payload_hash=payload_hash,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
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

    async def get_project_agent_activity(
        self,
        actor: dict,
        personal_space_id: str,
        agent_id: str,
        from_date: date,
        to_date: date,
    ) -> ProjectAgentActivityResult:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        if from_date > to_date:
            raise HTTPException(status_code=422, detail='from date must not exceed to date')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask)-[:HAS_TASK_EVENT]->
                  (event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)
            WHERE event.status IN ['completed', 'failed', 'cancelled']
              AND event.activity_date >= date($from_date)
              AND event.activity_date <= date($to_date)
            RETURN event, task.title AS title
            ORDER BY event.created_at DESC, event.event_id
            ''',
            personal_space_id=personal_space_id,
            agent_id=agent_id,
            from_date=from_date.isoformat(),
            to_date=to_date.isoformat(),
            routing_='r',
        )
        grouped = defaultdict(list)
        for row in records:
            event = dict(row['event'])
            occurred_at = native_datetime(event['created_at'])
            grouped[occurred_at.date()].append(ProjectAgentActivityTask(
                task_id=event['task_id'],
                title=row['title'],
                status=event['status'],
                summary=event['summary'],
                occurred_at=occurred_at,
                source_application=event.get('source_application'),
                actual_model_provider=event.get('actual_model_provider'),
                actual_model=event.get('actual_model'),
                **self._activity_executor_fields(event),
            ))
        days = []
        for activity_date in sorted(grouped):
            tasks = grouped[activity_date]
            counts = {
                status: sum(item.status == status for item in tasks)
                for status in TERMINAL_TASK_STATUSES
            }
            days.append(ProjectAgentActivityDay(
                date=activity_date,
                completed=counts['completed'],
                failed=counts['failed'],
                cancelled=counts['cancelled'],
                total=len(tasks),
                tasks=tasks,
            ))
        return ProjectAgentActivityResult(
            agent_id=agent_id,
            personal_space_id=personal_space_id,
            from_date=from_date,
            to_date=to_date,
            days=days,
        )

    async def _route_assigned_agent(self, actor, request, task):
        """Project the selected durable identity into the route response."""

        agent_id = getattr(task, 'lead_agent_id', None)
        getter = getattr(self, 'get_project_agent', None)
        if not agent_id or not callable(getter):
            return None
        try:
            return await getter(
                actor,
                request.personal_space_id,
                request.personal_project_id,
                agent_id,
            )
        except HTTPException as exc:
            # A task remains readable if an Agent was archived immediately
            # after persistence; the selected identity is then unavailable.
            if exc.status_code == 404:
                return None
            raise

    @staticmethod
    def _validate_task_transition(current, requested, *, has_actual_executor=False):
        if not current:
            return
        if current in TERMINAL_TASK_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=f'illegal project Agent task transition: {current} -> {requested}',
            )
        if current == requested:
            return
        allowed = {
            'awaiting_recruitment': {'blocked', 'cancelled'},
            'queued': {'running', 'paused', 'blocked', 'failed', 'cancelled'},
            'running': {
                'paused', 'blocked', 'awaiting_review',
                'completed', 'failed', 'cancelled',
            },
            'paused': {'running', 'blocked', 'failed', 'cancelled'},
            'awaiting_review': {'running', 'completed', 'failed', 'cancelled'},
            'blocked': {'cancelled', 'failed'},
            'completed': set(),
            'failed': set(),
            'cancelled': set(),
        }
        if current == 'blocked' and has_actual_executor:
            allowed['blocked'] = {'queued', 'running', 'cancelled', 'failed'}
        if requested not in allowed.get(current, set()):
            raise HTTPException(
                status_code=409,
                detail=f'illegal project Agent task transition: {current} -> {requested}',
            )

    @staticmethod
    def _assess_complexity(request):
        if request.complexity_hint:
            return request.complexity_hint, ['explicit task complexity hint']
        basis = []
        points = 0
        if len(request.objective) > 1200:
            points += 2
            basis.append('long objective')
        elif len(request.objective) > 400:
            points += 1
            basis.append('multi-part objective')
        if len(request.required_capabilities) >= 4:
            points += 2
            basis.append('four or more required capabilities')
        elif len(request.required_capabilities) >= 2:
            points += 1
            basis.append('multiple required capabilities')
        if request.parallel_plan.enabled:
            points += 2
            basis.append('verified parallel work requested')
        if points >= 4:
            return 'complex', basis or ['complex task shape']
        if points >= 2:
            return 'standard', basis or ['standard task shape']
        return 'simple', basis or ['bounded task shape']

    @staticmethod
    def _effective_model_strategy(request, selected, coordinator_strategy):
        if request.model_strategy_override:
            return request.model_strategy_override, 'task'
        if selected and selected.get('model_strategy_override'):
            value = selected['model_strategy_override']
            return (
                value
                if isinstance(value, ProjectAgentModelStrategy)
                else ProjectAgentModelStrategy.model_validate_json(value),
                'assignment',
            )
        if selected and selected.get('profile'):
            return selected['profile'].default_model_strategy, 'agent'
        return coordinator_strategy, 'coordinator'

    async def _resolve_executor_if_available(
        self,
        actor,
        request,
        selected,
        model_strategy,
        model_strategy_source,
        task_id,
    ):
        resolver = getattr(self, 'resolve_project_agent_executor', None)
        if not callable(resolver) or not selected:
            return None
        return await resolver(
            actor,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            task_id=task_id,
            agent_id=selected['agent_id'],
            work_kind=request.work_kind,
            required_capabilities=request.required_capabilities,
            model_strategy=model_strategy,
            task_override=(
                getattr(request, 'executor_policy_override', None)
                or getattr(request, 'executor_override', None)
            ),
            assignment_id=selected.get('assignment_id'),
            model_strategy_source=model_strategy_source,
        )

    @staticmethod
    def _executor_decision_blocked(decision):
        value = decision.model_dump(mode='json') if hasattr(decision, 'model_dump') else decision
        return value.get('outcome') == 'blocked' or value.get('status') == 'blocked'

    @staticmethod
    def _decision_executor_fields(decision):
        if not decision:
            return {}
        raw = decision.model_dump(mode='json') if hasattr(decision, 'model_dump') else dict(decision)
        aliases = {
            # The routing decision audit field is JSON data.  Keep the
            # provider-neutral snapshot instead of leaking a Pydantic model
            # into the parent record (which fails validation in real routing).
            'executor_decision': raw,
            'selected_executor_id': raw.get('selected_executor_id') or raw.get('executor_id'),
            'matched_executor_rule_id': raw.get('matched_rule_id') or raw.get('rule_id'),
            'executor_selection_reason': raw.get('selection_reason') or raw.get('reason'),
            'executor_fallback_outcome': raw.get('fallback_outcome'),
            'executor_policy': raw.get('executor_policy'),
        }
        return {
            key: value
            for key, value in aliases.items()
            if key in ProjectAgentRoutingDecisionRecord.model_fields
        }

    @staticmethod
    def _activity_executor_fields(event):
        return {
            key: value
            for key, value in {
                'actual_executor_id': event.get('actual_executor_id'),
                'matched_executor_rule_id': event.get('matched_executor_rule_id'),
                'worker_id': event.get('worker_id'),
                'worker_label': event.get('worker_label'),
                'worker_occupation_emoji': event.get(
                    'worker_occupation_emoji'
                ),
                'worker_status': event.get('worker_status'),
            }.items()
            if key in ProjectAgentActivityTask.model_fields
        }

    async def _persist_task(
        self,
        request,
        *,
        task_id,
        payload_hash,
        coordinator_agent_id,
        lead_agent_id,
        status,
        routing_outcome,
        routing_reason,
        routing_explanation,
        match_basis,
        complexity,
        complexity_basis,
        model_strategy,
        model_source,
        participants,
        decision,
        recruitment,
        executor_decision,
        created_at,
    ):
        decision_raw = decision.model_dump(mode='json')
        executor_raw = (
            executor_decision.model_dump(mode='json')
            if hasattr(executor_decision, 'model_dump')
            else executor_decision
        )
        initial_event_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-task-event',
            task_id,
            'created',
        )
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MATCH (space)-[:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (coordinator:FuliProjectAgent {agent_id: $coordinator_agent_id})
            CREATE (task:FuliProjectAgentTask {
              id: $task_id,
              task_id: $task_id,
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              payload_hash: $payload_hash,
              title: $title,
              objective: $objective,
              work_kind: $work_kind,
              required_capabilities: $required_capabilities,
              duration: $duration,
              staffing_intent: $staffing_intent,
              status: $status,
              revision: 0,
              routing_outcome: $routing_outcome,
              routing_reason: $routing_reason,
              routing_explanation: $routing_explanation,
              match_basis: $match_basis,
              coordinator_agent_id: $coordinator_agent_id,
              lead_agent_id: $lead_agent_id,
              complexity: $complexity,
              complexity_basis: $complexity_basis,
              effective_model_strategy_json: $model_strategy_json,
              task_model_strategy_override_json:
                $task_model_strategy_override_json,
              task_executor_policy_override_json:
                $task_executor_policy_override_json,
              model_strategy_source: $model_source,
              source_application: $source_application,
              source_session_id: $source_session_id,
              executor_decision_json: $executor_decision_json,
              executor_policy_json: $executor_policy_json,
              selected_executor_id: $selected_executor_id,
              created_at: $created_at,
              updated_at: $created_at
            })
            CREATE (decision_node:FuliProjectAgentRoutingDecision {
              id: $decision_id,
              decision_id: $decision_id,
              task_id: $task_id,
              decision_json: $decision_json,
              created_at: $created_at
            })
            CREATE (event:FuliProjectAgentTaskEvent {
              id: $initial_event_id,
              event_id: $initial_event_id,
              task_id: $task_id,
              status: $status,
              actor_kind: 'system',
              summary: $routing_explanation,
              source_application: $source_application,
              source_session_id: $source_session_id,
              created_at: $created_at
            })
            MERGE (space)-[:HAS_PROJECT_AGENT_TASK]->(task)
            MERGE (project)-[:HAS_PROJECT_AGENT_TASK]->(task)
            MERGE (task)-[:COORDINATED_BY]->(coordinator)
            MERGE (task)-[:ROUTED_BY]->(decision_node)
            MERGE (task)-[:HAS_TASK_EVENT]->(event)
            ''',
            task_id=task_id,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            payload_hash=payload_hash,
            title=request.title,
            objective=request.objective,
            work_kind=request.work_kind,
            required_capabilities=request.required_capabilities,
            duration=request.duration,
            staffing_intent=request.staffing_intent,
            status=status,
            routing_outcome=routing_outcome,
            routing_reason=routing_reason,
            routing_explanation=routing_explanation,
            match_basis=match_basis,
            coordinator_agent_id=coordinator_agent_id,
            lead_agent_id=lead_agent_id,
            complexity=complexity,
            complexity_basis=complexity_basis,
            model_strategy_json=model_strategy.model_dump_json() if model_strategy else None,
            task_model_strategy_override_json=(
                request.model_strategy_override.model_dump_json()
                if request.model_strategy_override else None
            ),
            task_executor_policy_override_json=(
                (
                    request.executor_policy_override
                    or request.executor_override
                ).model_dump_json()
                if request.executor_policy_override or request.executor_override
                else None
            ),
            model_source=model_source,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            executor_decision_json=(
                json.dumps(executor_raw, sort_keys=True) if executor_raw else None
            ),
            executor_policy_json=(
                json.dumps((executor_raw or {}).get('executor_policy'), sort_keys=True)
                if (executor_raw or {}).get('executor_policy') else None
            ),
            selected_executor_id=(
                (executor_raw or {}).get('selected_executor_id')
                or (executor_raw or {}).get('executor_id')
            ),
            created_at=created_at,
            decision_id=decision.decision_id,
            decision_json=json.dumps(decision_raw, sort_keys=True),
            initial_event_id=initial_event_id,
        )
        for participant in participants:
            await self.runtime.driver.execute_query(
                '''
                MATCH (space:FuliSpace {
                  id: $personal_space_id, kind: 'personal'
                })-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {task_id: $task_id})
                MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                      (agent:FuliProjectAgent {agent_id: $agent_id})
                MERGE (task)-[participant:HAS_PARTICIPANT]->(agent)
                SET participant.role = $role,
                    participant.status = $status,
                    participant.assignment_summary = $assignment_summary,
                    participant.joined_at = $created_at,
                    participant.updated_at = $created_at
                ''',
                personal_space_id=request.personal_space_id,
                task_id=task_id,
                agent_id=participant['agent_id'],
                role=participant['role'],
                status=status,
                assignment_summary=participant.get('assignment_summary'),
                created_at=created_at,
            )
        if recruitment:
            await self.runtime.driver.execute_query(
                '''
                MATCH (space:FuliSpace {
                  id: $personal_space_id, kind: 'personal'
                })-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {task_id: $task_id})
                MATCH (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                      (recruitment:FuliProjectAgentRecruitment {
                        recruitment_id: $recruitment_id
                      })
                SET task.recruitment_id = $recruitment_id,
                    task.hr_agent_id = recruitment.hr_agent_id
                MERGE (task)-[:TRIGGERED_RECRUITMENT]->(recruitment)
                ''',
                personal_space_id=request.personal_space_id,
                task_id=task_id,
                recruitment_id=recruitment.recruitment_id,
            )
