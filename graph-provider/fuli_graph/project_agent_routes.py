"""HTTP route registration for the Project Agent collaboration control plane."""

from datetime import date
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query

from .project_agent_models import (
    ProjectAgentAssignmentCreate,
    ProjectAgentAssignmentEnd,
    ProjectAgentAssignmentRecord,
    ProjectAgentAssignmentReplace,
    ProjectAgentAssignmentReplaceResult,
    ProjectAgentRecord,
    ProjectAgentStatus,
    ProjectAgentUpsert,
)
from .project_agent_executor_models import (
    ProjectAgentExecutorActualReport,
    ProjectAgentExecutorAuthorization,
    ProjectAgentExecutorEvidenceIgnore,
    ProjectAgentExecutorHealthReport,
    ProjectAgentExecutorOutcomeAggregate,
    ProjectAgentExecutorOutcomeEvidenceCreate,
    ProjectAgentExecutorOutcomeEvidenceRecord,
    ProjectAgentExecutorOutcomeReset,
    ProjectAgentExecutorPreflightReport,
    ProjectAgentExecutorPriorityUpdate,
    ProjectAgentExecutorRecord,
    ProjectAgentExecutorRegistration,
    ProjectAgentExecutorRoutingRuleCreate,
    ProjectAgentExecutorRoutingRuleRecord,
    ProjectAgentExecutorRoutingRuleUpdate,
    ProjectAgentExecutorScope,
)
from .project_agent_coordination_models import (
    ProjectAgentCoordinationPolicyRecord,
    ProjectAgentCoordinationPolicyUpdate,
)
from .project_agent_task_models import (
    ProjectAgentActivityResult,
    ProjectAgentRecruitmentDecision,
    ProjectAgentRecruitmentPolicyRecord,
    ProjectAgentRecruitmentPolicyUpdate,
    ProjectAgentRecruitmentRecord,
    ProjectAgentTaskActivityCreate,
    ProjectAgentTaskRecord,
    ProjectAgentTaskRouteResult,
    ProjectAgentTaskSubmit,
)


