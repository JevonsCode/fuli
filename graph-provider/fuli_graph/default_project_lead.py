"""Every task in a registered project gets a FULI Agent.

When a project has no team lead, Bole hires one through an ordinary staffing
task. The recruitment stays auditable and the new lead joins the project team.
"""

from fastapi import HTTPException
from pydantic import Field

from .model_base import StrictModel
from .models import SourceApplication
from .project_agent_context_models import ProjectAgentContextResolution
from .project_agent_models import ProjectAgentProfile
from .project_agent_task_models import ProjectAgentTaskActivityCreate, ProjectAgentTaskSubmit


class DefaultProjectLeadRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication = 'other'


def default_lead_profile(project_name):
    return ProjectAgentProfile(
        name=f'{project_name} 负责人'[:160],
        responsibility=f'负责 {project_name} 的开发、修复、测试与交付，并延续项目上下文。'[:4096],
        work_kinds=['implementation', 'project_context', 'code_review', 'test_validation', 'architecture'],
        capabilities=['代码实现', '问题修复', '测试验证', '代码审查', '项目上下文'],
        initial_preferences=['先理解现有实现与约定，再修改。', '结论附带可复现的验证证据。'],
    )


class StoreDefaultProjectLead:
    async def staff_default_project_lead(self, actor, request: DefaultProjectLeadRequest):
        self._require_personal()
        project = await self.get_personal_project(
            actor, request.personal_space_id, request.personal_project_id,
        )
        policy = await self.get_project_agent_coordination_policy(
            actor, request.personal_space_id, request.personal_project_id,
        )
        if policy.team_lead_agent_id:
            # An existing lead that could not take this task is a user decision.
            return ProjectAgentContextResolution(status='unassigned', reason='team_lead_unavailable')
        submit = ProjectAgentTaskSubmit(
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            idempotency_key=f'default-lead:{request.personal_project_id}:{policy.updated_at or "initial"}',
            title='接任项目负责人',
            objective='为项目配置默认负责人，承接后续任务并延续项目上下文。',
            work_kind='project_context',
            duration='one_off',
            staffing_intent='default_lead',
            source_application=request.source_application,
            routing_reason='Every task needs a FULI Agent; this project had no team lead.',
            recruitment_profile=default_lead_profile(project.profile.name),
        )
        routed = await self.submit_project_agent_task(actor, submit)
        lead = routed.assigned_agent
        if not lead:
            return ProjectAgentContextResolution(
                status='unassigned', reason=routed.task.routing_reason or 'staffing_unavailable',
            )
        task = routed.task
        for status, summary in (('running', '接任项目负责人'), ('completed', f'{lead.profile.name} 已接任项目负责人')):
            if task.status in {'completed', 'cancelled', 'failed'}:
                break
            try:
                task = await self.record_project_agent_task_activity(actor, ProjectAgentTaskActivityCreate(
                    personal_space_id=request.personal_space_id,
                    personal_project_id=request.personal_project_id,
                    task_id=task.task_id,
                    idempotency_key=f'{submit.idempotency_key}:{status}',
                    status=status,
                    summary=summary,
                    agent_id=lead.agent_id,
                    source_application=request.source_application,
                ))
            except HTTPException as error:
                # The hire already succeeded; a closed staffing record is cosmetic.
                if error.status_code != 409:
                    raise
                break
        return ProjectAgentContextResolution(
            status='ready', reason='default_project_lead',
            match_basis=['HR hired the project lead for its first task'],
            candidate_count=1, agent=lead,
        )
