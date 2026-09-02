"""Recruitment policy, decisions, provisioning, and audit reads for Agent tasks."""

from __future__ import annotations

import json
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_models import (
    ProjectAgentAssignmentCreate,
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
    ProjectAgentUpsert,
)
from .project_agent_recruitment_values import project_agent_recruitment_record
from .project_agent_task_models import (
    ProjectAgentRecruitmentDecision,
    ProjectAgentRecruitmentPolicyRecord,
    ProjectAgentRecruitmentPolicyUpdate,
    ProjectAgentRecruitmentRecord,
    ProjectAgentRoutingDecisionRecord,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_transactions import query_store_transaction


RECRUITMENT_CLAIM_TTL = timedelta(minutes=2)


class StoreProjectAgentTaskRecruitment:
    """Own the audited HR lifecycle independently from task routing mechanics."""

    async def get_project_agent_recruitment_policy(
        self,
        actor: dict,
        personal_space_id: str,
    ) -> ProjectAgentRecruitmentPolicyRecord:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_RECRUITMENT_POLICY]->
                  (policy:FuliProjectAgentRecruitmentPolicy)
            RETURN policy
            ''',
            personal_space_id=personal_space_id,
            routing_='r',
        )
        if not records:
            return ProjectAgentRecruitmentPolicyRecord(
                personal_space_id=personal_space_id,
                confirmation_mode='automatic',
                updated_at=None,
            )
        raw = dict(records[0]['policy'])
        return ProjectAgentRecruitmentPolicyRecord(
            personal_space_id=personal_space_id,
            confirmation_mode=raw.get('confirmation_mode') or 'automatic',
            updated_at=native_datetime(raw.get('updated_at')),
        )

    async def update_project_agent_recruitment_policy(
        self,
        actor: dict,
        request: ProjectAgentRecruitmentPolicyUpdate,
    ) -> ProjectAgentRecruitmentPolicyRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        updated_at = now_utc()
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (policy:FuliProjectAgentRecruitmentPolicy {
              personal_space_id: $personal_space_id
            })
            SET policy.confirmation_mode = $confirmation_mode,
                policy.updated_at = $updated_at
            MERGE (space)-[:HAS_PROJECT_AGENT_RECRUITMENT_POLICY]->(policy)
            ''',
            personal_space_id=request.personal_space_id,
            confirmation_mode=request.confirmation_mode,
            updated_at=updated_at,
        )
        return ProjectAgentRecruitmentPolicyRecord(
            personal_space_id=request.personal_space_id,
            confirmation_mode=request.confirmation_mode,
            updated_at=updated_at,
        )

    async def decide_project_agent_recruitment(
        self,
        actor: dict,
        request: ProjectAgentRecruitmentDecision,
    ) -> ProjectAgentRecruitmentRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        updated_at = now_utc()
        decision_status = (
            'cancelled' if request.decision == 'cancel' else 'requested'
        )
        provisioning_claim_id = (
            str(uuid4()) if decision_status == 'requested' else None
        )
        cancel_event_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-task-event',
            'recruitment-cancelled',
            request.recruitment_id,
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id,
                    personal_project_id: $personal_project_id
                  })
            MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask)
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (hr:FuliProjectAgent {agent_type: 'hr', status: 'active'})
            WHERE hr.agent_id = recruitment.hr_agent_id
            WITH recruitment, task, hr
            WHERE recruitment.status = 'awaiting_confirmation'
              AND coalesce(recruitment.revision, 0) = $expected_revision
              AND task.task_id = recruitment.task_id
              AND task.status = 'awaiting_recruitment'
              AND (
                task.recruitment_provisioning_claimed_at IS NULL
                OR task.recruitment_provisioning_claimed_at <=
                   $claim_expired_before
              )
              AND (
                $decision_status = 'cancelled'
                OR hr IS NOT NULL
              )
            SET recruitment.status = $decision_status,
                recruitment.decision_reason = $reason,
                recruitment.provisioning_claim_id = $provisioning_claim_id,
                recruitment.provisioning_claimed_at = $provisioning_claimed_at,
                recruitment.revision = coalesce(recruitment.revision, 0) + 1,
                recruitment.updated_at = $updated_at,
                task.revision = coalesce(task.revision, 0) + 1,
                task.updated_at = $updated_at,
                task.recruitment_provisioning_claim_id =
                  $provisioning_claim_id,
                task.recruitment_provisioning_claimed_at =
                  $provisioning_claimed_at
            FOREACH (_ IN CASE
              WHEN $decision_status = 'cancelled' THEN [1] ELSE [] END |
              SET task.status = 'blocked',
                  task.routing_outcome = 'blocked',
                  task.executor_blocked_reason = $task_blocked_reason
              MERGE (event:FuliProjectAgentTaskEvent {id: $cancel_event_id})
              ON CREATE SET event.event_id = $cancel_event_id,
                            event.task_id = task.task_id,
                            event.status = 'blocked',
                            event.actor_kind = 'hr',
                            event.summary = $task_blocked_reason,
                            event.created_at = $updated_at
              MERGE (task)-[:HAS_TASK_EVENT]->(event)
            )
            RETURN recruitment
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            recruitment_id=request.recruitment_id,
            expected_revision=request.expected_revision,
            decision_status=decision_status,
            reason=request.reason,
            provisioning_claim_id=provisioning_claim_id,
            provisioning_claimed_at=(
                updated_at if provisioning_claim_id else None
            ),
            claim_expired_before=updated_at - RECRUITMENT_CLAIM_TTL,
            task_blocked_reason=f'recruitment cancelled: {request.reason}',
            cancel_event_id=cancel_event_id,
            updated_at=updated_at,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='recruitment is not awaiting confirmation or revision is stale',
            )
        raw = dict(records[0]['recruitment'])
        if request.decision == 'cancel':
            return self._recruitment(raw)
        if not raw.get('hr_agent_id'):
            raise HTTPException(
                status_code=409,
                detail='recruitment cannot proceed without an active HR Agent',
            )
        raw['_guarded_task_id'] = raw['task_id']
        selected = await self._provision_recruitment(actor, raw)
        await self._activate_approved_recruitment(
            actor,
            raw,
            selected,
            request.reason,
        )
        record = await self._get_recruitment(
            request.personal_space_id,
            request.recruitment_id,
        )
        if not record:
            raise HTTPException(status_code=404, detail='recruitment not found')
        return record

    async def _activate_approved_recruitment(
        self,
        actor,
        recruitment,
        selected,
        approval_reason,
        *,
        _attempt=0,
    ):
        row = await self._find_task_row(
            recruitment['personal_space_id'],
            recruitment['task_id'],
        )
        if not row:
            raise HTTPException(status_code=404, detail='recruitment task not found')
        raw_task = dict(row['task'])
        linked = await self._link_recruited_task_participant(
            recruitment,
            selected,
        )
        if linked is False:
            raise HTTPException(
                status_code=409,
                detail='recruited project Agent is not active',
            )
        task_recruitments = await self._task_recruitments(
            recruitment['personal_space_id'],
            recruitment['task_id'],
        )
        if task_recruitments and any(
            item.status != 'fulfilled' for item in task_recruitments
        ):
            return
        if raw_task.get('status') != 'awaiting_recruitment':
            return

        routing_selected = await self._recruitment_routing_lead(
            recruitment,
            selected,
            raw_task,
            task_recruitments,
        )
        expected_task_revision = int(raw_task.get('revision') or 0)
        task_model_override = raw_task.get('task_model_strategy_override_json')
        if task_model_override:
            model_strategy = ProjectAgentModelStrategy.model_validate_json(
                task_model_override
            )
            model_source = 'task'
        else:
            model_strategy = routing_selected['profile'].default_model_strategy
            model_source = 'agent'
        task_executor_override = raw_task.get(
            'task_executor_policy_override_json'
        )
        executor_decision = None
        resolver = getattr(self, 'resolve_project_agent_executor', None)
        if callable(resolver):
            executor_decision = await resolver(
                actor,
                personal_space_id=recruitment['personal_space_id'],
                personal_project_id=recruitment['personal_project_id'],
                task_id=recruitment['task_id'],
                agent_id=routing_selected['agent_id'],
                work_kind=raw_task['work_kind'],
                required_capabilities=list(
                    raw_task.get('executor_capability_hints') or []
                ),
                model_strategy=model_strategy,
                task_override=(
                    json.loads(task_executor_override)
                    if task_executor_override else None
                ),
                assignment_id=routing_selected.get('assignment_id'),
                model_strategy_source=model_source,
                idempotency_key=f"recruit:{recruitment['recruitment_id']}",
            )
        blocked = bool(
            executor_decision
            and self._executor_decision_blocked(executor_decision)
        )
        status = 'blocked' if blocked else 'queued'
        outcome = 'blocked' if blocked else 'recruited'
        now = now_utc()
        decision_id = stable_uuid(
            self.settings.provider_id,
            recruitment['personal_space_id'],
            'project-agent-routing-decision',
            recruitment['task_id'],
            'approved-recruitment',
        )
        decision = ProjectAgentRoutingDecisionRecord(
            decision_id=decision_id,
            task_id=recruitment['task_id'],
            coordinator_agent_id=recruitment['coordinator_agent_id'],
            complexity=raw_task.get('complexity') or 'standard',
            complexity_basis=list(raw_task.get('complexity_basis') or []),
            selected_model_strategy=model_strategy,
            model_strategy_source=model_source,
            outcome=outcome,
            reason=recruitment['reason_code'],
            match_basis=['HR recruitment approved and Agent assigned'],
            candidate_agent_ids=[routing_selected['agent_id']],
            created_at=now,
            **self._decision_executor_fields(executor_decision),
        )
        executor_raw = (
            executor_decision.model_dump(mode='json')
            if hasattr(executor_decision, 'model_dump')
            else executor_decision
        )
        explanation = self._routing_explanation(
            recruitment['reason_code'],
            ['HR recruitment approved and Agent assigned'],
            executor_decision,
        )
        event_id = stable_uuid(
            self.settings.provider_id,
            recruitment['personal_space_id'],
            'project-agent-task-event',
            recruitment['task_id'],
            'recruitment-approved',
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            SET task._task_lifecycle_lock = true
            REMOVE task._task_lifecycle_lock
            WITH space, task
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            MATCH (task)-[:HAS_PARTICIPANT]->
                  (lifecycle_agent:FuliProjectAgent)
            WITH space, task, agent, lifecycle_agent
            ORDER BY lifecycle_agent.agent_id
            SET lifecycle_agent._task_lifecycle_lock = true
            REMOVE lifecycle_agent._task_lifecycle_lock
            WITH space, task, agent,
                 collect(lifecycle_agent) AS locked_agents
            WHERE agent IN locked_agents
              AND all(locked_agent IN locked_agents
                      WHERE locked_agent.status = 'active')
              AND coalesce(task.revision, 0) = $expected_task_revision
              AND task.status = 'awaiting_recruitment'
            OPTIONAL MATCH (task)-[old_route:ROUTED_BY]->()
            DELETE old_route
            SET task.status = $status,
                task.routing_outcome = $routing_outcome,
                task.routing_explanation = $routing_explanation,
                task.lead_agent_id = $agent_id,
                task.effective_model_strategy_json = $model_strategy_json,
                task.model_strategy_source = $model_strategy_source,
                task.executor_decision_json = $executor_decision_json,
                task.executor_policy_json = $executor_policy_json,
                task.selected_executor_id = $selected_executor_id,
                task.matched_executor_rule_id = $matched_rule_id,
                task.executor_selection_reason = $selection_reason,
                task.executor_fallback_outcome = $fallback_outcome,
                task.executor_fallback_reason = $fallback_reason,
                task.executor_blocked_reason = $blocked_reason,
                task.updated_at = $updated_at,
                task.revision = coalesce(task.revision, 0) + 1
            MERGE (task)-[participant:HAS_PARTICIPANT]->(agent)
            SET participant.role = 'lead',
                participant.status = $status,
                participant.assignment_summary = $assignment_summary,
                participant.joined_at = coalesce(participant.joined_at, $updated_at),
                participant.updated_at = $updated_at
            WITH task, agent, locked_agents
            MATCH (task)-[task_participant:HAS_PARTICIPANT]->
                  (participant_agent:FuliProjectAgent)
            WHERE participant_agent IN locked_agents
            SET task_participant.status = $status,
                task_participant.updated_at = $updated_at
            WITH DISTINCT task, agent
            MERGE (decision_node:FuliProjectAgentRoutingDecision {id: $decision_id})
            ON CREATE SET decision_node.decision_id = $decision_id,
                          decision_node.task_id = $task_id,
                          decision_node.created_at = $updated_at
            SET decision_node.decision_json = $decision_json
            MERGE (task)-[:ROUTED_BY]->(decision_node)
            MERGE (event:FuliProjectAgentTaskEvent {id: $event_id})
            ON CREATE SET event.event_id = $event_id,
                          event.task_id = $task_id,
                          event.agent_id = $agent_id,
                          event.status = $status,
                          event.actor_kind = 'hr',
                          event.summary = $event_summary,
                          event.created_at = $updated_at
            MERGE (task)-[:HAS_TASK_EVENT]->(event)
            MERGE (event)-[:EVENT_AGENT]->(agent)
            RETURN task
            ''',
            task_id=recruitment['task_id'],
            personal_space_id=recruitment['personal_space_id'],
            agent_id=routing_selected['agent_id'],
            status=status,
            routing_outcome=outcome,
            routing_explanation=explanation,
            model_strategy_json=model_strategy.model_dump_json(),
            model_strategy_source=model_source,
            executor_decision_json=(
                json.dumps(executor_raw, sort_keys=True)
                if executor_raw else None
            ),
            executor_policy_json=(
                json.dumps(executor_raw.get('executor_policy'), sort_keys=True)
                if executor_raw and executor_raw.get('executor_policy') else None
            ),
            selected_executor_id=(
                (executor_raw or {}).get('selected_executor_id')
                or (executor_raw or {}).get('executor_id')
            ),
            matched_rule_id=(executor_raw or {}).get('matched_rule_id'),
            selection_reason=(executor_raw or {}).get('selection_reason'),
            fallback_outcome=(executor_raw or {}).get('fallback_outcome'),
            fallback_reason=(executor_raw or {}).get('fallback_reason'),
            blocked_reason=(executor_raw or {}).get('blocked_reason'),
            assignment_summary=routing_selected.get('responsibility'),
            decision_id=decision_id,
            decision_json=decision.model_dump_json(),
            event_id=event_id,
            event_summary=f'HR recruitment approved: {approval_reason}',
            expected_task_revision=expected_task_revision,
            updated_at=now,
        )
        if not records:
            latest = await self._find_task_row(
                recruitment['personal_space_id'],
                recruitment['task_id'],
            )
            if latest and dict(latest['task']).get('status') != 'awaiting_recruitment':
                return
            if _attempt < 2:
                return await self._activate_approved_recruitment(
                    actor,
                    recruitment,
                    selected,
                    approval_reason,
                    _attempt=_attempt + 1,
                )
            raise HTTPException(
                status_code=409,
                detail='recruitment task changed before activation',
            )

    async def _link_recruited_task_participant(self, recruitment, selected):
        """Repair durable links without changing task lifecycle state."""

        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            SET task._task_lifecycle_lock = true
            REMOVE task._task_lifecycle_lock
            WITH space, task
            MATCH (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id,
                    status: 'fulfilled'
                  })
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH task, recruitment, agent
            WHERE agent.status = 'active'
            MERGE (task)-[participant:HAS_PARTICIPANT]->(agent)
            ON CREATE SET participant.role =
                            coalesce(recruitment.participant_role, 'lead'),
                          participant.status = task.status,
                          participant.assignment_summary = $assignment_summary,
                          participant.joined_at = $updated_at,
                          participant.updated_at = $updated_at
            SET task.recruitment_id = coalesce(
                  task.recruitment_id, recruitment.recruitment_id),
                task.hr_agent_id = coalesce(
                  task.hr_agent_id, recruitment.hr_agent_id)
            MERGE (task)-[:TRIGGERED_RECRUITMENT]->(recruitment)
            RETURN count(task) AS linked_count
            ''',
            personal_space_id=recruitment['personal_space_id'],
            task_id=recruitment['task_id'],
            recruitment_id=recruitment['recruitment_id'],
            agent_id=selected['agent_id'],
            assignment_summary=selected.get('responsibility'),
            updated_at=updated_at,
        )
        return bool(records and records[0].get('linked_count') == 1)

    async def _recruitment_routing_lead(
        self,
        recruitment,
        selected,
        raw_task,
        task_recruitments,
    ):
        if (recruitment.get('participant_role') or 'lead') == 'lead':
            return selected
        lead_agent_id = raw_task.get('lead_agent_id')
        if not lead_agent_id:
            lead_recruitment = next(
                (
                    item
                    for item in task_recruitments
                    if item.participant_role == 'lead'
                ),
                None,
            )
            if lead_recruitment:
                lead_agent_id = (
                    lead_recruitment.recruited_agent_id
                    or lead_recruitment.proposed_agent_id
                )
        candidates = await self._assignment_candidates(
            recruitment['personal_space_id'],
            recruitment['personal_project_id'],
            include_temporary=True,
        )
        lead = next(
            (
                item for item in candidates
                if item['agent_id'] == lead_agent_id
            ),
            None,
        )
        if not lead:
            raise HTTPException(
                status_code=409,
                detail='recruited task lead assignment is unavailable',
            )
        return lead

    async def _recover_recruitment_lifecycle(
        self,
        actor,
        request,
        task,
        recruitments,
    ):
        recovered_requested = False
        if task.status == 'awaiting_recruitment':
            expected_task_revision = int(getattr(task, 'revision', 0) or 0)
            for record in recruitments:
                if record.status != 'requested':
                    continue
                recovery_guard = {
                    'task_id': task.task_id,
                    'expected_task_revision': expected_task_revision,
                }
                if await self._finalize_ready_recruitment(
                    request,
                    record.recruitment_id,
                    **recovery_guard,
                ):
                    recovered_requested = True
                    expected_task_revision += 1
                    continue
                claimed = await self._claim_requested_recruitment(
                    request,
                    record.recruitment_id,
                    **recovery_guard,
                )
                if not claimed:
                    continue
                await self._provision_recruitment(actor, claimed)
                recovered_requested = True
                # The guarded claim and fulfillment each advance the Task CAS.
                expected_task_revision += 2
        if recovered_requested:
            recruitments = await self._task_recruitments(
                request.personal_space_id,
                task.task_id,
            )
        fulfilled = [
            item for item in recruitments if item.status == 'fulfilled'
        ]
        if not fulfilled:
            return recovered_requested
        candidates = await self._assignment_candidates(
            request.personal_space_id,
            request.personal_project_id,
            include_temporary=True,
        )
        by_agent_id = {item['agent_id']: item for item in candidates}
        recovered = []
        for record in fulfilled:
            raw = await self._get_recruitment_raw(
                request.personal_space_id,
                record.recruitment_id,
            )
            if not raw:
                continue
            agent_id = record.recruited_agent_id or record.proposed_agent_id
            selected = by_agent_id.get(agent_id) or {
                'agent_id': agent_id,
                'responsibility': record.proposed_profile.responsibility,
                'profile': record.proposed_profile,
            }
            linked = await self._link_recruited_task_participant(raw, selected)
            if linked is False:
                continue
            recovered.append((raw, selected))
        if (
            not recovered
            or task.status != 'awaiting_recruitment'
            or len(fulfilled) != len(recruitments)
        ):
            return bool(recovered) or recovered_requested
        raw, selected = next(
            (
                item for item in recovered
                if (item[0].get('participant_role') or 'lead') == 'lead'
            ),
            recovered[0],
        )
        await self._activate_approved_recruitment(
            actor,
            raw,
            selected,
            'Recovered fulfilled recruitment activation during task replay.',
        )
        return True

    async def list_project_agent_recruitments(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        personal_project_id: str | None = None,
        task_id: str | None = None,
        status: str | None = None,
    ) -> list[ProjectAgentRecruitmentRecord]:
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
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment)
            WHERE ($personal_project_id IS NULL
                   OR recruitment.personal_project_id = $personal_project_id)
              AND ($task_id IS NULL OR recruitment.task_id = $task_id)
              AND ($status IS NULL OR recruitment.status = $status)
            RETURN recruitment
            ORDER BY recruitment.created_at DESC, recruitment.recruitment_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            task_id=task_id,
            status=status,
            routing_='r',
        )
        return [self._recruitment(dict(row['recruitment'])) for row in records]

    async def _open_recruitment(
        self,
        actor,
        space,
        request,
        task_id,
        coordinator_agent_id,
        reason_code,
        *,
        participant_role='lead',
        recruitment_slot=None,
    ):
        if participant_role not in {'lead', 'collaborator'}:
            raise ValueError('recruitment participant role is invalid')
        slot = recruitment_slot or 'lead'
        if not slot or len(slot) > 128:
            raise ValueError('recruitment slot must contain 1 to 128 characters')

        position_kind, profile = self._normalized_recruitment_profile(request)
        self._require_agent_client_allowed(
            profile,
            request.source_application,
        )
        is_legacy_lead_slot = participant_role == 'lead' and slot == 'lead'
        recruitment_id_parts = [task_id]
        proposed_agent_id_parts = [task_id, position_kind]
        if not is_legacy_lead_slot:
            recruitment_id_parts.append(slot)
            proposed_agent_id_parts.append(slot)
        recruitment_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-recruitment',
            *recruitment_id_parts,
        )
        proposed_agent_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'recruited-project-agent',
            *proposed_agent_id_parts,
        )

        existing = await self._get_recruitment(
            request.personal_space_id,
            recruitment_id,
        )
        if existing:
            return await self._existing_recruitment_result(
                actor,
                request,
                existing,
            )

        hr_records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (hr:FuliProjectAgent {agent_type: 'hr', status: 'active'})
            RETURN hr ORDER BY hr.created_at, hr.agent_id LIMIT 1
            ''',
            personal_space_id=request.personal_space_id,
            routing_='r',
        )
        hr_agent_id = (
            dict(hr_records[0]['hr'])['agent_id'] if hr_records else None
        )
        coordination_policy = await self.get_project_agent_coordination_policy(
            actor,
            request.personal_space_id,
            request.personal_project_id,
        )
        confirmation_mode = (
            'require_confirmation'
            if coordination_policy.ask_before_recruitment
            else 'automatic'
        )
        if not hr_agent_id:
            status = 'no_hr'
        elif confirmation_mode == 'require_confirmation':
            status = 'awaiting_confirmation'
        else:
            status = 'requested'
        now = now_utc()
        raw = {
            'id': recruitment_id,
            'recruitment_id': recruitment_id,
            'personal_space_id': request.personal_space_id,
            'personal_project_id': request.personal_project_id,
            'task_id': task_id,
            'coordinator_agent_id': coordinator_agent_id,
            'hr_agent_id': hr_agent_id,
            'position_kind': position_kind,
            'work_kind': request.work_kind,
            'required_capabilities': request.required_capabilities,
            'reason_code': reason_code,
            'reason': request.routing_reason,
            'status': status,
            'confirmation_mode': confirmation_mode,
            'proposed_agent_id': proposed_agent_id,
            'proposed_profile_json': profile.model_dump_json(),
            'participant_role': participant_role,
            'recruitment_slot': slot,
            'occupation_emoji': profile.occupation_emoji,
            'trigger_source_application': request.source_application,
            'trigger_source_session_id': request.source_session_id,
            'revision': 0,
            'created_at': now,
            'updated_at': now,
            'test_source': profile.test_source,
            'cleanup_eligible': profile.cleanup_eligible,
            'provisioning_claim_id': (
                str(uuid4()) if status == 'requested' else None
            ),
            'provisioning_claimed_at': (
                now if status == 'requested' else None
            ),
        }
        claimed = await self._persist_recruitment(raw)
        if status == 'requested' and claimed is False:
            existing = await self._get_recruitment(
                request.personal_space_id,
                recruitment_id,
            )
            if not existing:
                raise HTTPException(
                    status_code=409,
                    detail='recruitment creation raced; retry task submission',
                )
            return await self._existing_recruitment_result(
                actor,
                request,
                existing,
            )
        record = self._recruitment(raw)
        if status != 'requested' or not hr_agent_id:
            return record, None
        recruited = await self._provision_recruitment(actor, raw)
        return await self._get_recruitment(
            request.personal_space_id,
            recruitment_id,
        ), recruited

    async def _existing_recruitment_result(self, actor, request, existing):
        if existing.status == 'requested':
            ready = await self._finalize_ready_recruitment(
                request,
                existing.recruitment_id,
            )
            if ready:
                record = self._recruitment(ready)
                return await self._fulfilled_recruitment_result(
                    request,
                    record,
                )
            raw = await self._claim_requested_recruitment(
                request,
                existing.recruitment_id,
            )
            if not raw:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        'automatic recruitment is already provisioning; '
                        'retry task submission'
                    ),
                )
            recruited = await self._provision_recruitment(actor, raw)
            record = await self._get_recruitment(
                request.personal_space_id,
                existing.recruitment_id,
            )
            if not record:
                raise HTTPException(status_code=404, detail='recruitment not found')
            return record, recruited
        if existing.status != 'fulfilled':
            return existing, None
        return await self._fulfilled_recruitment_result(request, existing)

    async def _fulfilled_recruitment_result(self, request, existing):
        assignment_rows = await self._assignment_candidates(
            request.personal_space_id,
            request.personal_project_id,
            include_temporary=True,
        )
        recruited_agent_id = (
            existing.recruited_agent_id or existing.proposed_agent_id
        )
        recruited = next(
            (
                item
                for item in assignment_rows
                if item['agent_id'] == recruited_agent_id
            ),
            None,
        )
        return existing, recruited

    async def _finalize_ready_recruitment(
        self,
        request,
        recruitment_id,
        *,
        task_id=None,
        expected_task_revision=None,
    ):
        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id,
                    status: 'requested'
                  })
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            FOREACH (_ IN CASE WHEN task IS NULL THEN [] ELSE [1] END |
              SET task._task_lifecycle_lock = true
            )
            FOREACH (_ IN CASE WHEN task IS NULL THEN [] ELSE [1] END |
              REMOVE task._task_lifecycle_lock
            )
            WITH space, recruitment, task
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent)
            WHERE agent.agent_id = recruitment.proposed_agent_id
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH space, recruitment, agent, task
            WHERE agent.status = 'active'
            MATCH (space)-[:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: $personal_project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (:FuliProjectAgentAssignment {status: 'active'})-
                  [:ASSIGNED_AGENT]->(agent)
            WITH recruitment, agent, task
            WHERE $task_id IS NULL
               OR (
                 recruitment.task_id = $task_id
                 AND task.status = 'awaiting_recruitment'
                 AND coalesce(task.revision, 0) = $expected_task_revision
               )
            SET recruitment.status = 'fulfilled',
                recruitment.recruited_agent_id = agent.agent_id,
                recruitment.fulfilled_at = $updated_at,
                recruitment.updated_at = $updated_at,
                recruitment.revision = coalesce(recruitment.revision, 0) + 1,
                agent.recruitment_id = recruitment.recruitment_id,
                agent.recruited_at = coalesce(agent.recruited_at, $updated_at),
                agent.recruitment_reason = recruitment.reason,
                agent.recruitment_source_application =
                  recruitment.trigger_source_application,
                agent.temporary_task_id = CASE recruitment.position_kind
                  WHEN 'temporary' THEN recruitment.task_id
                  ELSE agent.temporary_task_id END,
                agent.test_source = recruitment.test_source,
                agent.cleanup_eligible =
                  coalesce(recruitment.cleanup_eligible, false)
            FOREACH (_ IN CASE WHEN $task_id IS NULL THEN [] ELSE [1] END |
              SET task.recruitment_provisioning_claim_id = null,
                  task.recruitment_provisioning_claimed_at = null,
                  task.revision = coalesce(task.revision, 0) + 1,
                  task.updated_at = $updated_at
            )
            MERGE (recruitment)-[:CREATED_AGENT]->(agent)
            RETURN recruitment
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            recruitment_id=recruitment_id,
            task_id=task_id,
            expected_task_revision=expected_task_revision,
            updated_at=updated_at,
        )
        return dict(records[0]['recruitment']) if records else None

    async def _claim_requested_recruitment(
        self,
        request,
        recruitment_id,
        *,
        task_id=None,
        expected_task_revision=None,
    ):
        claimed_at = now_utc()
        claim_id = str(uuid4())
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id
                  })
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            WITH recruitment, task
            WHERE (
                $task_id IS NULL
                OR (
                  recruitment.task_id = $task_id
                  AND task.status = 'awaiting_recruitment'
                  AND coalesce(task.revision, 0) = $expected_task_revision
                )
              )
              AND recruitment.status = 'requested'
              AND (
                recruitment.provisioning_claimed_at IS NULL
                OR recruitment.provisioning_claimed_at <= $claim_expired_before
              )
            SET recruitment.provisioning_claim_id = $provisioning_claim_id,
                recruitment.provisioning_claimed_at = $provisioning_claimed_at,
                recruitment.updated_at = $provisioning_claimed_at
            FOREACH (_ IN CASE WHEN $task_id IS NULL THEN [] ELSE [1] END |
              SET task.recruitment_provisioning_claim_id =
                    $provisioning_claim_id,
                  task.recruitment_provisioning_claimed_at =
                    $provisioning_claimed_at,
                  task.revision = coalesce(task.revision, 0) + 1,
                  task.updated_at = $provisioning_claimed_at
            )
            RETURN recruitment
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            recruitment_id=recruitment_id,
            task_id=task_id,
            expected_task_revision=expected_task_revision,
            provisioning_claim_id=claim_id,
            provisioning_claimed_at=claimed_at,
            claim_expired_before=claimed_at - RECRUITMENT_CLAIM_TTL,
        )
        if not records:
            return None
        raw = dict(records[0]['recruitment'])
        if task_id:
            raw['_guarded_task_id'] = task_id
        return raw

    @staticmethod
    def _normalized_recruitment_profile(request):
        position_kind = (
            'temporary'
            if request.staffing_intent == 'temporary'
            else 'durable'
        )
        profile = request.recruitment_profile or ProjectAgentProfile(
            name=f'{request.work_kind} Agent',
            responsibility=request.objective,
            agent_type=position_kind,
            work_kinds=[request.work_kind],
            capabilities=request.required_capabilities,
            status='active',
        )
        if profile.agent_type != position_kind:
            profile = profile.model_copy(update={'agent_type': position_kind})
        return position_kind, profile

    async def _persist_recruitment(self, raw):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MATCH (space)-[:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            MERGE (recruitment:FuliProjectAgentRecruitment {id: $id})
            ON CREATE SET recruitment += $properties
            MERGE (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]->(recruitment)
            MERGE (project)-[:HAS_PROJECT_AGENT_RECRUITMENT]->(recruitment)
            WITH space, recruitment
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (hr:FuliProjectAgent {agent_id: $hr_agent_id})
            FOREACH (_ IN CASE WHEN hr IS NULL THEN [] ELSE [1] END |
              MERGE (recruitment)-[:RECRUITED_BY]->(hr)
            )
            RETURN recruitment.provisioning_claim_id =
                   $provisioning_claim_id AS provisioning_claimed
            ''',
            personal_space_id=raw['personal_space_id'],
            personal_project_id=raw['personal_project_id'],
            id=raw['id'],
            properties=raw,
            hr_agent_id=raw.get('hr_agent_id'),
            provisioning_claim_id=raw.get('provisioning_claim_id'),
        )
        return bool(
            records
            and dict(records[0]).get('provisioning_claimed')
        )

    async def _provision_recruitment(self, actor, raw):
        # Identity, assignment and fulfillment either all commit or all roll back.
        # The audit/claim intentionally remains outside for recoverable retries.
        async with query_store_transaction(self) as scoped:
            return await scoped._provision_recruitment_transaction(actor, raw)

    async def _provision_recruitment_transaction(self, actor, raw):
        guarded_task_id = raw.get('_guarded_task_id')
        if guarded_task_id:
            active, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {
                  id: $personal_space_id, kind: 'personal'
                })-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {task_id: $task_id})
                SET task._recruitment_write_lock = true
                REMOVE task._recruitment_write_lock
                WITH task
                WHERE task.status = 'awaiting_recruitment'
                  AND task.recruitment_provisioning_claim_id =
                      $provisioning_claim_id
                RETURN task
                ''',
                personal_space_id=raw['personal_space_id'],
                task_id=guarded_task_id,
                provisioning_claim_id=raw.get('provisioning_claim_id'),
                routing_='r',
            )
            if not active:
                raise HTTPException(
                    status_code=409,
                    detail='recruitment task is no longer awaiting provisioning',
                )
        claimed, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                  -[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {recruitment_id: $recruitment_id})
            SET recruitment._provision_write_lock = true
            REMOVE recruitment._provision_write_lock
            WITH recruitment
            WHERE recruitment.status = 'requested'
              AND recruitment.provisioning_claim_id = $provisioning_claim_id
            RETURN recruitment
            ''',
            **{key: raw.get(key) for key in (
                'personal_space_id', 'recruitment_id', 'provisioning_claim_id')},
        )
        if not claimed:
            raise HTTPException(status_code=409, detail='recruitment provisioning claim is stale')
        profile = ProjectAgentProfile.model_validate_json(
            raw['proposed_profile_json']
        )
        occupation_emoji = raw.get('occupation_emoji') or raw.get(
            'occupationEmoji'
        )
        if not profile.occupation_emoji and occupation_emoji:
            profile = profile.model_copy(
                update={'occupation_emoji': occupation_emoji}
            )
        agent_id = raw['proposed_agent_id']
        await self.upsert_project_agent(
            actor,
            ProjectAgentUpsert(
                personal_space_id=raw['personal_space_id'],
                agent_id=agent_id,
                profile=profile,
            ),
            recruitment_id=raw['recruitment_id'],
        )
        await self.create_project_agent_assignment(
            actor,
            ProjectAgentAssignmentCreate(
                personal_space_id=raw['personal_space_id'],
                personal_project_id=raw['personal_project_id'],
                agent_id=agent_id,
                idempotency_key=f"recruit:{raw['recruitment_id']}",
                responsibility=profile.responsibility,
                work_kinds=profile.work_kinds or [raw['work_kind']],
                capabilities=profile.capabilities,
                reason=raw['reason'],
                source_application=raw.get('trigger_source_application'),
                source_session_id=raw.get('trigger_source_session_id'),
            ),
        )
        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id
                  })
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            WITH recruitment, agent, task
            WHERE recruitment.status = 'requested'
              AND recruitment.provisioning_claim_id = $provisioning_claim_id
              AND (
                NOT $task_guarded
                OR (
                  task.status = 'awaiting_recruitment'
                  AND task.recruitment_provisioning_claim_id =
                      $provisioning_claim_id
                )
              )
            SET recruitment.status = 'fulfilled',
                recruitment.recruited_agent_id = $agent_id,
                recruitment.fulfilled_at = $updated_at,
                recruitment.updated_at = $updated_at,
                recruitment.revision = coalesce(recruitment.revision, 0) + 1,
                agent.recruitment_id = $recruitment_id,
                agent.recruited_at = $updated_at,
                agent.recruitment_reason = recruitment.reason,
                agent.recruitment_source_application =
                  recruitment.trigger_source_application,
                agent.temporary_task_id = CASE recruitment.position_kind
                  WHEN 'temporary' THEN recruitment.task_id ELSE null END,
                agent.test_source = recruitment.test_source,
                agent.cleanup_eligible =
                  coalesce(recruitment.cleanup_eligible, false)
            FOREACH (_ IN CASE WHEN $task_guarded THEN [1] ELSE [] END |
              SET task.recruitment_provisioning_claim_id = null,
                  task.recruitment_provisioning_claimed_at = null,
                  task.revision = coalesce(task.revision, 0) + 1,
                  task.updated_at = $updated_at
            )
            MERGE (recruitment)-[:CREATED_AGENT]->(agent)
            RETURN recruitment
            ''',
            recruitment_id=raw['recruitment_id'],
            personal_space_id=raw['personal_space_id'],
            agent_id=agent_id,
            task_id=guarded_task_id,
            task_guarded=bool(guarded_task_id),
            provisioning_claim_id=raw.get('provisioning_claim_id'),
            updated_at=updated_at,
        )
        if not records:
            existing = await self._get_recruitment(
                raw['personal_space_id'],
                raw['recruitment_id'],
            )
            if not existing or existing.status != 'fulfilled':
                raise HTTPException(
                    status_code=409,
                    detail='recruitment provisioning claim is no longer active',
                )
        assignment_rows = await self._assignment_candidates(
            raw['personal_space_id'],
            raw['personal_project_id'],
            include_temporary=True,
        )
        selected = next(item for item in assignment_rows if item['agent_id'] == agent_id)
        return selected

    async def _get_recruitment(self, personal_space_id, recruitment_id):
        raw = await self._get_recruitment_raw(
            personal_space_id,
            recruitment_id,
        )
        return self._recruitment(raw) if raw else None

    async def _get_recruitment_raw(self, personal_space_id, recruitment_id):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (recruitment:FuliProjectAgentRecruitment {
              personal_space_id: $personal_space_id,
              recruitment_id: $recruitment_id
            })
            RETURN recruitment
            ''',
            personal_space_id=personal_space_id,
            recruitment_id=recruitment_id,
            routing_='r',
        )
        return dict(records[0]['recruitment']) if records else None

    async def _task_recruitment(self, personal_space_id, task_id):
        recruitments = await self._task_recruitments(
            personal_space_id,
            task_id,
        )
        return recruitments[0] if recruitments else None

    async def _task_recruitments(self, personal_space_id, task_id):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (recruitment:FuliProjectAgentRecruitment {
              personal_space_id: $personal_space_id,
              task_id: $task_id
            })
            RETURN recruitment
            ORDER BY CASE
              WHEN coalesce(recruitment.participant_role, 'lead') = 'lead'
              THEN 0 ELSE 1 END,
              recruitment.created_at,
              recruitment.recruitment_id
            ''',
            personal_space_id=personal_space_id,
            task_id=task_id,
            routing_='r',
        )
        return [
            self._recruitment(dict(row['recruitment']))
            for row in records
        ]

    def _recruitment(self, raw):
        return project_agent_recruitment_record(raw)
