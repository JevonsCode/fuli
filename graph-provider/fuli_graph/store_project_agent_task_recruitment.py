"""Recruitment policy, decisions, provisioning, and audit reads for Agent tasks."""

from __future__ import annotations

import json

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_models import (
    ProjectAgentAssignmentCreate,
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
    ProjectAgentUpsert,
)
from .project_agent_task_models import (
    ProjectAgentRecruitmentDecision,
    ProjectAgentRecruitmentPolicyRecord,
    ProjectAgentRecruitmentPolicyUpdate,
    ProjectAgentRecruitmentRecord,
    ProjectAgentRoutingDecisionRecord,
)
from .provider_values import native_datetime, now_utc, stable_uuid


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
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (recruitment:FuliProjectAgentRecruitment {
              personal_space_id: $personal_space_id,
              recruitment_id: $recruitment_id,
              personal_project_id: $personal_project_id
            })
            WHERE recruitment.status = 'awaiting_confirmation'
              AND recruitment.revision = $expected_revision
            RETURN recruitment
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            recruitment_id=request.recruitment_id,
            expected_revision=request.expected_revision,
            routing_='r',
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='recruitment is not awaiting confirmation or revision is stale',
            )
        raw = dict(records[0]['recruitment'])
        updated_at = now_utc()
        if request.decision == 'cancel':
            await self.runtime.driver.execute_query(
                '''
                MATCH (recruitment:FuliProjectAgentRecruitment {
                  recruitment_id: $recruitment_id,
                  personal_space_id: $personal_space_id
                })
                SET recruitment.status = 'cancelled',
                    recruitment.decision_reason = $reason,
                    recruitment.revision = recruitment.revision + 1,
                    recruitment.updated_at = $updated_at
                ''',
                recruitment_id=request.recruitment_id,
                personal_space_id=request.personal_space_id,
                reason=request.reason,
                updated_at=updated_at,
            )
            await self._mark_recruitment_task_blocked(
                raw,
                request.reason,
                updated_at,
            )
            raw.update({
                'status': 'cancelled',
                'revision': int(raw.get('revision') or 0) + 1,
                'updated_at': updated_at,
            })
            return self._recruitment(raw)
        if not raw.get('hr_agent_id'):
            raise HTTPException(
                status_code=409,
                detail='recruitment cannot proceed without an active HR Agent',
            )
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

    async def _mark_recruitment_task_blocked(self, recruitment, reason, updated_at):
        event_id = stable_uuid(
            self.settings.provider_id,
            recruitment['personal_space_id'],
            'project-agent-task-event',
            recruitment['task_id'],
            'recruitment-cancelled',
        )
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
            SET task.status = 'blocked',
                task.routing_outcome = 'blocked',
                task.executor_blocked_reason = $reason,
                task.updated_at = $updated_at,
                task.revision = coalesce(task.revision, 0) + 1
            MERGE (event:FuliProjectAgentTaskEvent {id: $event_id})
            ON CREATE SET event.event_id = $event_id,
                          event.task_id = $task_id,
                          event.status = 'blocked',
                          event.actor_kind = 'hr',
                          event.summary = $reason,
                          event.created_at = $updated_at
            MERGE (task)-[:HAS_TASK_EVENT]->(event)
            ''',
            task_id=recruitment['task_id'],
            personal_space_id=recruitment['personal_space_id'],
            recruitment_id=recruitment['recruitment_id'],
            event_id=event_id,
            reason=f'recruitment cancelled: {reason}',
            updated_at=updated_at,
        )

    async def _activate_approved_recruitment(
        self,
        actor,
        recruitment,
        selected,
        approval_reason,
    ):
        row = await self._find_task_row(
            recruitment['personal_space_id'],
            recruitment['task_id'],
        )
        if not row:
            raise HTTPException(status_code=404, detail='recruitment task not found')
        raw_task = dict(row['task'])
        task_model_override = raw_task.get('task_model_strategy_override_json')
        if task_model_override:
            model_strategy = ProjectAgentModelStrategy.model_validate_json(
                task_model_override
            )
            model_source = 'task'
        else:
            model_strategy = selected['profile'].default_model_strategy
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
                agent_id=selected['agent_id'],
                work_kind=raw_task['work_kind'],
                required_capabilities=list(
                    raw_task.get('required_capabilities') or []
                ),
                model_strategy=model_strategy,
                task_override=(
                    json.loads(task_executor_override)
                    if task_executor_override else None
                ),
                assignment_id=selected.get('assignment_id'),
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
            candidate_agent_ids=[selected['agent_id']],
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
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
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
            ''',
            task_id=recruitment['task_id'],
            personal_space_id=recruitment['personal_space_id'],
            agent_id=selected['agent_id'],
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
            assignment_summary=selected.get('responsibility'),
            decision_id=decision_id,
            decision_json=decision.model_dump_json(),
            event_id=event_id,
            event_summary=f'HR recruitment approved: {approval_reason}',
            updated_at=now,
        )

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
    ):
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
        self._require_agent_client_allowed(
            profile,
            request.source_application,
        )
        recruitment_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-recruitment',
            task_id,
        )
        proposed_agent_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'recruited-project-agent',
            task_id,
            position_kind,
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
            'occupation_emoji': profile.occupation_emoji,
            'trigger_source_application': request.source_application,
            'trigger_source_session_id': request.source_session_id,
            'revision': 0,
            'created_at': now,
            'updated_at': now,
            'test_source': profile.test_source,
            'cleanup_eligible': profile.cleanup_eligible,
        }
        await self._persist_recruitment(raw)
        record = self._recruitment(raw)
        if status != 'requested' or not hr_agent_id:
            return record, None
        recruited = await self._provision_recruitment(actor, raw)
        return await self._get_recruitment(
            request.personal_space_id,
            recruitment_id,
        ), recruited

    async def _persist_recruitment(self, raw):
        await self.runtime.driver.execute_query(
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
            ''',
            personal_space_id=raw['personal_space_id'],
            personal_project_id=raw['personal_project_id'],
            id=raw['id'],
            properties=raw,
            hr_agent_id=raw.get('hr_agent_id'),
        )

    async def _provision_recruitment(self, actor, raw):
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
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id
                  })
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            SET recruitment.status = 'fulfilled',
                recruitment.recruited_agent_id = $agent_id,
                recruitment.fulfilled_at = $updated_at,
                recruitment.updated_at = $updated_at,
                recruitment.revision = recruitment.revision + 1,
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
            MERGE (recruitment)-[:CREATED_AGENT]->(agent)
            ''',
            recruitment_id=raw['recruitment_id'],
            personal_space_id=raw['personal_space_id'],
            agent_id=agent_id,
            updated_at=updated_at,
        )
        assignment_rows = await self._assignment_candidates(
            raw['personal_space_id'],
            raw['personal_project_id'],
            include_temporary=True,
        )
        selected = next(item for item in assignment_rows if item['agent_id'] == agent_id)
        return selected

    async def _get_recruitment(self, personal_space_id, recruitment_id):
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
        return (
            self._recruitment(dict(records[0]['recruitment']))
            if records else None
        )

    async def _task_recruitment(self, personal_space_id, task_id):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (recruitment:FuliProjectAgentRecruitment {
              personal_space_id: $personal_space_id,
              task_id: $task_id
            })
            RETURN recruitment ORDER BY recruitment.created_at DESC LIMIT 1
            ''',
            personal_space_id=personal_space_id,
            task_id=task_id,
            routing_='r',
        )
        return self._recruitment(dict(records[0]['recruitment'])) if records else None

    def _recruitment(self, raw):
        proposed_profile = ProjectAgentProfile.model_validate_json(
            raw['proposed_profile_json']
        )
        occupation_emoji = raw.get('occupation_emoji') or raw.get(
            'occupationEmoji'
        )
        if not proposed_profile.occupation_emoji and occupation_emoji:
            proposed_profile = proposed_profile.model_copy(
                update={'occupation_emoji': occupation_emoji}
            )
        fields = {
            'recruitment_id': raw.get('recruitment_id') or raw['id'],
            'personal_space_id': raw['personal_space_id'],
            'personal_project_id': raw['personal_project_id'],
            'task_id': raw['task_id'],
            'coordinator_agent_id': raw['coordinator_agent_id'],
            'hr_agent_id': raw.get('hr_agent_id'),
            'position_kind': raw['position_kind'],
            'work_kind': raw['work_kind'],
            'required_capabilities': list(raw.get('required_capabilities') or []),
            'reason_code': raw['reason_code'],
            'reason': raw['reason'],
            'status': raw['status'],
            'confirmation_mode': raw['confirmation_mode'],
            'proposed_agent_id': raw['proposed_agent_id'],
            'proposed_profile': proposed_profile,
            'trigger_source_application': raw.get('trigger_source_application'),
            'trigger_source_session_id': raw.get('trigger_source_session_id'),
            'revision': int(raw.get('revision') or 0),
            'recruited_agent_id': raw.get('recruited_agent_id'),
            'created_at': native_datetime(raw['created_at']),
            'updated_at': native_datetime(raw['updated_at']),
            'fulfilled_at': native_datetime(raw.get('fulfilled_at')),
        }
        for name in ('test_source', 'cleanup_eligible'):
            if name in ProjectAgentRecruitmentRecord.model_fields:
                fields[name] = raw.get(name)
        return ProjectAgentRecruitmentRecord(**fields)
