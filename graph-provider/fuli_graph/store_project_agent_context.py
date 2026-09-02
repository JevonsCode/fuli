"""Resolve a durable role for the already-running caller, without execution."""

from .personal_project_access import authorize_personal_project
from .project_agent_context_models import ProjectAgentContextResolution
from .project_agent_task_models import ProjectAgentTaskSubmit


class StoreProjectAgentContext:
    async def resolve_project_agent_context(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'reader')
        await authorize_personal_project(self, actor, space, request.personal_project_id)
        owner = None
        if request.session_id and not request.agent_id:
            rows, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (session:FuliTaskContextSession {id: $session_id})-[:HAS_CONTEXT]->
                      (context:FuliTaskContext {personal_space_id: $space_id,
                        personal_project_id: $project_id, completed: false})
                WHERE session.current_token = context.token
                  AND ($turn_id IS NULL OR context.turn_id = $turn_id)
                RETURN context.project_agent_id AS agent_id
                ''', session_id=self._task_session_id(request.personal_space_id,
                    request.source_application, request.session_id),
                space_id=request.personal_space_id, project_id=request.personal_project_id,
                turn_id=request.turn_id,
                routing_='r',
            )
            owner = rows[0]['agent_id'] if rows else None
        # Reuse the task router's staffing policy. These fixed values and the
        # request are not persisted; raw user prompts never enter this API.
        selection = ProjectAgentTaskSubmit(
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            idempotency_key='read-only-task-context',
            title='Resolve task context', objective='Select one existing durable role.',
            work_kind=request.work_kind, required_capabilities=request.required_capabilities,
            lead_agent_id=request.agent_id or owner, source_application=request.source_application,
            routing_reason='Read-only task-entry context recovery',
        )
        selected, candidates, reason, basis = await self._select_agents(actor, space, selection)
        if not selected and reason == 'no_match' and not request.required_capabilities:
            selected, candidates, reason, basis = await self._select_agents(
                actor, space, selection.model_copy(update={'work_kind': 'project_context'}),
            )
            if selected:
                reason = 'project_context_fallback'
                basis = [
                    f'no role matched requested work kind: {request.work_kind}; '
                    'using project_context for continuity only',
                    *basis,
                ]
        if owner and selected:
            reason, basis = 'active_task_owner', ['reuse the owner of this host session task']
        agent = await self.get_project_agent(
            actor, request.personal_space_id, request.personal_project_id,
            selected[0]['agent_id'],
        ) if selected else None
        return ProjectAgentContextResolution(
            status='ready' if agent else (
                'manual_selection' if reason == 'manual_agent_selection'
                else 'agent_unavailable' if reason == 'agent_unavailable' else 'unassigned'
            ),
            agent=agent, reason=reason, match_basis=basis, candidate_count=len(candidates),
        )
