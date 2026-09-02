import json
from collections import defaultdict
from datetime import date
from fastapi import HTTPException
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .project_agent_models import ProjectAgentModelStrategy, ProjectAgentProfile
from .project_agent_task_models import (
    ProjectAgentActivityDay,
    ProjectAgentActivityResult,
    ProjectAgentActivityTask,
    ProjectAgentRoutingDecisionRecord,
    ProjectAgentTaskRecord,
    ProjectAgentTaskRouteResult,
    ProjectAgentTaskSubmit,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_project_agents import SYSTEM_COORDINATOR_AGENT_ID
from .store_project_agent_task_reads import StoreProjectAgentTaskReads
from .store_project_agent_task_persistence import StoreProjectAgentTaskPersistence
from .store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
from .store_project_agent_task_staffing import StoreProjectAgentTaskStaffing
from .store_project_agent_coordination_policy import StoreProjectAgentCoordinationPolicy
from .store_project_agent_task_activity import StoreProjectAgentTaskActivity, TERMINAL_TASK_STATUSES
from .store_transactions import TransactionQueryDriver, query_store_transaction
class StoreProjectAgentTasks(
    StoreProjectAgentTaskActivity,
    StoreProjectAgentCoordinationPolicy,
    StoreProjectAgentTaskRecruitment,
    StoreProjectAgentTaskReads,
    StoreProjectAgentTaskPersistence,
    StoreProjectAgentTaskStaffing,
):
    """Durable task, routing, recruitment, and verified activity control plane.

    Clients append real state events; this control plane does not run workers.
    """
    async def submit_project_agent_task(
        self,
        actor: dict,
        request: ProjectAgentTaskSubmit,
    ) -> ProjectAgentTaskRouteResult:
        if not isinstance(self.runtime.driver, TransactionQueryDriver):
            async with query_store_transaction(self) as scoped:
                return await scoped.submit_project_agent_task(actor, request)
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
            await self._repair_task_persistence(request, raw)
            existing = await self._find_task_row(
                request.personal_space_id,
                task_id,
            )
            task = self._task_from_row(existing)
            recruitments = await self._task_recruitments(
                request.personal_space_id,
                task.task_id,
            )
            if await self._recover_recruitment_lifecycle(
                actor,
                request,
                task,
                recruitments,
            ):
                existing = await self._find_task_row(
                    request.personal_space_id,
                    task_id,
                )
                task = self._task_from_row(existing)
                recruitments = await self._task_recruitments(
                    request.personal_space_id,
                    task.task_id,
                )
            recruitment = recruitments[0] if recruitments else None
            assigned_agent = await self._route_assigned_agent(
                actor,
                request,
                task,
            )
            return self._route_result(
                task,
                recruitment,
                assigned_agent=assigned_agent,
                recruitments=recruitments,
            )

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

        parallel_recruitment_slots = (
            await self._automatic_parallel_recruitment_slots(
                actor,
                request,
                lead=lead,
                participants=participants,
                routing_reason=reason,
            )
        )
        projected_participants = await self._parallel_plan_participant_projection(
            actor,
            request,
            lead=lead,
            participants=participants,
            routing_reason=reason,
            recruitment_slots=parallel_recruitment_slots,
        )
        self._verify_parallel_plan(request.parallel_plan, projected_participants)

        will_open_recruitment = (
            request.staffing_intent != 'unassigned'
            and reason != 'manual_agent_selection'
            and (
                bool(parallel_recruitment_slots) or not lead
                or request.staffing_intent in {'new_durable', 'temporary'}
            )
        )
        if will_open_recruitment:
            _, recruitment_profile = self._normalized_recruitment_profile(request)
            self._require_agent_client_allowed(
                recruitment_profile,
                request.source_application,
            )

        coordinator = await self.ensure_system_project_coordinator(
            actor,
            request.personal_space_id,
        )
        coordinator_agent_id = request.coordinator_agent_id or coordinator.agent_id

        model_strategy, model_source = self._effective_model_strategy(
            request,
            lead,
            coordinator.profile.default_model_strategy,
        )
        recruitment = None
        recruitments = []
        routing_outcome = 'assigned_existing' if lead else 'unassigned'
        task_status = 'queued' if lead else 'blocked'
        if request.staffing_intent == 'unassigned':
            reason = 'explicit_unassigned'
            routing_outcome = 'unassigned'
            task_status = 'blocked'
        elif reason == 'manual_agent_selection':
            routing_outcome = 'unassigned'
            task_status = 'blocked'
        elif parallel_recruitment_slots:
            recruited_count = 0
            recruited_lead = False
            for slot in parallel_recruitment_slots:
                slot_recruitment, recruited = await self._open_recruitment(
                    actor,
                    space,
                    request,
                    task_id,
                    coordinator_agent_id,
                    reason,
                    participant_role=slot['participant_role'],
                    recruitment_slot=slot['recruitment_slot'],
                )
                if slot_recruitment:
                    recruitments.append(slot_recruitment)
                    if slot['participant_role'] == 'lead':
                        recruitment = slot_recruitment
                if not recruited:
                    continue

                recruited_count += 1
                participant = {
                    'agent_id': recruited['agent_id'],
                    'role': slot['participant_role'],
                    'assignment_summary': recruited.get('responsibility'),
                }
                if not any(
                    item['agent_id'] == recruited['agent_id']
                    for item in participants
                ):
                    if slot['participant_role'] == 'lead':
                        participants.insert(0, participant)
                    else:
                        participants.append(participant)
                if slot['participant_role'] == 'lead':
                    lead = recruited
                    recruited_lead = True

            if recruitment is None and recruitments:
                recruitment = recruitments[0]
            if recruited_count == len(parallel_recruitment_slots):
                routing_outcome = 'recruited'
                task_status = 'queued'
                match_basis = [
                    *match_basis,
                    'parallel automatic recruitment: filled '
                    f'{recruited_count} missing participant slot(s)',
                    'HR recruitment recorded before Agent creation',
                ]
                if recruited_lead:
                    model_strategy, model_source = self._effective_model_strategy(
                        request,
                        lead,
                        coordinator.profile.default_model_strategy,
                    )
            elif any(
                item.status == 'awaiting_confirmation'
                for item in recruitments
            ):
                routing_outcome = 'recruitment_required'
                task_status = 'awaiting_recruitment'
            else:
                routing_outcome = 'blocked'
                task_status = 'blocked'
                reason = 'hr_unavailable'
        elif not lead or request.staffing_intent in {'new_durable', 'temporary'}:
            recruitment, recruited = await self._open_recruitment(
                actor,
                space,
                request,
                task_id,
                coordinator_agent_id,
                reason,
            )
            if recruitment:
                recruitments.append(recruitment)
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
            recruitments=recruitments,
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
            recruitments=recruitments,
        )

    async def get_project_agent_task(
        self,
        actor: dict,
        personal_space_id: str,
        task_id: str,
        *,
        personal_project_id: str | None = None,
    ) -> ProjectAgentTaskRecord:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                personal_project_id,
            )
        row = await self._find_task_row(
            personal_space_id,
            task_id,
            personal_project_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail='project Agent task not found')
        task = dict(row['task'])
        if not personal_project_id:
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

    async def get_project_agent_activity(
        self,
        actor: dict,
        personal_space_id: str,
        agent_id: str,
        from_date: date,
        to_date: date,
        *,
        personal_project_id: str | None = None,
    ) -> ProjectAgentActivityResult:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                personal_project_id,
            )
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
              AND ($personal_project_id IS NULL
                   OR task.personal_project_id = $personal_project_id)
              AND event.activity_date >= date($from_date)
              AND event.activity_date <= date($to_date)
            WITH task, event, agent
            OPTIONAL MATCH (task)-[:HAS_TASK_EVENT]->(evidence_event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)
            WHERE evidence_event.created_at <= event.created_at
            RETURN event, task.title AS title, collect(evidence_event) AS evidence_events
            ORDER BY event.created_at DESC, event.event_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            from_date=from_date.isoformat(),
            to_date=to_date.isoformat(),
            routing_='r',
        )
        grouped = defaultdict(list)
        for row in records:
            event = self._event_with_latest_execution_evidence(
                row['event'], row.get('evidence_events') or []
            )
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
            required_capabilities=request.executor_capability_hints,
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

    async def _persist_task(self, request, **values):
        # The task must not become visible before all of its planned edges exist.
        async with self.runtime.driver.transaction() as transaction:
            await self._persist_task_transaction(request, transaction, **values)

    async def _persist_task_transaction(
        self,
        request,
        transaction,
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
        recruitments=None,
    ):
        linked_recruitments = list(recruitments or [])
        if recruitment and not any(
            item.recruitment_id == recruitment.recruitment_id
            for item in linked_recruitments
        ):
            linked_recruitments.insert(0, recruitment)
        recruitment_links = [
            {
                'recruitment_id': item.recruitment_id,
                'is_primary': bool(
                    recruitment
                    and item.recruitment_id == recruitment.recruitment_id
                ),
            }
            for item in linked_recruitments
        ]
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
        result = await transaction.run(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MATCH (space)-[:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (coordinator:FuliProjectAgent {agent_id: $coordinator_agent_id})
            MERGE (task:FuliProjectAgentTask {id: $task_id})
            ON CREATE SET task += {
              task_id: $task_id,
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              payload_hash: $payload_hash,
              title: $title,
              objective: $objective,
              work_kind: $work_kind,
              required_capabilities: $required_capabilities,
              executor_capability_hints: $executor_capability_hints,
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
              participant_plan_json: $participant_plan_json,
              recruitment_plan_json: $recruitment_plan_json,
              created_at: $created_at,
              updated_at: $created_at
            }
            WITH space, project, coordinator, task
            WHERE task.payload_hash = $payload_hash
            MERGE (decision_node:FuliProjectAgentRoutingDecision {
              id: $decision_id
            })
            ON CREATE SET decision_node.decision_id = $decision_id,
                          decision_node.task_id = $task_id,
                          decision_node.decision_json = $decision_json,
                          decision_node.created_at = $created_at
            MERGE (event:FuliProjectAgentTaskEvent {id: $initial_event_id})
            ON CREATE SET event.event_id = $initial_event_id,
                          event.task_id = $task_id,
                          event.status = $status,
                          event.actor_kind = 'system',
                          event.summary = $routing_explanation,
                          event.source_application = $source_application,
                          event.source_session_id = $source_session_id,
                          event.created_at = $created_at
            MERGE (space)-[:HAS_PROJECT_AGENT_TASK]->(task)
            MERGE (project)-[:HAS_PROJECT_AGENT_TASK]->(task)
            MERGE (task)-[:COORDINATED_BY]->(coordinator)
            MERGE (task)-[:ROUTED_BY]->(decision_node)
            MERGE (task)-[:HAS_TASK_EVENT]->(event)
            RETURN true AS payload_matches,
                   task.participant_plan_json AS participant_plan_json,
                   task.recruitment_plan_json AS recruitment_plan_json,
                   task.status AS persisted_status,
                   task.created_at AS persisted_created_at
            ''',
            task_id=task_id,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            payload_hash=payload_hash,
            title=request.title,
            objective=request.objective,
            work_kind=request.work_kind,
            required_capabilities=request.required_capabilities,
            executor_capability_hints=request.executor_capability_hints,
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
            participant_plan_json=json.dumps(participants, sort_keys=True),
            recruitment_plan_json=json.dumps(recruitment_links, sort_keys=True),
            created_at=created_at,
            decision_id=decision.decision_id,
            decision_json=json.dumps(decision_raw, sort_keys=True),
            initial_event_id=initial_event_id,
        )
        records = [record async for record in result]
        if not records or not dict(records[0]).get('payload_matches'):
            raise HTTPException(
                status_code=409,
                detail='task idempotency key was used with different input',
            )
        persisted = dict(records[0])
        await self._persist_task_links(
            request,
            transaction=transaction,
            task_id=task_id,
            participants=self._task_link_plan(
                persisted.get('participant_plan_json')
            ),
            recruitment_links=self._task_link_plan(
                persisted.get('recruitment_plan_json')
            ),
            status=persisted.get('persisted_status') or status,
            created_at=persisted.get('persisted_created_at') or created_at,
        )