def register_project_agent_routes(
    application: FastAPI,
    store: Any,
    Actor: Any,
) -> None:
    """Attach Project Agent routes while keeping ``create_app`` orchestration small."""

    @application.put('/v1/project-agents', response_model=ProjectAgentRecord)
    async def upsert_project_agent(
        request: ProjectAgentUpsert,
        actor: Actor,
    ) -> ProjectAgentRecord:
        return await store.upsert_project_agent(actor, request)

    @application.get('/v1/project-agents', response_model=list[ProjectAgentRecord])
    async def list_project_agents(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        status: Annotated[ProjectAgentStatus | None, Query()] = None,
        capability: Annotated[
            str | None,
            Query(min_length=1, max_length=512),
        ] = None,
    ) -> list[ProjectAgentRecord]:
        return await store.list_project_agents(
            actor,
            personal_space_id,
            personal_project_id,
            status=status,
            capability=capability,
        )

    @application.get(
        '/v1/project-agents/{agent_id}',
        response_model=ProjectAgentRecord,
    )
    async def get_project_agent(
        agent_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
    ) -> ProjectAgentRecord:
        return await store.get_project_agent(
            actor,
            personal_space_id,
            personal_project_id,
            agent_id,
        )

    @application.delete(
        '/v1/project-agents/{agent_id}',
        response_model=ProjectAgentRecord,
    )
    async def archive_project_agent(
        agent_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        reason: Annotated[str, Query(min_length=1, max_length=2048)] = 'archived by user',
    ) -> ProjectAgentRecord:
        return await store.archive_project_agent(
            actor,
            personal_space_id,
            agent_id,
            reason=reason,
        )

    @application.post(
        '/v1/project-agents/system-coordinator',
        response_model=ProjectAgentRecord,
    )
    async def ensure_project_agent_coordinator(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> ProjectAgentRecord:
        return await store.ensure_system_project_coordinator(actor, personal_space_id)

    @application.post(
        '/v1/project-agent-assignments',
        response_model=ProjectAgentAssignmentRecord,
    )
    async def create_project_agent_assignment(
        request: ProjectAgentAssignmentCreate,
        actor: Actor,
    ) -> ProjectAgentAssignmentRecord:
        return await store.create_project_agent_assignment(actor, request)

    @application.get(
        '/v1/project-agent-assignments',
        response_model=list[ProjectAgentAssignmentRecord],
    )
    async def list_project_agent_assignments(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        agent_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        status: Annotated[str | None, Query()] = None,
    ) -> list[ProjectAgentAssignmentRecord]:
        return await store.list_project_agent_assignments(
            actor,
            personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            status=status,
        )

    @application.post(
        '/v1/project-agent-assignments/end',
        response_model=ProjectAgentAssignmentRecord,
    )
    async def end_project_agent_assignment(
        request: ProjectAgentAssignmentEnd,
        actor: Actor,
    ) -> ProjectAgentAssignmentRecord:
        return await store.end_project_agent_assignment(actor, request)

    @application.post(
        '/v1/project-agent-assignments/replace',
        response_model=ProjectAgentAssignmentReplaceResult,
    )
    async def replace_project_agent_assignment(
        request: ProjectAgentAssignmentReplace,
        actor: Actor,
    ) -> ProjectAgentAssignmentReplaceResult:
        return await store.replace_project_agent_assignment(actor, request)

    @application.post(
        '/v1/project-agent-tasks',
        response_model=ProjectAgentTaskRouteResult,
    )
    async def submit_project_agent_task(
        request: ProjectAgentTaskSubmit,
        actor: Actor,
    ) -> ProjectAgentTaskRouteResult:
        return await store.submit_project_agent_task(actor, request)

    @application.get(
        '/v1/project-agent-tasks',
        response_model=list[ProjectAgentTaskRecord],
    )
    async def list_project_agent_tasks(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        agent_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        status: Annotated[str | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
    ) -> list[ProjectAgentTaskRecord]:
        return await store.list_project_agent_tasks(
            actor,
            personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            status=status,
            limit=limit,
        )

    @application.get(
        '/v1/project-agent-tasks/{task_id}',
        response_model=ProjectAgentTaskRecord,
    )
    async def get_project_agent_task(
        task_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> ProjectAgentTaskRecord:
        return await store.get_project_agent_task(actor, personal_space_id, task_id)

    @application.post(
        '/v1/project-agent-tasks/{task_id}/events',
        response_model=ProjectAgentTaskRecord,
    )
    async def record_project_agent_task_activity(
        task_id: str,
        request: ProjectAgentTaskActivityCreate,
        actor: Actor,
    ) -> ProjectAgentTaskRecord:
        if task_id != request.task_id:
            raise HTTPException(status_code=422, detail='task ID does not match path')
        return await store.record_project_agent_task_activity(actor, request)

    @application.get(
        '/v1/project-agents/{agent_id}/activity',
        response_model=ProjectAgentActivityResult,
    )
    async def get_project_agent_activity(
        agent_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        from_date: Annotated[date, Query(alias='from')],
        to_date: Annotated[date, Query(alias='to')],
    ) -> ProjectAgentActivityResult:
        return await store.get_project_agent_activity(
            actor,
            personal_space_id,
            agent_id,
            from_date,
            to_date,
        )

    @application.get(
        '/v1/project-agent-coordination-policy',
        response_model=ProjectAgentCoordinationPolicyRecord,
    )
    async def get_project_agent_coordination_policy(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> ProjectAgentCoordinationPolicyRecord:
        return await store.get_project_agent_coordination_policy(
            actor,
            personal_space_id,
            personal_project_id,
        )

    @application.put(
        '/v1/project-agent-coordination-policy',
        response_model=ProjectAgentCoordinationPolicyRecord,
    )
    async def update_project_agent_coordination_policy(
        request: ProjectAgentCoordinationPolicyUpdate,
        actor: Actor,
    ) -> ProjectAgentCoordinationPolicyRecord:
        return await store.update_project_agent_coordination_policy(actor, request)

    @application.get(
        '/v1/project-agent-recruitment-policy',
        response_model=ProjectAgentRecruitmentPolicyRecord,
    )
    async def get_project_agent_recruitment_policy(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> ProjectAgentRecruitmentPolicyRecord:
        return await store.get_project_agent_recruitment_policy(
            actor,
            personal_space_id,
        )

    @application.put(
        '/v1/project-agent-recruitment-policy',
        response_model=ProjectAgentRecruitmentPolicyRecord,
    )
    async def update_project_agent_recruitment_policy(
        request: ProjectAgentRecruitmentPolicyUpdate,
        actor: Actor,
    ) -> ProjectAgentRecruitmentPolicyRecord:
        return await store.update_project_agent_recruitment_policy(actor, request)

    @application.get(
        '/v1/project-agent-recruitments',
        response_model=list[ProjectAgentRecruitmentRecord],
    )
    async def list_project_agent_recruitments(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        task_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        status: Annotated[str | None, Query()] = None,
    ) -> list[ProjectAgentRecruitmentRecord]:
        return await store.list_project_agent_recruitments(
            actor,
            personal_space_id,
            personal_project_id=personal_project_id,
            task_id=task_id,
            status=status,
        )

    @application.post(
        '/v1/project-agent-recruitments/{recruitment_id}/decision',
        response_model=ProjectAgentRecruitmentRecord,
    )
    async def decide_project_agent_recruitment(
        recruitment_id: str,
        request: ProjectAgentRecruitmentDecision,
        actor: Actor,
    ) -> ProjectAgentRecruitmentRecord:
        if recruitment_id != request.recruitment_id:
            raise HTTPException(
                status_code=422,
                detail='recruitment ID does not match path',
            )
        return await store.decide_project_agent_recruitment(actor, request)

    @application.put('/v1/executors', response_model=ProjectAgentExecutorRecord)
    async def upsert_project_agent_executor(
        request: ProjectAgentExecutorRegistration,
        actor: Actor,
    ) -> ProjectAgentExecutorRecord:
        return await store.upsert_project_agent_executor(actor, request)

    @application.get('/v1/executors', response_model=list[ProjectAgentExecutorRecord])
    async def list_project_agent_executors(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        capability: Annotated[
            str | None,
            Query(min_length=1, max_length=512),
        ] = None,
        available_only: Annotated[bool, Query()] = False,
    ) -> list[ProjectAgentExecutorRecord]:
        return await store.list_project_agent_executors(
            actor,
            personal_space_id,
            capability=capability,
            available_only=available_only,
        )

    @application.post(
        '/v1/executors/authorization',
        response_model=ProjectAgentExecutorRecord,
    )
    async def authorize_project_agent_executor(
        request: ProjectAgentExecutorAuthorization,
        actor: Actor,
    ) -> ProjectAgentExecutorRecord:
        return await store.authorize_project_agent_executor(actor, request)

    @application.post(
        '/v1/executors/preflight',
        response_model=ProjectAgentExecutorRecord,
    )
    async def record_project_agent_executor_preflight(
        request: ProjectAgentExecutorPreflightReport,
        actor: Actor,
    ) -> ProjectAgentExecutorRecord:
        return await store.record_project_agent_executor_preflight(actor, request)

    @application.post(
        '/v1/executors/health',
        response_model=ProjectAgentExecutorRecord,
    )
    async def record_project_agent_executor_health(
        request: ProjectAgentExecutorHealthReport,
        actor: Actor,
    ) -> ProjectAgentExecutorRecord:
        return await store.record_project_agent_executor_health(actor, request)

    @application.patch(
        '/v1/executors/priority',
        response_model=ProjectAgentExecutorRecord,
    )
    async def update_project_agent_executor_priority(
        request: ProjectAgentExecutorPriorityUpdate,
        actor: Actor,
    ) -> ProjectAgentExecutorRecord:
        return await store.update_project_agent_executor_priority(actor, request)

    @application.get(
        '/v1/executors/{executor_id}',
        response_model=ProjectAgentExecutorRecord,
    )
    async def get_project_agent_executor(
        executor_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> ProjectAgentExecutorRecord:
        return await store.get_project_agent_executor(
            actor,
            personal_space_id,
            executor_id,
        )

    @application.delete(
        '/v1/executors/{executor_id}',
        response_model=ProjectAgentExecutorRecord,
    )
    async def archive_project_agent_executor(
        executor_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        reason: Annotated[str, Query(min_length=1, max_length=2048)] = 'archived by user',
    ) -> ProjectAgentExecutorRecord:
        return await store.archive_project_agent_executor(
            actor,
            personal_space_id,
            executor_id,
            reason=reason,
        )

    @application.put(
        '/v1/executor-routing-rules',
        response_model=ProjectAgentExecutorRoutingRuleRecord,
    )
    async def create_project_agent_executor_routing_rule(
        request: ProjectAgentExecutorRoutingRuleCreate,
        actor: Actor,
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        return await store.create_project_agent_executor_routing_rule(actor, request)

    @application.get(
        '/v1/executor-routing-rules',
        response_model=list[ProjectAgentExecutorRoutingRuleRecord],
    )
    async def list_project_agent_executor_routing_rules(
        actor: Actor,
        personal_space_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        task_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        scope: Annotated[ProjectAgentExecutorScope | None, Query()] = None,
        status: Annotated[str | None, Query()] = None,
    ) -> list[ProjectAgentExecutorRoutingRuleRecord]:
        return await store.list_project_agent_executor_routing_rules(
            actor,
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            task_id=task_id,
            scope=scope,
            status=status,
        )

    @application.patch(
        '/v1/executor-routing-rules/{rule_id}',
        response_model=ProjectAgentExecutorRoutingRuleRecord,
    )
    async def update_project_agent_executor_routing_rule(
        rule_id: str,
        request: ProjectAgentExecutorRoutingRuleUpdate,
        actor: Actor,
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        if rule_id != request.rule_id:
            raise HTTPException(status_code=422, detail='routing rule ID does not match path')
        return await store.update_project_agent_executor_routing_rule(actor, request)

    @application.get(
        '/v1/executor-routing-rules/{rule_id}',
        response_model=ProjectAgentExecutorRoutingRuleRecord,
    )
    async def get_project_agent_executor_routing_rule(
        rule_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        return await store.get_project_agent_executor_routing_rule(
            actor,
            personal_space_id,
            rule_id,
        )

    @application.delete(
        '/v1/executor-routing-rules/{rule_id}',
        response_model=ProjectAgentExecutorRoutingRuleRecord,
    )
    async def archive_project_agent_executor_routing_rule(
        rule_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        reason: Annotated[str, Query(min_length=1, max_length=2048)] = 'archived by user',
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        return await store.archive_project_agent_executor_routing_rule(
            actor,
            personal_space_id,
            rule_id,
            reason=reason,
        )

    @application.post(
        '/v1/project-agent-executor-actuals',
        response_model=ProjectAgentExecutorActualReport,
    )
    async def record_project_agent_executor_actual(
        request: ProjectAgentExecutorActualReport,
        actor: Actor,
    ) -> ProjectAgentExecutorActualReport:
        return await store.record_project_agent_executor_actual(actor, request)

    @application.post(
        '/v1/project-agent-routing-outcomes',
        response_model=ProjectAgentExecutorOutcomeEvidenceRecord,
    )
    async def record_project_agent_executor_outcome(
        request: ProjectAgentExecutorOutcomeEvidenceCreate,
        actor: Actor,
    ) -> ProjectAgentExecutorOutcomeEvidenceRecord:
        return await store.record_project_agent_executor_outcome_evidence(actor, request)

    @application.get(
        '/v1/project-agent-routing-learning',
        response_model=list[ProjectAgentExecutorOutcomeAggregate],
    )
    async def list_project_agent_executor_learning(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        agent_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        executor_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        work_kind: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
    ) -> list[ProjectAgentExecutorOutcomeAggregate]:
        return await store.list_project_agent_executor_outcome_aggregates(
            actor,
            personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_id=agent_id,
            executor_id=executor_id,
        )

    @application.post(
        '/v1/project-agent-routing-learning/ignore',
        response_model=ProjectAgentExecutorOutcomeEvidenceRecord,
    )
    async def ignore_project_agent_executor_learning(
        request: ProjectAgentExecutorEvidenceIgnore,
        actor: Actor,
    ) -> ProjectAgentExecutorOutcomeEvidenceRecord:
        return await store.ignore_project_agent_executor_outcome_evidence(actor, request)

    @application.post(
        '/v1/project-agent-routing-learning/reset',
        response_model=ProjectAgentExecutorOutcomeAggregate,
    )
    async def reset_project_agent_executor_learning(
        request: ProjectAgentExecutorOutcomeReset,
        actor: Actor,
    ) -> ProjectAgentExecutorOutcomeAggregate:
        return await store.reset_project_agent_executor_outcomes(actor, request)

    @application.post('/v1/project-agents/test-cleanup')
    async def cleanup_test_project_agents(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        test_source: Annotated[str, Query(min_length=1, max_length=256)],
    ) -> dict[str, int]:
        return {
            'archived_count': await store.archive_test_project_agents(
                actor,
                personal_space_id,
                test_source=test_source,
            )
        }
