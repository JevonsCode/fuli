"""Resolve a durable role for the already-running caller, without execution."""

from .personal_project_access import authorize_personal_project
from .project_agent_context_models import ProjectAgentContextResolution
from .project_agent_task_models import ProjectAgentTaskSubmit
from .task_context_temporary_owner import temporary_task_owner
from .project_agent_delegations import StoreAgentDelegations
from .project_agent_remote_origins import StoreRemoteAgentOrigins


class StoreProjectAgentContext(StoreAgentDelegations, StoreRemoteAgentOrigins):
    async def resolve_project_agent_context(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'reader')
        await authorize_personal_project(self, actor, space, request.personal_project_id)
        temporary_owner = await temporary_task_owner(self, actor, request) if not request.delegation_token else None
        if temporary_owner is not None:
            return temporary_owner
        policy = await self.get_project_agent_coordination_policy(
            actor, request.personal_space_id, request.personal_project_id,
        )
        project_lead = getattr(policy, 'team_lead_agent_id', None)
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
            lead_agent_id=request.agent_id or (project_lead if owner else None),
            source_application=request.source_application,
            routing_reason='Read-only task-entry context recovery',
        )
        if owner and not request.agent_id:
            owner_rows = await self._assignment_candidates(
                request.personal_space_id,
                request.personal_project_id,
            )
            owner_row = next(
                (row for row in owner_rows if row['agent_id'] == owner),
                None,
            )
            if owner_row and not self._implicit_owner_allowed(owner_row, selection):
                owner = None
                selection = selection.model_copy(update={'lead_agent_id': None})
        selected, candidates, reason, basis = await self._select_agents(actor, space, selection)
        if not selected and reason == 'no_match' and not request.required_capabilities:
            fallback_selection = selection.model_copy(update={'work_kind': 'project_context'})
            selected, candidates, reason, basis = await self._select_agents(
                actor, space, fallback_selection,
            )
            if selected and not self._implicit_owner_allowed(selected[0], fallback_selection):
                selected, reason, basis = [], 'no_match', [
                    'management or AR peer cannot own unrelated project context implicitly',
                ]
            if selected:
                reason = 'project_context_fallback'
                basis = [
                    f'no role matched requested work kind: {request.work_kind}; '
                    'using project_context for continuity only',
                    *basis,
                ]
        requested_agent_id = None
        reporting_lead_agent_id = None
        peer_request = bool(request.agent_id and selected and self._is_implicit_peer(selected[0]))
        delegated = bool(request.delegation_token)
        if delegated and (not selected or selected[0]['agent_id'] != request.agent_id):
            return ProjectAgentContextResolution(status='agent_unavailable', reason='delegation_invalid')
        if not peer_request:
            if not project_lead:
                if delegated:
                    return ProjectAgentContextResolution(status='agent_unavailable', reason='delegation_invalid')
                return ProjectAgentContextResolution(
                    status='unassigned', reason='project_lead_required',
                    requested_agent_id=request.agent_id,
                    match_basis=['Every project requires one accountable lead before work begins.'],
                )
            if selected and selected[0]['agent_id'] != project_lead:
                # Validate the named specialist first, then route accountability
                # through the lead. Never load the specialist's private memory here.
                rows = await self._assignment_candidates(request.personal_space_id, request.personal_project_id)
                lead = next((row for row in rows if row['agent_id'] == project_lead
                             and (delegated or self._agent_client_allowed(row, request.source_application))), None)
                if not lead:
                    return ProjectAgentContextResolution(status='agent_unavailable',
                        reason='team_lead_unavailable', match_basis=['The configured project lead is unavailable.'])
                if delegated:
                    # A real lead-to-member worker invocation keeps the member's
                    # isolated identity; its result returns to the project lead.
                    reporting_lead_agent_id = project_lead
                    reason = 'delegated_member'
                    basis = ['This member worker reports to the configured project lead.']
                else:
                    requested_agent_id = request.agent_id
                    selected = [lead]
                    reason = 'project_lead_reporting'
                    basis = ['The project lead owns the task; requested members report results to this lead.']
        if owner and selected and owner == selected[0]['agent_id']:
            reason, basis = 'active_task_owner', ['reuse the owner of this host session task']
        agent = await self.get_project_agent(
            actor, request.personal_space_id, request.personal_project_id,
            selected[0]['agent_id'],
        ) if selected else None
        # A reporting lead does not execute in the member's client. Acknowledge
        # the capability only after the executing role passes selection, so a
        # failed resolution cannot be accepted as that member's answer.
        if delegated and (not agent or not await self.redeem_agent_delegation(request, project_lead)):
            return ProjectAgentContextResolution(status='agent_unavailable', reason='delegation_invalid')
        return ProjectAgentContextResolution(
            status='ready' if agent else (
                'manual_selection' if reason == 'manual_agent_selection'
                else 'agent_unavailable' if reason == 'agent_unavailable' else 'unassigned'
            ),
            agent=agent, reason=reason, match_basis=basis, candidate_count=len(candidates),
            requested_agent_id=requested_agent_id,
            reporting_lead_agent_id=reporting_lead_agent_id,
        )
