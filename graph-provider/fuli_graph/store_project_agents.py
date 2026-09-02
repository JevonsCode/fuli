import hashlib
import json

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .project_agent_models import (
    ProjectAgentAssignmentCreate,
    ProjectAgentAssignmentEnd,
    ProjectAgentAssignmentRecord,
    ProjectAgentAssignmentReplace,
    ProjectAgentAssignmentReplaceResult,
    ProjectAgentExecutorPolicy,
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
    ProjectAgentRecord,
    ProjectAgentUpsert,
)
from .provider_values import native_datetime, now_utc, stable_uuid


SYSTEM_COORDINATOR_AGENT_ID = 'fuli-project-coordinator'


class StoreProjectAgents:
    async def ensure_system_project_coordinator(
        self,
        actor: dict,
        personal_space_id: str,
    ) -> ProjectAgentRecord:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'maintainer')
        profile = ProjectAgentProfile(
            name='项目协调人',
            responsibility='评估任务、选择模型策略、路由已有 Agent，并审计职责缺口。',
            agent_type='coordinator',
            work_kinds=['task-coordination'],
            capabilities=['任务评估', '模型策略', 'Agent 路由'],
            initial_preferences=['质量与可验收完成优先于成本和时间'],
            status='active',
        )
        updated_at = now_utc()
        node_id = stable_uuid(
            self.settings.provider_id,
            personal_space_id,
            'project-agent',
            SYSTEM_COORDINATOR_AGENT_ID,
        )
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (agent:FuliProjectAgent {id: $id})
            ON CREATE SET agent.agent_id = $agent_id,
                          agent.created_at = $updated_at,
                          agent.system_managed = true
            ON CREATE SET agent.profile_json = $profile_json,
                          agent.name = $name,
                          agent.occupation_emoji = $occupation_emoji,
                          agent.responsibility = $responsibility,
                          agent.capabilities = $capabilities,
                          agent.work_kinds = $work_kinds,
                          agent.agent_type = 'coordinator',
                          agent.memory_scope = 'reviewed_agent',
                          agent.status = 'active',
                          agent.updated_at = $updated_at
            MERGE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
            RETURN agent
            ''',
            personal_space_id=personal_space_id,
            id=node_id,
            agent_id=SYSTEM_COORDINATOR_AGENT_ID,
            profile_json=profile.model_dump_json(),
            name=profile.name,
            occupation_emoji=profile.occupation_emoji,
            responsibility=profile.responsibility,
            capabilities=profile.capabilities,
            work_kinds=profile.work_kinds,
            updated_at=updated_at,
        )
        return await self.get_project_agent(
            actor,
            personal_space_id,
            None,
            SYSTEM_COORDINATOR_AGENT_ID,
        )

    async def upsert_project_agent(
        self,
        actor: dict,
        request: ProjectAgentUpsert,
        *,
        recruitment_id: str | None = None,
    ) -> ProjectAgentRecord:
        self._require_personal()
        if request.profile.agent_type == 'temporary' and not recruitment_id:
            raise HTTPException(
                status_code=422,
                detail='temporary Agents must be created by an audited HR recruitment',
            )
        if (
            request.profile.agent_type == 'coordinator'
            and request.agent_id != SYSTEM_COORDINATOR_AGENT_ID
        ):
            raise HTTPException(
                status_code=422,
                detail='only the system-managed identity may use coordinator type',
            )
        if (
            request.agent_id == SYSTEM_COORDINATOR_AGENT_ID
            and request.profile.agent_type != 'coordinator'
        ):
            raise HTTPException(
                status_code=422,
                detail='the system coordinator identity cannot change Agent type',
            )
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        if request.personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                request.personal_project_id,
            )
        node_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent',
            request.agent_id,
        )
        updated_at = now_utc()
        memory_scope = (
            'task_only'
            if request.profile.agent_type == 'temporary'
            else 'reviewed_agent'
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (agent:FuliProjectAgent {id: $id})
            ON CREATE SET agent.agent_id = $agent_id,
                          agent.created_at = $updated_at,
                          agent.system_managed = false
            // Acquire the node write lock before reading lifecycle status so a
            // concurrent archive cannot be lost to this compatibility upsert.
            SET agent._profile_upsert_lock = true
            REMOVE agent._profile_upsert_lock
            WITH space, agent
            WHERE agent.status IS NULL OR agent.status <> 'archived'
            SET agent.profile_json = $profile_json,
                agent.name = $name,
                agent.occupation_emoji = $occupation_emoji,
                agent.responsibility = $responsibility,
                agent.capabilities = $capabilities,
                agent.work_kinds = $work_kinds,
                agent.agent_type = $agent_type,
                agent.memory_scope = $memory_scope,
                agent.status = $status,
                agent.test_source = $test_source,
                agent.cleanup_eligible = $cleanup_eligible,
                agent.recruitment_id = coalesce(
                  agent.recruitment_id, $recruitment_id),
                agent.updated_at = $updated_at
            MERGE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
            RETURN agent
            ''',
            personal_space_id=request.personal_space_id,
            id=node_id,
            agent_id=request.agent_id,
            profile_json=request.profile.model_dump_json(),
            name=request.profile.name,
            occupation_emoji=request.profile.occupation_emoji,
            responsibility=request.profile.responsibility,
            capabilities=request.profile.capabilities,
            work_kinds=request.profile.work_kinds,
            agent_type=request.profile.agent_type,
            memory_scope=memory_scope,
            status=request.profile.status,
            test_source=request.profile.test_source,
            cleanup_eligible=request.profile.cleanup_eligible,
            recruitment_id=recruitment_id,
            updated_at=updated_at,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail=(
                    'archived Project Agents require a dedicated restore operation'
                ),
        )
        if request.personal_project_id:
            if not await self._upsert_legacy_assignment(request, updated_at):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        'archived Project Agents require a dedicated '
                        'restore operation'
                    ),
                )
        return await self.get_project_agent(
            actor,
            request.personal_space_id,
            request.personal_project_id,
            request.agent_id,
            include_inactive_project_assignment=bool(
                request.personal_project_id
            ),
        )

    async def _upsert_legacy_assignment(
        self,
        request: ProjectAgentUpsert,
        updated_at,
    ) -> bool:
        assignment_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-assignment',
            'legacy',
            request.personal_project_id,
            request.agent_id,
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH project, agent
            WHERE agent.status <> 'archived'
            OPTIONAL MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (active_assignment:FuliProjectAgentAssignment)-
                  [:ASSIGNED_AGENT]->(agent)
            WHERE active_assignment.status = 'active'
            OPTIONAL MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (handed_off_assignment:FuliProjectAgentAssignment)-
                  [:ASSIGNED_AGENT]->(agent)
            WHERE handed_off_assignment.status = 'ended'
              AND handed_off_assignment.replaced_by_assignment_id IS NOT NULL
            WITH project, agent,
                 count(DISTINCT active_assignment) AS active_assignment_count,
                 count(DISTINCT CASE
                   WHEN active_assignment.id = $assignment_id
                   THEN active_assignment
                 END) AS legacy_assignment_count,
                 count(DISTINCT handed_off_assignment)
                   AS handed_off_assignment_count
            // An audited handoff is terminal for the backwards-compatible
            // upsert path. Reassignment must use the explicit assignment API.
            // An already-active legacy assignment may still refresh its
            // profile-backed fields even when another historical role moved.
            FOREACH (_ IN CASE
              WHEN legacy_assignment_count > 0 OR (
                     active_assignment_count = 0
                     AND handed_off_assignment_count = 0
                   )
              THEN [1] ELSE [] END |
              MERGE (assignment:FuliProjectAgentAssignment {id: $assignment_id})
              ON CREATE SET assignment.assignment_id = $assignment_id,
                            assignment.assigned_at = $updated_at,
                            assignment.revision = 0,
                            assignment.reason = 'legacy project Agent profile'
              SET assignment.revision = CASE
                    WHEN assignment.status IS NOT NULL
                         AND assignment.status <> 'active'
                    THEN coalesce(assignment.revision, 0) + 1
                    ELSE coalesce(assignment.revision, 0)
                  END,
                  assignment.ended_at = NULL,
                  assignment.end_reason = NULL,
                  assignment.replaced_by_assignment_id = NULL
              SET assignment.responsibility = $responsibility,
                  assignment.work_kinds = $work_kinds,
                  assignment.capabilities = $capabilities,
                  assignment.model_strategy_json = $model_strategy_json,
                  assignment.executor_policy_json = $executor_policy_json,
                  assignment.status = 'active',
                  assignment.updated_at = $updated_at
              MERGE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment)
              MERGE (assignment)-[:ASSIGNED_AGENT]->(agent)
            )
            RETURN agent.agent_id AS agent_id
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            agent_id=request.agent_id,
            assignment_id=assignment_id,
            responsibility=request.profile.responsibility,
            work_kinds=request.profile.work_kinds,
            capabilities=request.profile.capabilities,
            model_strategy_json=None,
            executor_policy_json=(
                request.profile.executor_policy.model_dump_json()
                if request.profile.executor_policy.mode == 'locked'
                   or request.profile.executor_policy.preferred_executor_ids
                else None
            ),
            updated_at=updated_at,
        )
        return bool(records)

    async def list_project_agents(
        self,
        actor: dict,
        personal_space_id: str,
        personal_project_id: str | None = None,
        *,
        status: str | None = None,
        capability: str | None = None,
    ) -> list[ProjectAgentRecord]:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                personal_project_id,
            )
        records = await self._project_agent_rows(
            personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=None,
            status=status,
            capability=capability,
        )
        return [
            self._project_agent_from_row(row, personal_space_id, personal_project_id)
            for row in records
        ]

    async def get_project_agent(
        self,
        actor: dict,
        personal_space_id: str,
        personal_project_id: str | None,
        agent_id: str,
        *,
        include_inactive_project_assignment: bool = False,
    ) -> ProjectAgentRecord:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                personal_project_id,
            )
        records = await self._project_agent_rows(
            personal_space_id,
            personal_project_id=(
                None
                if include_inactive_project_assignment
                else personal_project_id
            ),
            agent_id=agent_id,
            status=None,
            capability=None,
        )
        if not records:
            raise HTTPException(status_code=404, detail='project Agent not found')
        if personal_project_id and not any(
            dict(item).get('personal_project_id') == personal_project_id
            for item in records[0].get('assignment_rows') or []
        ):
            raise HTTPException(status_code=404, detail='project Agent not found')
        return self._project_agent_from_row(
            records[0],
            personal_space_id,
            personal_project_id,
        )

    async def archive_project_agent(
        self,
        actor: dict,
        personal_space_id: str,
        agent_id: str,
        *,
        reason: str,
    ) -> ProjectAgentRecord:
        """Archive one reusable identity while preserving every audit edge."""

        self._require_personal()
        if agent_id == SYSTEM_COORDINATOR_AGENT_ID:
            raise HTTPException(
                status_code=422,
                detail='the system coordinator cannot be archived',
            )
        await self.authorize(actor, personal_space_id, 'maintainer')
        if not reason.strip():
            raise HTTPException(status_code=422, detail='archive reason is required')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            // Serialize task-participant creation with lifecycle termination.
            // The lock must be taken before the open-work snapshot is read.
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH space, agent
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask)-
                  [participant:HAS_PARTICIPANT]->(agent)
            WITH space, agent, collect(DISTINCT {
              task_id: task.task_id,
              status: participant.status
            }) AS tasks
            WITH space, agent, [item IN tasks
                         WHERE item.task_id IS NOT NULL
                           AND item.status IN [
                             'awaiting_recruitment', 'queued', 'running',
                             'paused', 'blocked', 'awaiting_review'
                           ]] AS open_tasks
            WHERE agent.status = 'archived' OR size(open_tasks) = 0
            SET agent.status = 'archived',
                agent.archive_reason = coalesce(agent.archive_reason, $reason),
                agent.archived_at = coalesce(agent.archived_at, $updated_at),
                agent.updated_at = $updated_at
            WITH space, agent
            OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->
                           (:FuliPersonalProject)-
                           [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                           (assignment:FuliProjectAgentAssignment {status: 'active'})-
                           [:ASSIGNED_AGENT]->(agent)
            SET assignment.status = 'ended',
                assignment.end_reason = $reason,
                assignment.ended_at = $updated_at,
                assignment.updated_at = $updated_at,
                assignment.revision = coalesce(assignment.revision, 0) + 1
            RETURN agent
            ''',
            personal_space_id=personal_space_id,
            agent_id=agent_id,
            reason=reason.strip(),
            updated_at=now_utc(),
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='Agent is missing or still has non-terminal task work',
            )
        return await self.get_project_agent(
            actor,
            personal_space_id,
            None,
            agent_id,
        )

    async def _project_agent_rows(
        self,
        personal_space_id: str,
        *,
        personal_project_id: str | None,
        agent_id: str | None,
        status: str | None,
        capability: str | None,
    ):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
            WHERE ($agent_id IS NULL OR agent.agent_id = $agent_id)
              AND ($status IS NULL OR agent.status = $status)
              AND (
                $personal_project_id IS NULL
                OR EXISTS {
                  MATCH (space)-[:CONTAINS_PROJECT]->
                        (:FuliPersonalProject {project_id: $personal_project_id})-
                        [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                        (:FuliProjectAgentAssignment {status: 'active'})-
                        [:ASSIGNED_AGENT]->(agent)
                }
              )
              AND (
                $capability IS NULL
                OR any(item IN coalesce(agent.capabilities, [])
                       WHERE toLower(item) CONTAINS toLower($capability))
                OR toLower(agent.responsibility) CONTAINS toLower($capability)
                OR EXISTS {
                  MATCH (space)-[:CONTAINS_PROJECT]->
                        (:FuliPersonalProject)-
                        [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                        (assignment:FuliProjectAgentAssignment)-
                        [:ASSIGNED_AGENT]->(agent)
                  WHERE any(item IN coalesce(assignment.capabilities, [])
                            WHERE toLower(item) CONTAINS toLower($capability))
                     OR toLower(assignment.responsibility)
                        CONTAINS toLower($capability)
                }
              )
            OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject)-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment)-
                  [:ASSIGNED_AGENT]->(agent)
            WITH space, agent, collect(DISTINCT {
              assignment: assignment,
              personal_project_id: project.project_id
            }) AS all_assignment_rows
            WITH space, agent,
                 [item IN all_assignment_rows
                  WHERE $personal_project_id IS NULL
                     OR item.personal_project_id = $personal_project_id]
                   AS assignment_rows
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask)-
                  [participant:HAS_PARTICIPANT]->(agent)
            WITH space, agent, assignment_rows,
                 collect(DISTINCT {
                   task_id: task.task_id,
                   personal_project_id: task.personal_project_id,
                   status: participant.status,
                   updated_at: participant.updated_at,
                   source_application: task.source_application
                 }) AS all_task_rows,
                 collect(DISTINCT {
                   personal_project_id: task.personal_project_id,
                   source_application: task.source_application
                 }) AS all_task_client_rows
            WITH space, agent, assignment_rows,
                 [item IN all_task_rows
                  WHERE $personal_project_id IS NULL
                     OR item.personal_project_id = $personal_project_id]
                   AS task_rows,
                 [item IN all_task_client_rows
                  WHERE ($personal_project_id IS NULL
                         OR item.personal_project_id = $personal_project_id)
                    AND item.source_application IS NOT NULL]
                   AS task_client_rows
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (event_task:FuliProjectAgentTask)-[:HAS_TASK_EVENT]->
                  (event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)
            WITH agent,
                 assignment_rows,
                 task_rows,
                 task_client_rows,
                 collect(DISTINCT {
                   personal_project_id: event_task.personal_project_id,
                   source_application: event.source_application
                 }) AS all_event_client_rows
            WITH agent,
                 assignment_rows,
                 task_rows,
                 task_client_rows,
                 [item IN all_event_client_rows
                  WHERE ($personal_project_id IS NULL
                         OR item.personal_project_id = $personal_project_id)
                    AND item.source_application IS NOT NULL]
                   AS event_client_rows
            RETURN agent,
                   assignment_rows,
                   task_rows,
                   [item IN task_client_rows | item.source_application]
                     + [item IN event_client_rows | item.source_application]
                     AS observed_clients,
                   task_client_rows + event_client_rows AS observed_client_rows
            ORDER BY CASE agent.agent_type
                       WHEN 'coordinator' THEN 0
                       WHEN 'hr' THEN 1
                       WHEN 'durable' THEN 2
                       ELSE 3
                     END,
                     agent.name,
                     agent.agent_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            status=status,
            capability=capability,
            routing_='r',
        )
        return records

    async def create_project_agent_assignment(
        self,
        actor: dict,
        request: ProjectAgentAssignmentCreate,
    ) -> ProjectAgentAssignmentRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        await authorize_project_agent(
            self,
            actor,
            space,
            request.personal_project_id,
            request.agent_id,
            require_active=True,
            allow_unassigned=True,
        )
        assignment_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-assignment',
            request.idempotency_key,
        )
        payload_hash = self._assignment_payload_hash(request)
        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH project, agent
            WHERE agent.status = 'active'
            MERGE (assignment:FuliProjectAgentAssignment {id: $assignment_id})
            ON CREATE SET assignment.assignment_id = $assignment_id,
                          assignment.payload_hash = $payload_hash,
                          assignment.responsibility = $responsibility,
                          assignment.work_kinds = $work_kinds,
                          assignment.capabilities = $capabilities,
                          assignment.model_strategy_json = $model_strategy_json,
                          assignment.executor_policy_json =
                            $executor_policy_json,
                          assignment.reason = $reason,
                          assignment.status = 'active',
                          assignment.revision = 0,
                          assignment.source_application = $source_application,
                          assignment.source_session_id = $source_session_id,
                          assignment.assigned_at = $updated_at,
                          assignment.updated_at = $updated_at
            WITH project, agent, assignment,
                 assignment.payload_hash = $payload_hash AS payload_matches
            FOREACH (_ IN CASE WHEN payload_matches THEN [1] ELSE [] END |
              MERGE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment)
              MERGE (assignment)-[:ASSIGNED_AGENT]->(agent)
            )
            RETURN assignment, project.project_id AS personal_project_id,
                   agent.agent_id AS agent_id, payload_matches
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            agent_id=request.agent_id,
            assignment_id=assignment_id,
            payload_hash=payload_hash,
            responsibility=request.responsibility,
            work_kinds=request.work_kinds,
            capabilities=request.capabilities,
            model_strategy_json=(
                request.model_strategy_override.model_dump_json()
                if request.model_strategy_override
                else None
            ),
            executor_policy_json=(
                request.executor_policy_override.model_dump_json()
                if request.executor_policy_override else None
            ),
            reason=request.reason,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            updated_at=updated_at,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='project Agent is not active or is unavailable',
            )
        assignment = dict(records[0]['assignment'])
        if assignment.get('payload_hash') != payload_hash:
            raise HTTPException(
                status_code=409,
                detail='assignment idempotency key was used with different input',
            )
        return self._assignment(
            assignment,
            request.personal_space_id,
            records[0]['personal_project_id'],
            records[0]['agent_id'],
        )

    async def list_project_agent_assignments(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        personal_project_id: str | None = None,
        agent_id: str | None = None,
        status: str | None = None,
    ) -> list[ProjectAgentAssignmentRecord]:
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
                  [:CONTAINS_PROJECT]->(project:FuliPersonalProject)-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment)-
                  [:ASSIGNED_AGENT]->(agent:FuliProjectAgent)
            WHERE ($personal_project_id IS NULL
                   OR project.project_id = $personal_project_id)
              AND ($agent_id IS NULL OR agent.agent_id = $agent_id)
              AND ($status IS NULL OR assignment.status = $status)
            RETURN assignment, project.project_id AS personal_project_id,
                   agent.agent_id AS agent_id
            ORDER BY assignment.assigned_at DESC, assignment.assignment_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            status=status,
            routing_='r',
        )
        return [
            self._assignment(
                dict(row['assignment']),
                personal_space_id,
                row['personal_project_id'],
                row['agent_id'],
            )
            for row in records
        ]

    async def end_project_agent_assignment(
        self,
        actor: dict,
        request: ProjectAgentAssignmentEnd,
    ) -> ProjectAgentAssignmentRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment {
                    assignment_id: $assignment_id
                  })-[:ASSIGNED_AGENT]->(agent:FuliProjectAgent)
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH project, assignment, agent
            WHERE assignment.status = 'active'
              AND coalesce(assignment.revision, 0) = $expected_revision
            SET assignment.status = 'ended',
                assignment.end_reason = $reason,
                assignment.ended_at = $updated_at,
                assignment.updated_at = $updated_at,
                assignment.revision = coalesce(assignment.revision, 0) + 1
            RETURN assignment, project.project_id AS personal_project_id,
                   agent.agent_id AS agent_id
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            assignment_id=request.assignment_id,
            expected_revision=request.expected_revision,
            reason=request.reason,
            updated_at=updated_at,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='assignment is not active or revision is stale',
            )
        row = records[0]
        return self._assignment(
            dict(row['assignment']),
            request.personal_space_id,
            row['personal_project_id'],
            row['agent_id'],
        )

    async def replace_project_agent_assignment(
        self,
        actor: dict,
        request: ProjectAgentAssignmentReplace,
    ) -> ProjectAgentAssignmentReplaceResult:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        await authorize_project_agent(
            self,
            actor,
            space,
            request.personal_project_id,
            request.replacement_agent_id,
            require_active=False,
            allow_unassigned=True,
        )
        replacement_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-assignment',
            request.idempotency_key,
        )
        payload_hash = self._assignment_payload_hash(request)
        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (ended:FuliProjectAgentAssignment {
                    assignment_id: $assignment_id
                  })-[:ASSIGNED_AGENT]->(ended_agent:FuliProjectAgent)
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (replacement_agent:FuliProjectAgent {
                    agent_id: $replacement_agent_id
                  })
            WITH project, ended, ended_agent, replacement_agent,
                 CASE
                   WHEN ended_agent.agent_id <= replacement_agent.agent_id
                   THEN [ended_agent, replacement_agent]
                   ELSE [replacement_agent, ended_agent]
                 END AS lifecycle_agents
            UNWIND lifecycle_agents AS lifecycle_agent
            SET lifecycle_agent._task_lifecycle_lock = true
            REMOVE lifecycle_agent._task_lifecycle_lock
            WITH project, ended, ended_agent, replacement_agent,
                 collect(lifecycle_agent) AS locked_agents
            OPTIONAL MATCH (existing_replacement:FuliProjectAgentAssignment {
              id: $replacement_id
            })
            WITH project, ended, ended_agent, replacement_agent,
                 existing_replacement
            WHERE existing_replacement IS NOT NULL
               OR (replacement_agent.status = 'active'
                   AND ended_agent.status = 'active'
                   AND ended.status = 'active'
                   AND coalesce(ended.revision, 0) = $expected_revision)
               OR (ended.status = 'ended'
                   AND coalesce(ended.revision, 0) = $expected_revision + 1
                   AND ended.replaced_by_assignment_id = $replacement_id)
            MERGE (replacement:FuliProjectAgentAssignment {id: $replacement_id})
            ON CREATE SET replacement.assignment_id = $replacement_id,
                          replacement.payload_hash = $payload_hash,
                          replacement.responsibility = $responsibility,
                          replacement.work_kinds = $work_kinds,
                          replacement.capabilities = $capabilities,
                          replacement.model_strategy_json = $model_strategy_json,
                          replacement.executor_policy_json =
                            $executor_policy_json,
                          replacement.reason = $reason,
                          replacement.status = 'active',
                          replacement.revision = 0,
                          replacement.source_application = $source_application,
                          replacement.source_session_id = $source_session_id,
                          replacement.assigned_at = $updated_at,
                          replacement.updated_at = $updated_at
            WITH project, ended, ended_agent, replacement_agent, replacement,
                 replacement.payload_hash = $payload_hash AS payload_matches,
                 (replacement_agent.status = 'active'
                  AND ended_agent.status = 'active'
                  AND ended.status = 'active'
                  AND coalesce(ended.revision, 0) = $expected_revision)
                    AS can_apply,
                 (ended.status = 'ended'
                  AND coalesce(ended.revision, 0) = $expected_revision + 1
                  AND ended.replaced_by_assignment_id = $replacement_id)
                    AS exact_replay
            FOREACH (_ IN CASE
              WHEN payload_matches AND can_apply THEN [1] ELSE [] END |
              MERGE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(replacement)
              MERGE (replacement)-[:ASSIGNED_AGENT]->(replacement_agent)
              SET ended.status = 'ended',
                  ended.end_reason = $reason,
                  ended.ended_at = $updated_at,
                  ended.updated_at = $updated_at,
                  ended.replaced_by_assignment_id = $replacement_id,
                  ended.revision = coalesce(ended.revision, 0) + 1
            )
            RETURN ended, replacement,
                   ended_agent.agent_id AS ended_agent_id,
                   replacement_agent.agent_id AS replacement_agent_id,
                   payload_matches, can_apply, exact_replay
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            assignment_id=request.assignment_id,
            expected_revision=request.expected_revision,
            replacement_agent_id=request.replacement_agent_id,
            replacement_id=replacement_id,
            payload_hash=payload_hash,
            responsibility=request.responsibility,
            work_kinds=request.work_kinds,
            capabilities=request.capabilities,
            model_strategy_json=(
                request.model_strategy_override.model_dump_json()
                if request.model_strategy_override
                else None
            ),
            executor_policy_json=(
                request.executor_policy_override.model_dump_json()
                if request.executor_policy_override else None
            ),
            reason=request.reason,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            updated_at=updated_at,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='assignment is not active or revision is stale',
            )
        row = records[0]
        if row.get('payload_matches') is not True:
            raise HTTPException(
                status_code=409,
                detail='assignment idempotency key was used with different input',
            )
        if row.get('can_apply') is not True and row.get('exact_replay') is not True:
            raise HTTPException(
                status_code=409,
                detail='assignment is not active or revision is stale',
            )
        ended_raw = dict(row['ended'])
        return ProjectAgentAssignmentReplaceResult(
            ended=self._assignment(
                ended_raw,
                request.personal_space_id,
                request.personal_project_id,
                row['ended_agent_id'],
            ),
            replacement=self._assignment(
                dict(row['replacement']),
                request.personal_space_id,
                request.personal_project_id,
                row['replacement_agent_id'],
            ),
        )

    @staticmethod
    def _assignment_payload_hash(
        request: ProjectAgentAssignmentCreate | ProjectAgentAssignmentReplace,
    ) -> str:
        payload = request.model_dump(mode='json', exclude={'idempotency_key'})
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        ).hexdigest()

    def _project_agent_from_row(
        self,
        row,
        personal_space_id: str,
        projection_project_id: str | None,
    ) -> ProjectAgentRecord:
        raw = dict(row['agent'])
        profile = ProjectAgentProfile.model_validate_json(raw['profile_json'])
        # ``occupation_emoji`` was introduced after the original profile JSON
        # contract.  Prefer the durable profile value, but tolerate an older
        # JSON payload while the explicit node property is being backfilled.
        occupation_emoji = raw.get('occupation_emoji') or raw.get(
            'occupationEmoji'
        )
        if not profile.occupation_emoji and occupation_emoji:
            profile = profile.model_copy(
                update={'occupation_emoji': occupation_emoji}
            )
        if raw.get('status') and profile.status != raw['status']:
            profile = profile.model_copy(update={'status': raw['status']})
        assignments = []
        for item in row.get('assignment_rows') or []:
            value = dict(item)
            assignment_raw = value.get('assignment')
            project_id = value.get('personal_project_id')
            if (
                assignment_raw is None
                or not project_id
                or (
                    projection_project_id is not None
                    and project_id != projection_project_id
                )
            ):
                continue
            assignments.append(
                self._assignment(
                    dict(assignment_raw),
                    personal_space_id,
                    project_id,
                    raw['agent_id'],
                )
            )
        assignments.sort(key=lambda item: item.assigned_at, reverse=True)
        nonterminal = {
            'awaiting_recruitment',
            'queued',
            'running',
            'paused',
            'blocked',
            'awaiting_review',
        }
        tasks = [
            dict(value)
            for value in (row.get('task_rows') or [])
            if value
            and value.get('task_id')
            and value.get('status') in nonterminal
            and (
                projection_project_id is None
                or value.get('personal_project_id') == projection_project_id
            )
        ]
        priority = {
            'running': 0,
            'awaiting_review': 1,
            'blocked': 2,
            'paused': 3,
            'queued': 4,
            'awaiting_recruitment': 5,
        }
        tasks.sort(
            key=lambda item: (
                priority.get(item.get('status'), 99),
                -(native_datetime(item['updated_at']).timestamp()
                  if item.get('updated_at') else 0),
            )
        )
        work_status = (
            'ended'
            if profile.status == 'archived'
            else (tasks[0]['status'] if tasks else 'idle')
        )
        observed_client_rows = row.get('observed_client_rows')
        if projection_project_id is not None:
            observed_values = [
                dict(value).get('source_application')
                for value in observed_client_rows or []
                if dict(value).get('personal_project_id') == projection_project_id
            ]
        else:
            observed_values = row.get('observed_clients') or []
        observed_clients = sorted({
            value
            for value in observed_values
            if value in {
                'codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other'
            }
        })
        return ProjectAgentRecord(
            agent_id=raw['agent_id'],
            personal_space_id=personal_space_id,
            personal_project_id=projection_project_id,
            profile=profile,
            executor_policy=profile.executor_policy,
            memory_scope=raw.get('memory_scope') or (
                'task_only' if profile.agent_type == 'temporary' else 'reviewed_agent'
            ),
            assignments=assignments,
            recruitment_id=raw.get('recruitment_id'),
            temporary_task_id=raw.get('temporary_task_id'),
            work_status=work_status,
            open_task_count=len(tasks),
            current_task_id=tasks[0]['task_id'] if tasks else None,
            observed_clients=observed_clients,
            recruited_at=(
                native_datetime(raw['recruited_at'])
                if raw.get('recruited_at') else None
            ),
            recruitment_reason=raw.get('recruitment_reason'),
            recruitment_source_application=raw.get(
                'recruitment_source_application'
            ),
            created_at=native_datetime(raw['created_at']),
            updated_at=native_datetime(raw['updated_at']),
        )

    def _assignment(
        self,
        raw: dict,
        personal_space_id: str,
        personal_project_id: str,
        agent_id: str,
    ) -> ProjectAgentAssignmentRecord:
        model_strategy_json = raw.get('model_strategy_json')
        executor_policy_json = raw.get('executor_policy_json')
        return ProjectAgentAssignmentRecord(
            assignment_id=raw.get('assignment_id') or raw['id'],
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=raw.get('agent_id') or agent_id,
            responsibility=raw['responsibility'],
            work_kinds=list(raw.get('work_kinds') or []),
            capabilities=list(raw.get('capabilities') or []),
            model_strategy_override=(
                ProjectAgentModelStrategy.model_validate_json(model_strategy_json)
                if model_strategy_json else None
            ),
            executor_policy_override=(
                ProjectAgentExecutorPolicy.model_validate_json(executor_policy_json)
                if executor_policy_json else None
            ),
            reason=raw.get('reason') or 'assignment created',
            status=raw.get('status') or 'active',
            revision=int(raw.get('revision') or 0),
            source_application=raw.get('source_application'),
            source_session_id=raw.get('source_session_id'),
            assigned_at=native_datetime(raw['assigned_at']),
            updated_at=native_datetime(raw.get('updated_at') or raw['assigned_at']),
            ended_at=(
                native_datetime(raw['ended_at'])
                if raw.get('ended_at') else None
            ),
            end_reason=raw.get('end_reason'),
            replaced_by_assignment_id=raw.get('replaced_by_assignment_id'),
        )
